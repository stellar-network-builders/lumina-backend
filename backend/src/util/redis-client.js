// Mock Redis implementation for testing when Redis is not available
class MockRedis {
  constructor() {
    this.data = new Map();
  }

  async zRemRangeByScore(key, min, max) {
    const set = this.data.get(key) || [];
    const filtered = set.filter(item => item.score < min || item.score > max);
    this.data.set(key, filtered);
    return set.length - filtered.length;
  }

  async zCard(key) {
    const set = this.data.get(key) || [];
    return set.length;
  }

  async zRange(key, start, stop) {
    const set = this.data.get(key) || [];
    const sorted = set.sort((a, b) => a.score - b.score);
    return sorted.slice(start, stop + 1).map(item => item.value);
  }

  async zAdd(key, items) {
    const set = this.data.get(key) || [];
    if (Array.isArray(items)) {
      items.forEach(item => set.push(item));
    } else {
      set.push(items);
    }
    this.data.set(key, set);
    return 1;
  }

  async expire(key, seconds) {
    // Mock implementation - in real Redis this would set TTL
    return 1;
  }

  async del(key) {
    const existed = this.data.has(key);
    this.data.delete(key);
    return existed ? 1 : 0;
  }

  async connect() {
    logger.info('Mock Redis connected');
  }

  on(event, callback) {
    if (event === 'error') {
      // Mock error handling
    } else if (event === 'connect') {
      setTimeout(callback, 100);
    }
  }
}

// Try to use real Redis, fall back to mock
let createClient;
try {
  createClient = require('redis').createClient;
} catch (error) {
  logger.info('Redis not available, using mock implementation for testing');
  createClient = () => new MockRedis();
}

module.exports = { createClient, MockRedis };
