const mockRedisStore = new Map();

// Mock Redis client early to simulate caching behavior
jest.mock('redis', () => {
  const callbacks = {};
  return {
    createClient: jest.fn(() => ({
      on: jest.fn((event, callback) => {
        callbacks[event] = callback;
      }),
      connect: jest.fn(async () => {
        if (callbacks['connect']) {
          callbacks['connect']();
        }
        if (callbacks['ready']) {
          callbacks['ready']();
        }
      }),
      isOpen: true,
      get: jest.fn(async (key) => {
        const entry = mockRedisStore.get(key);
        if (!entry) return null;
        if (entry.expiry && Date.now() > entry.expiry) {
          mockRedisStore.delete(key);
          return null;
        }
        return entry.value;
      }),
      set: jest.fn(async (key, value, options = {}) => {
        if (options.NX && mockRedisStore.has(key)) {
          const entry = mockRedisStore.get(key);
          if (!entry.expiry || Date.now() <= entry.expiry) {
            return null; // Lock already held
          }
        }
        let expiry = null;
        if (options.EX) {
          expiry = Date.now() + options.EX * 1000;
        } else if (options.PX) {
          expiry = Date.now() + options.PX;
        }
        mockRedisStore.set(key, { value, expiry });
        return 'OK';
      }),
      setEx: jest.fn(async (key, ttl, value) => {
        mockRedisStore.set(key, { value, expiry: Date.now() + ttl * 1000 });
        return 'OK';
      }),
      del: jest.fn(async (keys) => {
        const keyList = Array.isArray(keys) ? keys : [keys];
        let deleted = 0;
        for (const key of keyList) {
          if (mockRedisStore.delete(key)) {
            deleted++;
          }
        }
        return deleted;
      }),
      scan: jest.fn(async (cursor, options = {}) => {
        const pattern = options.MATCH || '*';
        const allKeys = Array.from(mockRedisStore.keys());
        const regexPattern = pattern.replace(/\*/g, '.*');
        const regex = new RegExp(`^${regexPattern}$`);
        const matched = allKeys.filter(k => regex.test(k));
        return { cursor: 0, keys: matched };
      }),
      keys: jest.fn(async (pattern = '*') => {
        const allKeys = Array.from(mockRedisStore.keys());
        const regexPattern = pattern.replace(/\*/g, '.*');
        const regex = new RegExp(`^${regexPattern}$`);
        return allKeys.filter(k => regex.test(k));
      }),
      quit: jest.fn().mockResolvedValue(),
    })),
  };
});

const cacheService = require('../src/services/cacheService');

describe('CacheService Caching Integration', () => {
  beforeEach(async () => {
    mockRedisStore.clear();
    if (!cacheService.client) {
      await cacheService.connect();
    }
    // Explicitly set isConnected to true for safety
    cacheService.isConnected = true;
  });

  test('should return fresh data on first miss and populate cache', async () => {
    const key = 'vesting:vault:vault-123';
    const mockData = { id: 'vault-123', balance: '1000' };
    const fetchFn = jest.fn().mockResolvedValue(mockData);

    const result = await cacheService.getOrSet(key, 300, fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual(mockData);

    // Verify cache has the data
    const cachedVal = await cacheService.get(key);
    expect(cachedVal).toEqual(mockData);
  });

  test('should return stale data within TTL without calling fetchFn', async () => {
    const key = 'vesting:vault:vault-123';
    const mockData = { id: 'vault-123', balance: '1000' };
    const fetchFn = jest.fn().mockResolvedValue(mockData);

    // Seed the cache
    await cacheService.set(key, mockData, 300);

    const result = await cacheService.getOrSet(key, 300, fetchFn);

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result).toEqual(mockData);
  });

  test('should invalidate cache after write operations', async () => {
    const key = 'vesting:vault:vault-123';
    const mockData = { id: 'vault-123', balance: '1000' };

    // Set cache
    await cacheService.set(key, mockData, 300);
    expect(await cacheService.get(key)).toBeDefined();

    // Invalidate
    await cacheService.invalidatePattern('vesting:vault:vault-123');

    // Verify data is deleted
    const cachedVal = await cacheService.get(key);
    expect(cachedVal).toBeNull();
  });

  test('should handle thundering herd protection under concurrent load', async () => {
    const key = 'vesting:vault:concurrency-test';
    const mockData = { data: 'hello' };
    
    let fetchCallCount = 0;
    const fetchFn = jest.fn(async () => {
      fetchCallCount++;
      // Simulate slight database lag
      await new Promise(resolve => setTimeout(resolve, 50));
      return mockData;
    });

    // Fire 5 concurrent requests
    const results = await Promise.all([
      cacheService.getOrSet(key, 300, fetchFn),
      cacheService.getOrSet(key, 300, fetchFn),
      cacheService.getOrSet(key, 300, fetchFn),
      cacheService.getOrSet(key, 300, fetchFn),
      cacheService.getOrSet(key, 300, fetchFn),
    ]);

    // All requests should get the same data
    results.forEach(res => {
      expect(res).toEqual(mockData);
    });

    // fetchFn should only be called once due to thundering herd lock
    expect(fetchCallCount).toBe(1);
  });
});
