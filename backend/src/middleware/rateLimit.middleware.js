const logger = require('../utils/logger');
const { rateLimit } = require('express-rate-limit');

// Use a Redis-backed store only when Redis is configured AND we're not running
// the test/CI suite. A RedisStore pointed at an unavailable Redis makes every
// request (including /health) hang, so single-instance / test / CI runs fall
// back to express-rate-limit's default in-memory store.
let globalStore;
let authStore;
const useRedis = process.env.NODE_ENV !== 'test' && !!process.env.REDIS_URL;

// Disable throttling for automated test/E2E runs. The Jest and Playwright
// suites legitimately make many auth calls in quick succession (login, refresh,
// retries), which would otherwise trip the strict 5/min auth limiter and make
// the tests flaky. Production and all other environments are unaffected.
const skipInTest = () => process.env.NODE_ENV === 'test';

if (useRedis) {
  try {
    const { RedisStore } = require('rate-limit-redis');
    const IORedis = require('ioredis');
    const client = new IORedis(process.env.REDIS_URL, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    client.on('error', (err) => logger.error('Rate-limit Redis error:', err.message));
    globalStore = new RedisStore({ sendCommand: (...args) => client.call(...args), prefix: 'rl:global:' });
    authStore = new RedisStore({ sendCommand: (...args) => client.call(...args), prefix: 'rl:auth:' });
  } catch (err) {
    logger.warn('Rate-limit Redis store unavailable, using in-memory store:', err.message);
    globalStore = undefined;
    authStore = undefined;
  }
}

// Global rate limiter (100 requests/min)
const globalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  ...(globalStore ? { store: globalStore } : {}),
  message: {
    success: false,
    error: 'Too many requests, please try again later.',
  },
});

// Stricter rate limiter for auth endpoints (5 requests/min)
const authRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  ...(authStore ? { store: authStore } : {}),
  message: {
    success: false,
    error: 'Too many authentication attempts, please try again after a minute.',
  },
});

module.exports = {
  globalRateLimiter,
  authRateLimiter,
};
