const logger = require('../utils/logger');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const reportService = require('../services/reportService');

class MonthlyReportJob {
  constructor() {
    this.cronSchedule = '0 0 1 * *'; // Run at 00:00 on the 1st day of every month
  }

  start() {
    logger.info('Initializing Monthly Report Job...');
    cron.schedule(this.cronSchedule, async () => {
      logger.info('Running Monthly Report Job...');
      try {
        await this.generateAndSendReport();
      } catch (error) {
        logger.error('Error running Monthly Report Job:', error);
      }
    });
  }

  async generateAndSendReport() {
    const pdfBuffer = await reportService.generateMonthlyClaimsPDF();
    
    // Configure transporter
    const transporter = nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    const previousMonth = new Date();
    previousMonth.setMonth(previousMonth.getMonth() - 1);
    const monthName = previousMonth.toLocaleString('default', { month: 'long', year: 'numeric' });

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.DAO_ADMIN_EMAIL,
      subject: `Monthly Claims Report - ${monthName}`,
      text: `Please find attached the monthly claims report for ${monthName}.`,
      attachments: [
        {
          filename: `claims-report-${monthName.replace(' ', '-')}.pdf`,
          content: pdfBuffer
        }
      ]
    };

    await transporter.sendMail(mailOptions);
    logger.info(`Monthly report sent to ${process.env.DAO_ADMIN_EMAIL}`);
  }
}

module.exports = new MonthlyReportJob();
