/**
 * In-Memory Cache Store
 * Simple key-value cache with TTL support
 * TTL values are in minutes from .env configuration
 */

class CacheStore {
  constructor() {
    this.store = new Map();
    this.timers = new Map();
  }

  /**
   * Set a value in cache with optional TTL
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {number} ttlMinutes - Time-to-live in minutes (default: 5)
   */
  set(key, value, ttlMinutes = 5) {
    // Clear existing timer if any
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
    }

    this.store.set(key, value);

    // Set expiration timer
    const timer = setTimeout(() => {
      this.store.delete(key);
      this.timers.delete(key);
    }, ttlMinutes * 60 * 1000);

    this.timers.set(key, timer);
  }

  /**
   * Get a value from cache
   * @param {string} key - Cache key
   * @returns {any|null} Cached value or null if not found/expired
   */
  get(key) {
    const value = this.store.get(key);
    if (value) {
      return value;
    }
    return null;
  }

  /**
   * Check if key exists in cache
   * @param {string} key - Cache key
   * @returns {boolean}
   */
  has(key) {
    return this.store.has(key);
  }

  /**
   * Delete a specific key
   * @param {string} key - Cache key
   */
  delete(key) {
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
    }
    this.store.delete(key);
  }

  /**
   * Clear all cache
   */
  clear() {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.store.clear();
    this.timers.clear();
  }

  /**
   * Get cache statistics
   */
  stats() {
    return {
      size: this.store.size,
      keys: Array.from(this.store.keys()),
    };
  }
}

// Global cache instance
const cache = new CacheStore();

/**
 * Express middleware for HTTP-level caching
 * Caches GET request responses
 * @param {number} ttlMinutes - Cache TTL in minutes
 */
export const cacheMiddleware = (ttlMinutes = 5) => {
  return (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }

    const cacheKey = `${req.method}:${req.path}:${JSON.stringify(req.query || {})}`;
    const cached = cache.get(cacheKey);

    if (cached) {
      res.set('X-Cache', 'HIT');
      return res.json(cached);
    }

    // Override res.json to cache response
    const originalJson = res.json.bind(res);
    res.json = function (data) {
      cache.set(cacheKey, data, ttlMinutes);
      res.set('X-Cache', 'MISS');
      return originalJson(data);
    };

    next();
  };
};

export default cache;