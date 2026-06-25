/**
 * Database Circuit Breaker for Mass Unlock Events
 * 
 * This specialized circuit breaker monitors database write-load during mass unlock events
 * and provides intelligent throttling to prevent database overload.
 */

class DatabaseCircuitBreaker {
  constructor(options = {}) {
    // Basic circuit breaker settings
    this.failureThreshold = options.failureThreshold || 10;
    this.resetTimeout = options.resetTimeout || 120000; // 2 minutes
    this.monitoringPeriod = options.monitoringPeriod || 30000; // 30 seconds
    
    // Database-specific settings
    this.maxConcurrentWrites = options.maxConcurrentWrites || 50;
    this.writeTimeoutThreshold = options.writeTimeoutThreshold || 5000; // 5 seconds
    this.batchSize = options.batchSize || 10;
    this.batchTimeout = options.batchTimeout || 1000; // 1 second
    
    // Mass unlock detection
    this.massUnlockThreshold = options.massUnlockThreshold || 100; // events per minute
    this.massUnlockWindow = options.massUnlockWindow || 60000; // 1 minute
    
    // Circuit breaker state
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN, THROTTLING
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.successCount = 0;
    
    // Database load monitoring
    this.activeWrites = 0;
    this.writeTimes = [];
    this.recentEvents = [];
    this.lastCleanup = Date.now();
    
    // Throttling state
    this.throttlingLevel = 0; // 0-100, percentage of throttling
    this.lastThrottlingAdjustment = Date.now();
    
    // Callbacks for monitoring
    this.onStateChange = options.onStateChange || null;
    this.onMassUnlockDetected = options.onMassUnlockDetected || null;
    this.onThrottlingAdjustment = options.onThrottlingAdjustment || null;
    
    // Statistics
    this.stats = {
      totalWrites: 0,
      successfulWrites: 0,
      failedWrites: 0,
      throttledWrites: 0,
      massUnlockEvents: 0,
      averageWriteTime: 0,
      peakConcurrentWrites: 0
    };
  }

  /**
   * Execute a database write operation through the circuit breaker
   */
  async executeWrite(writeOperation, context = {}) {
    // Cleanup old data periodically
    this.cleanupOldData();
    
    // Check circuit breaker state
    if (this.state === 'OPEN') {
      if (this.shouldAttemptReset()) {
        this.state = 'HALF_OPEN';
        this.successCount = 0;
        this.logStateChange('OPEN', 'HALF_OPEN', 'Attempting reset');
      } else {
        this.stats.throttledWrites++;
        throw new Error(`Database circuit breaker is OPEN for ${context.operation || 'database write'}`);
      }
    }

    // Check if we need to throttle
    if (this.shouldThrottle()) {
      this.stats.throttledWrites++;
      await this.throttle();
    }

    // Check concurrent write limit
    if (this.activeWrites >= this.maxConcurrentWrites) {
      this.stats.throttledWrites++;
      throw new Error(`Maximum concurrent writes (${this.maxConcurrentWrites}) exceeded`);
    }

    // Detect mass unlock events
    this.detectMassUnlock();

    const startTime = Date.now();
    this.activeWrites++;
    this.stats.totalWrites++;

    try {
      const result = await Promise.race([
        writeOperation(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Database write timeout')), this.writeTimeoutThreshold)
        )
      ]);
      
      const writeTime = Date.now() - startTime;
      this.recordSuccessfulWrite(writeTime);
      
      return result;
    } catch (error) {
      const writeTime = Date.now() - startTime;
      this.recordFailedWrite(error, writeTime);
      throw error;
    } finally {
      this.activeWrites--;
      this.writeTimes.push(Date.now() - startTime);
      
      // Keep only recent write times for statistics
      if (this.writeTimes.length > 100) {
        this.writeTimes = this.writeTimes.slice(-100);
      }
    }
  }

  /**
   * Execute multiple database writes in a batch with circuit breaker protection
   */
  async executeBatchWrite(writeOperations, context = {}) {
    if (!Array.isArray(writeOperations) || writeOperations.length === 0) {
      return [];
    }

    const results = [];
    const batchSize = Math.min(this.batchSize, writeOperations.length);
    
    // Process in batches to prevent overwhelming the database
    for (let i = 0; i < writeOperations.length; i += batchSize) {
      const batch = writeOperations.slice(i, i + batchSize);
      
      try {
        const batchPromises = batch.map((operation, index) => 
          this.executeWrite(operation, { ...context, batchIndex: i + index })
            .catch(error => ({ error, index: i + index }))
        );
        
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
        
        // Brief pause between batches during high load
        if (this.state === 'THROTTLING' || this.throttlingLevel > 50) {
          await this.sleep(this.batchTimeout);
        }
      } catch (error) {
        // If entire batch fails, record error for all operations in batch
        for (let j = 0; j < batch.length; j++) {
          results.push({ error, index: i + j });
        }
      }
    }
    
    return results;
  }

  /**
   * Record a successful write operation
   */
  recordSuccessfulWrite(writeTime) {
    this.successCount++;
    this.stats.successfulWrites++;
    
    if (this.state === 'HALF_OPEN' && this.successCount >= 3) {
      this.state = 'CLOSED';
      this.failureCount = 0;
      this.throttlingLevel = 0;
      this.logStateChange('HALF_OPEN', 'CLOSED', 'Circuit breaker reset successfully');
    }
    
    // Update average write time
    if (this.writeTimes.length > 0) {
      this.stats.averageWriteTime = this.writeTimes.reduce((a, b) => a + b, 0) / this.writeTimes.length;
    }
  }

  /**
   * Record a failed write operation
   */
  recordFailedWrite(error, writeTime) {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    this.stats.failedWrites++;
    
    // Log error details
    console.error('Database write failed through circuit breaker', {
      error: error.message,
      writeTime,
      activeWrites: this.activeWrites,
      state: this.state,
      throttlingLevel: this.throttlingLevel
    });
    
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      this.logStateChange(this.state === 'OPEN' ? 'OPEN' : 'CLOSED', 'OPEN', 
        `Failure threshold reached: ${this.failureCount} failures`);
    }
  }

  /**
   * Detect mass unlock events based on recent event frequency
   */
  detectMassUnlock() {
    const now = Date.now();
    const windowStart = now - this.massUnlockWindow;
    
    // Count events in the recent window
    const recentEventCount = this.recentEvents.filter(timestamp => timestamp > windowStart).length;
    
    if (recentEventCount >= this.massUnlockThreshold) {
      if (this.state !== 'THROTTLING') {
        this.state = 'THROTTLING';
        this.throttlingLevel = 75; // Start with high throttling
        this.stats.massUnlockEvents++;
        this.logStateChange(this.state === 'THROTTLING' ? 'THROTTLING' : 'CLOSED', 'THROTTLING', 
          `Mass unlock detected: ${recentEventCount} events in ${this.massUnlockWindow/1000}s`);
        
        if (this.onMassUnlockDetected) {
          this.onMassUnlockDetected({
            eventCount: recentEventCount,
            window: this.massUnlockWindow,
            timestamp: now
          });
        }
      }
    }
    
    // Add current event to recent events
    this.recentEvents.push(now);
    
    // Keep only events within the window
    this.recentEvents = this.recentEvents.filter(timestamp => timestamp > windowStart);
  }

  /**
   * Determine if throttling should be applied
   */
  shouldThrottle() {
    if (this.state !== 'THROTTLING') {
      return false;
    }
    
    // Adjust throttling level based on current load
    this.adjustThrottlingLevel();
    
    // Apply probabilistic throttling based on level
    return Math.random() * 100 < this.throttlingLevel;
  }

  /**
   * Adjust throttling level based on current database performance
   */
  adjustThrottlingLevel() {
    const now = Date.now();
    const timeSinceAdjustment = now - this.lastThrottlingAdjustment;
    
    // Only adjust every 10 seconds
    if (timeSinceAdjustment < 10000) {
      return;
    }
    
    const oldLevel = this.throttlingLevel;
    
    // Calculate current load metrics
    const avgWriteTime = this.stats.averageWriteTime;
    const currentActiveWrites = this.activeWrites;
    const recentFailureRate = this.getRecentFailureRate();
    
    // Adjust throttling based on performance
    if (avgWriteTime > this.writeTimeoutThreshold * 0.8 || recentFailureRate > 0.1) {
      // Increase throttling if performance is poor
      this.throttlingLevel = Math.min(100, this.throttlingLevel + 10);
    } else if (avgWriteTime < this.writeTimeoutThreshold * 0.5 && recentFailureRate < 0.05) {
      // Decrease throttling if performance is good
      this.throttlingLevel = Math.max(0, this.throttlingLevel - 5);
    }
    
    // Exit throttling mode if level is low and mass unlock is over
    if (this.throttlingLevel < 20 && this.recentEvents.length < this.massUnlockThreshold / 2) {
      this.state = 'CLOSED';
      this.throttlingLevel = 0;
      this.logStateChange('THROTTLING', 'CLOSED', 'Load normalized, exiting throttling mode');
    }
    
    this.lastThrottlingAdjustment = now;
    
    if (oldLevel !== this.throttlingLevel && this.onThrottlingAdjustment) {
      this.onThrottlingAdjustment({
        oldLevel,
        newLevel: this.throttlingLevel,
        avgWriteTime,
        failureRate: recentFailureRate
      });
    }
  }

  /**
   * Get recent failure rate
   */
  getRecentFailureRate() {
    const totalRecentWrites = this.stats.successfulWrites + this.stats.failedWrites;
    if (totalRecentWrites === 0) return 0;
    return this.stats.failedWrites / totalRecentWrites;
  }

  /**
   * Throttle execution by delaying
   */
  async throttle() {
    const delay = Math.random() * 1000 * (this.throttlingLevel / 100); // Up to 1 second delay
    await this.sleep(delay);
  }

  /**
   * Check if circuit breaker should attempt reset
   */
  shouldAttemptReset() {
    return Date.now() - this.lastFailureTime >= this.resetTimeout;
  }

  /**
   * Clean up old data to prevent memory leaks
   */
  cleanupOldData() {
    const now = Date.now();
    if (now - this.lastCleanup < 60000) { // Cleanup every minute
      return;
    }
    
    // Clean old events
    const windowStart = now - this.massUnlockWindow;
    this.recentEvents = this.recentEvents.filter(timestamp => timestamp > windowStart);
    
    // Clean old write times
    if (this.writeTimes.length > 100) {
      this.writeTimes = this.writeTimes.slice(-100);
    }
    
    this.lastCleanup = now;
  }

  /**
   * Log state changes
   */
  logStateChange(fromState, toState, reason) {
    console.log(`Database Circuit Breaker: ${fromState} -> ${toState} (${reason})`);

    // Record span event for OpenTelemetry tracing
    try {
      const TracingUtils = require('../../backend/src/tracing/tracingUtils');
      TracingUtils.recordCircuitBreakerTransition(fromState, toState, reason, {
        'circuit_breaker.failure_count': this.failureCount,
        'circuit_breaker.throttling_level': this.throttlingLevel,
        'circuit_breaker.active_writes': this.activeWrites,
      });
    } catch (err) {
      // Tracing module may not be initialized yet — degrade gracefully
    }

    if (this.onStateChange) {
      this.onStateChange({
        fromState,
        toState,
        reason,
        timestamp: Date.now(),
        stats: this.getStats()
      });
    }
  }

  /**
   * Get current circuit breaker state and statistics
   */
  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
      successCount: this.successCount,
      throttlingLevel: this.throttlingLevel,
      activeWrites: this.activeWrites,
      recentEventCount: this.recentEvents.length,
      stats: this.getStats()
    };
  }

  /**
   * Get detailed statistics
   */
  getStats() {
    return {
      ...this.stats,
      currentState: this.state,
      throttlingLevel: this.throttlingLevel,
      activeWrites: this.activeWrites,
      recentEventCount: this.recentEvents.length,
      averageWriteTime: this.stats.averageWriteTime,
      failureRate: this.getRecentFailureRate(),
      peakConcurrentWrites: Math.max(this.stats.peakConcurrentWrites, this.activeWrites)
    };
  }

  /**
   * Reset circuit breaker to initial state
   */
  reset() {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.successCount = 0;
    this.throttlingLevel = 0;
    this.activeWrites = 0;
    this.recentEvents = [];
    this.writeTimes = [];
    
    console.log('Database Circuit Breaker: Reset to initial state');
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { DatabaseCircuitBreaker };
