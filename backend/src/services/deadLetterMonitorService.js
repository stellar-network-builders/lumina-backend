const logger = require('../utils/logger');
const axios = require('axios');

let emailService;
try {
  // Lazily required so unit tests / environments without mail config still load.
  emailService = require('./emailService');
} catch (err) {
  emailService = null;
}

/**
 * DeadLetterMonitorService
 *
 * Periodically inspects every dead-letter queue owned by a QueueService and,
 * when any DLQ contains jobs, raises an alert via SendGrid/SMTP email and/or a
 * generic webhook (Slack-compatible payload). This closes the "failed jobs are
 * silently lost" gap by making DLQ build-up observable and actionable.
 */
class DeadLetterMonitorService {
  /**
   * @param {QueueService} queueService - the QueueService whose DLQs to watch
   * @param {Object} options
   * @param {number} [options.intervalMs] - poll interval (default 5 min)
   * @param {string} [options.alertEmail] - recipient for email alerts
   * @param {string} [options.webhookUrl] - webhook for alerts (Slack/Discord/etc.)
   */
  constructor(queueService, options = {}) {
    this.queueService = queueService;
    this.intervalMs =
      options.intervalMs || parseInt(process.env.DLQ_ALERT_INTERVAL_MS || '300000', 10);
    this.alertEmail = options.alertEmail || process.env.DLQ_ALERT_EMAIL || '';
    this.webhookUrl =
      options.webhookUrl ||
      process.env.DLQ_ALERT_WEBHOOK_URL ||
      process.env.SLACK_WEBHOOK_URL ||
      '';
    this.timer = null;
    this.isRunning = false;
    this.lastAlertAt = null;
  }

  /**
   * Begin periodic monitoring. Safe to call once; subsequent calls are no-ops.
   */
  start() {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    // Unref so the timer never keeps the process alive on its own.
    this.timer = setInterval(() => {
      this.checkAndAlert().catch((err) =>
        logger.error('DLQ monitor check failed:', err.message)
      );
    }, this.intervalMs);
    if (this.timer.unref) {
      this.timer.unref();
    }
    logger.info(`Dead-letter queue monitor started (every ${this.intervalMs}ms)`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
  }

  /**
   * Inspect all DLQs and alert on any that are non-empty.
   * @returns {Promise<{alerted: boolean, offenders: Array}>}
   */
  async checkAndAlert() {
    const counts = await this.queueService.getAllDeadLetterCounts();
    const offenders = counts.filter((entry) => entry.total > 0);

    if (offenders.length === 0) {
      return { alerted: false, offenders: [] };
    }

    await this.sendAlert(offenders);
    this.lastAlertAt = new Date().toISOString();
    return { alerted: true, offenders };
  }

  /**
   * Dispatch the alert to every configured channel. Channel failures are
   * swallowed so one broken transport never blocks the others.
   */
  async sendAlert(offenders) {
    const summary = offenders
      .map((o) => `• ${o.queueName}: ${o.total} job(s)`)
      .join('\n');
    const subject = `[ALERT] ${offenders.length} dead-letter queue(s) have failed jobs`;
    const text = `The following dead-letter queues contain permanently failed background jobs that require attention:\n\n${summary}\n\nInspect them via GET /admin/queues/status.`;

    const deliveries = [];

    if (this.webhookUrl) {
      deliveries.push(this.postWebhook(subject, text, offenders));
    }

    if (this.alertEmail && emailService && typeof emailService.sendEmail === 'function') {
      const html = `<p>${text.replace(/\n/g, '<br/>')}</p>`;
      deliveries.push(
        emailService
          .sendEmail(this.alertEmail, subject, text, html)
          .catch((err) => logger.error('DLQ email alert failed:', err.message))
      );
    }

    if (deliveries.length === 0) {
      logger.warn(
        'DLQ alert raised but no channel configured. Set DLQ_ALERT_WEBHOOK_URL and/or DLQ_ALERT_EMAIL.'
      );
      logger.warn(text);
      return { sent: false };
    }

    await Promise.allSettled(deliveries);
    return { sent: true };
  }

  async postWebhook(subject, text, offenders) {
    try {
      await axios.post(
        this.webhookUrl,
        {
          text: `🚨 ${subject}`,
          blocks: [
            {
              type: 'header',
              text: { type: 'plain_text', text: '🚨 Dead-Letter Queue Alert', emoji: true },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: offenders.map((o) => `*${o.queueName}*: ${o.total} failed job(s)`).join('\n'),
              },
            },
          ],
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 5000 }
      );
      return { channel: 'webhook' };
    } catch (err) {
      logger.error('DLQ webhook alert failed:', err.message);
      return { channel: 'webhook', error: err.message };
    }
  }
}

module.exports = DeadLetterMonitorService;
