const fs = require('fs');
const path = require('path');

class AuditLogger {
  constructor() {
    this.logFilePath = path.join(__dirname, '../../logs/audit.log');
    // Dedicated channel for slow database queries (issue #8).
    this.slowQueryLogPath = path.join(__dirname, '../../logs/slow_queries.log');
    // Dedicated channel for WebSocket connection events (issue #6).
    this.websocketLogPath = path.join(__dirname, '../../logs/websocket_audit.log');
    this.ensureLogDirectory();
  }

  /**
   * Append a WebSocket connection event to the dedicated websocket audit channel.
   * @param {{event:string, socketId?:string, ip?:string, address?:string, reason?:string, timestamp?:string}} entry
   */
  logWebsocketEvent(entry) {
    const timestamp = entry.timestamp || new Date().toISOString();
    const parts = [
      `[${timestamp}]`,
      `[${entry.event}]`,
      `[ip:${entry.ip || 'unknown'}]`,
      `[user:${entry.address || 'anonymous'}]`,
      `[socket:${entry.socketId || '-'}]`,
    ];
    if (entry.reason) parts.push(`[reason:${entry.reason}]`);
    const logEntry = parts.join(' ') + '\n';

    try {
      fs.appendFileSync(this.websocketLogPath, logEntry);
    } catch (error) {
      console.error('Failed to write to websocket audit log:', error);
    }
  }

  getWebsocketEntries() {
    try {
      if (!fs.existsSync(this.websocketLogPath)) {
        return [];
      }
      return fs
        .readFileSync(this.websocketLogPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .reverse();
    } catch (error) {
      console.error('Failed to read websocket audit log:', error);
      return [];
    }
  }

  ensureLogDirectory() {
    const logDir = path.dirname(this.logFilePath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  logAction(adminAddress, action, targetVault) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${adminAddress}] [${action}] [${targetVault}]\n`;
    
    try {
      fs.appendFileSync(this.logFilePath, logEntry);
      console.log(`Audit log: ${logEntry.trim()}`);
    } catch (error) {
      console.error('Failed to write to audit log:', error);
    }
  }

  /**
   * Append a slow query to the dedicated slow_queries channel.
   * @param {{operation:string, durationMs:number, sql:string, timestamp?:string}} entry
   */
  logSlowQuery(entry) {
    const timestamp = entry.timestamp || new Date().toISOString();
    const logEntry = `[${timestamp}] [${entry.durationMs}ms] [${entry.operation}] ${entry.sql}\n`;

    try {
      fs.appendFileSync(this.slowQueryLogPath, logEntry);
      console.warn(`Slow query (${entry.durationMs}ms) [${entry.operation}]`);
    } catch (error) {
      console.error('Failed to write to slow query log:', error);
    }
  }

  getSlowQueryEntries() {
    try {
      if (!fs.existsSync(this.slowQueryLogPath)) {
        return [];
      }
      const content = fs.readFileSync(this.slowQueryLogPath, 'utf8');
      return content
        .split('\n')
        .filter((line) => line.trim() !== '')
        .reverse();
    } catch (error) {
      console.error('Failed to read slow query log:', error);
      return [];
    }
  }

  getLogEntries() {
    try {
      if (!fs.existsSync(this.logFilePath)) {
        return [];
      }
      
      const logContent = fs.readFileSync(this.logFilePath, 'utf8');
      return logContent
        .split('\n')
        .filter(line => line.trim() !== '')
        .reverse(); // Most recent first
    } catch (error) {
      console.error('Failed to read audit log:', error);
      return [];
    }
  }
}

module.exports = new AuditLogger();
