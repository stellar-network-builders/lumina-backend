const logger = require('../utils/logger');
const { claimEventEmitter } = require('./indexingService');
const claimWebhookDispatcherService = require('./claimWebhookDispatcherService');

class ClaimWebhookListenerService {
  constructor(dispatcher = claimWebhookDispatcherService) {
    this.dispatcher = dispatcher;
    this.started = false;
    this.boundHandler = this.handleTokensClaimed.bind(this);
  }

  start() {
    if (this.started) {
      logger.info('Claim webhook listener already started');
      return;
    }

    this.dispatcher.start();
    claimEventEmitter.on('tokensClaimed', this.boundHandler);
    this.started = true;
    logger.info('Claim webhook listener started');
  }

  stop() {
    if (!this.started) {
      return;
    }

    claimEventEmitter.off('tokensClaimed', this.boundHandler);
    this.dispatcher.stop();
    this.started = false;
  }

  async handleTokensClaimed(claimEvent) {
    try {
      await this.dispatcher.enqueueTokensClaimedEvent(claimEvent);
    } catch (error) {
      logger.error('Failed to queue claim webhook event:', error);
    }
  }
}

module.exports = new ClaimWebhookListenerService();
module.exports.ClaimWebhookListenerService = ClaimWebhookListenerService;
