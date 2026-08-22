import express from 'express';
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import cors from 'cors';
import { config } from 'dotenv';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import pino from 'pino';
import Redis from 'ioredis';
import Queue from 'bull';
import { MongoClient, ObjectId } from 'mongodb';
import axios from 'axios';
import crypto from 'crypto';
import helmet from 'helmet';
import mongoSanitize from 'mongo-sanitize';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import * as prometheus from 'prom-client';
import { URL as URLParser } from 'url';
import dns from 'dns/promises';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';
import swaggerUi from 'swagger-ui-express';

config();

const app = express();
const httpServer = createServer(app);

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const MONGODB_URL =
  process.env.MONGODB_URL || 'mongodb://localhost:27017/vd-pro';
const PROXIES = (process.env.PROXIES || '')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);

const logger = pino({
  level: process.env.LOG_LEVEL || 'info'
});

const metrics = {
  httpDuration: new prometheus.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60]
  }),
  extractionDuration: new prometheus.Histogram({
    name: 'extraction_duration_seconds',
    help: 'Extraction duration',
    labelNames: ['status'],
    buckets: [5, 10, 20, 30, 45, 60, 90, 120]
  }),
  sourceSuccess: new prometheus.Counter({
    name: 'source_success_total',
    help: 'Successful extractions'
  }),
  sourceFailure: new prometheus.Counter({
    name: 'source_failure_total',
    help: 'Failed extractions',
    labelNames: ['reason']
  }),
  cacheHits: new prometheus.Counter({
    name: 'cache_hits_total',
    help: 'Cache hits',
    labelNames: ['level']
  })
};

for (const metric of Object.values(metrics)) {
  try {
    prometheus.register.registerMetric(metric);
  } catch (_) {}
}

let mongoClient = null;
let db = null;
let browserPool = null;
let proxyHealthTimer = null;

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  retryStrategy: (times) => Math.min(times * 100, 3000),
  enableReadyCheck: true,
  lazyConnect: false
});

redis.on('error', (err) => {
  logger.warn({ error: err.message }, 'Redis error');
});

redis.on('connect', () => {
  logger.info('Redis connected');
});

async function connectDatabase() {
  try {
    mongoClient = new MongoClient(MONGODB_URL, {
      maxPoolSize: 50,
      minPoolSize: 5,
      maxIdleTimeMS: 60000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      retryWrites: true
    });

    await mongoClient.connect();
    db = mongoClient.db('vd-pro');

    const collections = [
      'users',
      'extractions',
      'cache',
      'sessions',
      'failed_jobs',
      'diagnostics'
    ];

    for (const col of collections) {
      try {
        await db.createCollection(col);
      } catch (_) {}
    }

    await Promise.all([
      db.collection('extractions').createIndex({ url: 1, userId: 1 }),
      db.collection('extractions').createIndex({ createdAt: -1 }),
      db.collection('users').createIndex({ apiKey: 1 }, { unique: true }),
      db.collection('users').createIndex({ email: 1 }, { unique: true }),
      db.collection('cache').createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: 0 }
      ),
      db.collection('cache').createIndex(
        { urlHash: 1 },
        { unique: true }
      ),
      db.collection('sessions').createIndex({ userId: 1 }),
      db.collection('failed_jobs').createIndex({ createdAt: -1 })
    ]);

    logger.info('MongoDB connected');
  } catch (error) {
    logger.error({ error: error.message }, 'MongoDB connection failed');
    throw error;
  }
}

/* =========================
   Stealth helper
   ========================= */

class StealthGenerator {
  static generateScript() {
    const randomWebGLVendor = [
      'Intel Inc.',
      'NVIDIA Corporation',
      'AMD'
    ][Math.floor(Math.random() * 3)];

    const randomWebGLRenderer = [
      'Intel UHD Graphics',
      'NVIDIA GeForce GTX 1080',
      'AMD Radeon RX 6700'
    ][Math.floor(Math.random() * 3)];

    const randomTimezone = [
      'America/New_York',
      'Europe/London',
      'Asia/Tokyo'
    ][Math.floor(Math.random() * 3)];

    const randomMemory = [4, 8, 16][Math.floor(Math.random() * 3)];
    const randomConcurrency = [2, 4, 8][Math.floor(Math.random() * 3)];

    return `
(() => {
  'use strict';

  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
      configurable: true
    });
  } catch (_) {}

  try {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
      configurable: true
    });
  } catch (_) {}

  try {
    Object.defineProperty(navigator, 'vendor', {
      get: () => 'Google Inc.',
      configurable: true
    });
  } catch (_) {}

  try {
    Object.defineProperty(navigator, 'platform', {
      get: () => 'Win32',
      configurable: true
    });
  } catch (_) {}

  try {
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => ${randomMemory},
      configurable: true
    });
  } catch (_) {}

  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => ${randomConcurrency},
      configurable: true
    });
  } catch (_) {}

  try {
    const originalGetParameter =
      WebGLRenderingContext.prototype.getParameter;

    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return '${randomWebGLVendor}';
      if (parameter === 37446) return '${randomWebGLRenderer}';
      return originalGetParameter.call(this, parameter);
    };
  } catch (_) {}

  try {
    const originalResolvedOptions =
      Intl.DateTimeFormat.prototype.resolvedOptions;

    Intl.DateTimeFormat.prototype.resolvedOptions = function() {
      return {
        ...originalResolvedOptions.call(this),
        timeZone: '${randomTimezone}'
      };
    };
  } catch (_) {}
})();
`;
  }
}

/* =========================
   Proxy manager
   ========================= */

class ProxyManager {
  constructor() {
    this.proxies = PROXIES.map((url, id) => ({
      url,
      id,
      health: {
        success: 0,
        failed: 0,
        consecutive: 0,
        available: true
      }
    }));
  }

  async healthCheck() {
    for (const proxy of this.proxies) {
      try {
        await axios.get('https://httpbin.org/ip', {
          proxy: this.toAxiosProxy(proxy.url),
          timeout: 8000,
          validateStatus: () => true
        });

        proxy.health.available = true;
        proxy.health.consecutive = 0;
      } catch (_) {
        proxy.health.consecutive += 1;

        if (proxy.health.consecutive >= 3) {
          proxy.health.available = false;
        }
      }
    }
  }

  toAxiosProxy(proxyUrl) {
    try {
      const parsed = new URLParser(proxyUrl);

      return {
        protocol: parsed.protocol.replace(':', ''),
        host: parsed.hostname,
        port: Number(parsed.port || 80),
        ...(parsed.username
          ? {
              auth: {
                username: decodeURIComponent(parsed.username),
                password: decodeURIComponent(parsed.password)
              }
            }
          : {})
      };
    } catch (_) {
      return undefined;
    }
  }

  getNextProxy() {
    const available = this.proxies.filter(
      (p) => p.health.available
    );

    if (!available.length) {
      return null;
    }

    return available[
      Math.floor(Math.random() * available.length)
    ];
  }

  recordSuccess(proxy) {
    if (!proxy) return;
    proxy.health.success += 1;
    proxy.health.consecutive = 0;
    proxy.health.available = true;
  }

  recordFailure(proxy) {
    if (!proxy) return;
    proxy.health.failed += 1;
    proxy.health.consecutive += 1;

    if (proxy.health.consecutive >= 5) {
      proxy.health.available = false;
    }
  }
}

const proxyManager = new ProxyManager();

/* =========================
   Session manager
   ========================= */

class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  normalizeUserId(userId) {
    return String(userId);
  }

  async getOrCreateSession(userId) {
    const id = this.normalizeUserId(userId);
    const sessionKey = `session:${id}`;

    try {
      const cached = await redis.get(sessionKey);
      if (cached) return JSON.parse(cached);
    } catch (_) {}

    if (this.sessions.has(id)) {
      return this.sessions.get(id);
    }

    const session = {
      userId: id,
      cookies: [],
      createdAt: new Date().toISOString()
    };

    if (db && ObjectId.isValid(id)) {
      try {
        await db.collection('sessions').updateOne(
          { userId: new ObjectId(id) },
          {
            $setOnInsert: {
              userId: new ObjectId(id),
              cookies: [],
              createdAt: new Date()
            },
            $set: {
              expiresAt: new Date(
                Date.now() + 7 * 24 * 60 * 60 * 1000
              )
            }
          },
          { upsert: true }
        );
      } catch (_) {}
    }

    this.sessions.set(id, session);

    try {
      await redis.setex(
        sessionKey,
        604800,
        JSON.stringify(session)
      );
    } catch (_) {}

    return session;
  }

  async saveSession(userId, cookies) {
    const id = this.normalizeUserId(userId);

    const session = {
      userId: id,
      cookies,
      createdAt: new Date().toISOString()
    };

    this.sessions.set(id, session);

    try {
      await redis.setex(
        `session:${id}`,
        604800,
        JSON.stringify(session)
      );
    } catch (_) {}

    if (db && ObjectId.isValid(id)) {
      try {
        await db.collection('sessions').updateOne(
          { userId: new ObjectId(id) },
          {
            $set: {
              cookies,
              updatedAt: new Date(),
              expiresAt: new Date(
                Date.now() + 7 * 24 * 60 * 60 * 1000
              )
            }
          },
          { upsert: true }
        );
      } catch (_) {}
    }
  }

  async loadSession(userId) {
    const id = this.normalizeUserId(userId);

    try {
      const cached = await redis.get(`session:${id}`);
      if (cached) {
        return JSON.parse(cached).cookies || [];
      }
    } catch (_) {}

    if (db && ObjectId.isValid(id)) {
      try {
        const session = await db
          .collection('sessions')
          .findOne({ userId: new ObjectId(id) });

        if (session?.cookies) return session.cookies;
      } catch (_) {}
    }

    return [];
  }
}

const sessionManager = new SessionManager();

/* =========================
   Browser pool
   ========================= */

class BrowserContextPool {
  constructor(browser, poolSize = 2) {
    this.browser = browser;
    this.poolSize = poolSize;
    this.available = [];
    this.initialized = false;
  }

  async initialize(proxy = null) {
    for (let i = 0; i < this.poolSize; i++) {
      const contextData = await this.createContextWithProxy(proxy);
      this.available.push(contextData);
    }

    this.initialized = true;

    logger.info(
      {
        poolSize: this.poolSize,
        proxy: proxy?.url || 'none'
      },
      'Browser context pool ready'
    );
  }

  async createContextWithProxy(proxy = null) {
    const contextOptions = {
      ignoreHTTPSErrors: true,
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      geolocation: {
        latitude: 40.7128,
        longitude: -74.006
      },
      permissions: ['geolocation'],
      userAgent: this.getRandomUserAgent(),
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Upgrade-Insecure-Requests': '1',
        'DNT': '1'
      }
    };

    if (proxy?.url) {
      contextOptions.proxy = {
        server: proxy.url
      };
    }

    // IMPORTANT:
    // Playwright uses browser.newContext(), not createBrowserContext().
    const context = await this.browser.newContext(contextOptions);
    const page = await context.newPage();

    await page.addInitScript(
      StealthGenerator.generateScript()
    );

    return {
      context,
      page,
      createdAt: Date.now(),
      usage: 0,
      proxy
    };
  }

  getRandomUserAgent() {
    const agents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    ];

    return agents[Math.floor(Math.random() * agents.length)];
  }

  async getContext(proxy = null) {
    if (!proxy && this.available.length) {
      return this.available.pop();
    }

    return this.createContextWithProxy(proxy);
  }

  async releaseContext(contextData) {
    if (!contextData) return;

    const age = Date.now() - contextData.createdAt;

    if (
      age > 3600000 ||
      contextData.usage > 50
    ) {
      await this.closeContext(contextData);
      return;
    }

    this.available.push(contextData);
  }

  async closeContext(contextData) {
    try {
      await contextData.page?.close();
    } catch (_) {}

    try {
      await contextData.context?.close();
    } catch (_) {}
  }

  async closeAll() {
    await Promise.all(
      this.available.map((ctx) => this.closeContext(ctx))
    );

    this.available = [];
  }
}

class BrowserPool {
  constructor(poolSize = 1) {
    this.poolSize = poolSize;
    this.browsers = [];
    this.contextPools = [];
  }

  async initialize() {
    for (let i = 0; i < this.poolSize; i++) {
      const browser = await chromium.launch({
        headless: true,
        args: [
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-gpu'
        ],
        timeout: 30000
      });

      this.browsers.push(browser);

      const contextPool = new BrowserContextPool(
        browser,
        2
      );

      await contextPool.initialize(null);

      this.contextPools.push({
        pool: contextPool,
        browser
      });
    }

    logger.info(
      { browsers: this.poolSize },
      'Browser pool initialized'
    );
  }

  async getContextForProxy(proxy = null) {
    if (!this.browsers.length) {
      throw new Error('Browser pool is not initialized');
    }

    const browser =
      this.browsers[
        Math.floor(Math.random() * this.browsers.length)
      ];

    const contextOptions = {
      ignoreHTTPSErrors: true,
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Upgrade-Insecure-Requests': '1',
        DNT: '1'
      }
    };

    if (proxy?.url) {
      contextOptions.proxy = {
        server: proxy.url
      };
    }

    // IMPORTANT: browser.newContext()
    const context = await browser.newContext(
      contextOptions
    );

    const page = await context.newPage();

    await page.addInitScript(
      StealthGenerator.generateScript()
    );

    return {
      context,
      page,
      createdAt: Date.now(),
      usage: 0,
      proxy
    };
  }

  async closeAll() {
    await Promise.all(
      this.contextPools.map((cp) =>
        cp.pool.closeAll()
      )
    );

    await Promise.all(
      this.browsers.map((browser) =>
        browser.close().catch(() => {})
      )
    );

    this.browsers = [];
    this.contextPools = [];
  }
}

/* =========================
   Human interaction helper
   ========================= */

class HumanInteractionSimulator {
  static bezier(t, p0, p1, p2, p3) {
    const mt = 1 - t;

    return (
      mt * mt * mt * p0 +
      3 * mt * mt * t * p1 +
      3 * mt * t * t * p2 +
      t * t * t * p3
    );
  }

  static async simulateNaturalMouseMovement(
    page,
    fromX,
    fromY,
    toX,
    toY
  ) {
    const steps =
      10 + Math.floor(Math.random() * 10);

    const cp1x =
      fromX +
      (toX - fromX) * 0.3 +
      (Math.random() - 0.5) * 100;

    const cp1y =
      fromY +
      (toY - fromY) * 0.3 +
      (Math.random() - 0.5) * 100;

    const cp2x =
      fromX +
      (toX - fromX) * 0.7 +
      (Math.random() - 0.5) * 100;

    const cp2y =
      fromY +
      (toY - fromY) * 0.7 +
      (Math.random() - 0.5) * 100;

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;

      const x = this.bezier(
        t,
        fromX,
        cp1x,
        cp2x,
        toX
      );

      const y = this.bezier(
        t,
        fromY,
        cp1y,
        cp2y,
        toY
      );

      await page.mouse.move(
        Math.round(x),
        Math.round(y)
      );

      await page.waitForTimeout(
        10 + Math.random() * 30
      );
    }
  }

  static async simulateNaturalBehavior(page) {
    try {
      const viewport = page.viewportSize() || {
        width: 1920,
        height: 1080
      };

      await page.waitForTimeout(
        300 + Math.random() * 700
      );

      const scrollAmount =
        100 + Math.floor(Math.random() * 300);

      await page.evaluate((amount) => {
        window.scrollBy({
          top: amount,
          behavior: 'smooth'
        });
      }, scrollAmount);

      await page.waitForTimeout(
        300 + Math.random() * 500
      );

      const fromX =
        Math.random() * viewport.width;
      const fromY =
        Math.random() * viewport.height;

      const toX =
        Math.random() * viewport.width;
      const toY =
        Math.random() * viewport.height;

      await this.simulateNaturalMouseMovement(
        page,
        fromX,
        fromY,
        toX,
        toY
      );
    } catch (_) {}
  }
}

/* =========================
   Video extractor
   ========================= */

class VideoExtractor {
  constructor(name) {
    this.name = name;
  }

  async extract(url, page, _proxy, session) {
    const startTime = Date.now();

    const result = {
      source: this.name,
      success: false,
      primaryUrl: null,
      urls: {
        m3u8: [],
        mp4: [],
        webm: []
      },
      duration: 0,
      strategy: null,
      attempts: 0
    };

    try {
      const savedCookies =
        await sessionManager.loadSession(
          session.userId
        );

      if (savedCookies.length) {
        try {
          await page.context().addCookies(
            savedCookies
          );
        } catch (_) {}
      }

      result.attempts++;

      const networkUrls =
        await this.networkStrategy(page, url);

      if (this.hasUrls(networkUrls)) {
        result.urls = networkUrls;
        result.strategy = 'network';
      }

      if (!this.hasUrls(result.urls)) {
        const domUrls =
          await this.domStrategy(page);

        if (this.hasUrls(domUrls)) {
          result.urls = domUrls;
          result.strategy = 'dom';
        }
      }

      if (!this.hasUrls(result.urls)) {
        const scriptUrls =
          await this.scriptStrategy(page);

        if (this.hasUrls(scriptUrls)) {
          result.urls = scriptUrls;
          result.strategy = 'script';
        }
      }

      if (!this.hasUrls(result.urls)) {
        const xhrUrls =
          await this.advancedXHRStrategy(page);

        if (xhrUrls.length) {
          result.urls.m3u8 = xhrUrls;
          result.strategy = 'xhr';
        }
      }

      if (!this.hasUrls(result.urls)) {
        result.attempts++;

        await page.waitForTimeout(1000);

        const retryUrls =
          await this.networkStrategy(page, url);

        if (this.hasUrls(retryUrls)) {
          result.urls = retryUrls;
          result.strategy = 'network_retry';
        }
      }

      const allUrls = [
        ...result.urls.m3u8,
        ...result.urls.mp4,
        ...result.urls.webm
      ];

      if (allUrls.length) {
        result.primaryUrl = allUrls[0];
        result.success = true;
      }

      try {
        const cookies =
          await page.context().cookies();

        await sessionManager.saveSession(
          session.userId,
          cookies
        );
      } catch (_) {}

      result.duration =
        (Date.now() - startTime) / 1000;

      return result;
    } catch (error) {
      logger.warn(
        { error: error.message },
        'Extraction error'
      );

      result.duration =
        (Date.now() - startTime) / 1000;

      return result;
    }
  }

  hasUrls(urlObj) {
    return Boolean(
      urlObj?.m3u8?.length ||
      urlObj?.mp4?.length ||
      urlObj?.webm?.length
    );
  }

  async networkStrategy(page, url) {
    const intercepted = {
      m3u8: new Set(),
      mp4: new Set(),
      webm: new Set()
    };

    const handler = (route) => {
      const requestUrl =
        route.request().url();

      if (requestUrl.includes('.m3u8')) {
        intercepted.m3u8.add(requestUrl);
      } else if (requestUrl.includes('.mp4')) {
        intercepted.mp4.add(requestUrl);
      } else if (requestUrl.includes('.webm')) {
        intercepted.webm.add(requestUrl);
      }

      route.continue().catch(() => {});
    };

    await page.route('**/*', handler);

    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 45000
      });
    } catch (_) {}

    await page.waitForTimeout(2000);

    await HumanInteractionSimulator
      .simulateNaturalBehavior(page);

    try {
      await page.unroute('**/*', handler);
    } catch (_) {}

    return {
      m3u8: [...intercepted.m3u8],
      mp4: [...intercepted.mp4],
      webm: [...intercepted.webm]
    };
  }

  async domStrategy(page) {
    const content = await page.content();
    const $ = cheerio.load(content);

    const urls = {
      m3u8: [],
      mp4: [],
      webm: []
    };

    const addUrl = (src) => {
      if (!src) return;

      try {
        const absolute = new URLParser(
          src,
          page.url()
        ).href;

        if (absolute.includes('.m3u8')) {
          urls.m3u8.push(absolute);
        } else if (absolute.includes('.mp4')) {
          urls.mp4.push(absolute);
        } else if (absolute.includes('.webm')) {
          urls.webm.push(absolute);
        }
      } catch (_) {}
    };

    $('video').each((_, el) => {
      addUrl(
        $(el).attr('src') ||
        $(el).attr('data-src')
      );
    });

    $('video source').each((_, el) => {
      addUrl(
        $(el).attr('src') ||
        $(el).attr('data-src')
      );
    });

    return {
      m3u8: [...new Set(urls.m3u8)],
      mp4: [...new Set(urls.mp4)],
      webm: [...new Set(urls.webm)]
    };
  }

  async scriptStrategy(page) {
    const content = await page.content();

    const urls = {
      m3u8: [],
      mp4: [],
      webm: []
    };

    const patterns = {
      m3u8:
        /https?:\/\/[^"'\\s<>{}]+\.m3u8[^"'\\s<>{}]*/gi,
      mp4:
        /https?:\/\/[^"'\\s<>{}]+\.mp4[^"'\\s<>{}]*/gi,
      webm:
        /https?:\/\/[^"'\\s<>{}]+\.webm[^"'\\s<>{}]*/gi
    };

    for (const type of Object.keys(patterns)) {
      const matches =
        content.match(patterns[type]) || [];

      urls[type] = [
        ...new Set(matches)
      ];
    }

    return urls;
  }

  async advancedXHRStrategy(page) {
    const result = await page.evaluate(() => {
      return new Promise((resolve) => {
        const urls = [];

        const originalFetch = window.fetch;
        const originalOpen =
          XMLHttpRequest.prototype.open;

        window.fetch = function(...args) {
          try {
            const value = args[0];
            const requestUrl =
              typeof value === 'string'
                ? value
                : value?.url;

            if (
              requestUrl &&
              (requestUrl.includes('.m3u8') ||
                requestUrl.includes('manifest'))
            ) {
              urls.push(requestUrl);
            }
          } catch (_) {}

          return originalFetch.apply(
            this,
            args
          );
        };

        XMLHttpRequest.prototype.open =
          function(method, requestUrl, ...rest) {
            try {
              if (
                typeof requestUrl === 'string' &&
                (requestUrl.includes('.m3u8') ||
                  requestUrl.includes('manifest'))
              ) {
                urls.push(requestUrl);
              }
            } catch (_) {}

            return originalOpen.call(
              this,
              method,
              requestUrl,
              ...rest
            );
          };

        setTimeout(() => {
          window.fetch = originalFetch;
          XMLHttpRequest.prototype.open =
            originalOpen;

          resolve([
            ...new Set(urls)
          ]);
        }, 5000);
      });
    }).catch(() => []);

    return result || [];
  }
}

/* =========================
   Result validator
   ========================= */

class ResultValidator {
  static async validate(result) {
    if (!result?.primaryUrl) {
      return {
        valid: false,
        reason: 'NO_URL'
      };
    }

    let parsed;

    try {
      parsed = new URLParser(
        result.primaryUrl
      );
    } catch (_) {
      return {
        valid: false,
        reason: 'INVALID_URL'
      };
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return {
        valid: false,
        reason: 'INVALID_PROTOCOL'
      };
    }

    try {
      const response = await axios.get(
        result.primaryUrl,
        {
          timeout: 15000,
          maxRedirects: 5,
          maxContentLength: 100000,
          validateStatus: () => true,
          headers: {
            'User-Agent':
              'Mozilla/5.0'
          }
        }
      );

      if (
        response.status < 200 ||
        response.status >= 400
      ) {
        return {
          valid: false,
          reason: 'INVALID_STATUS'
        };
      }

      if (
        result.primaryUrl
          .toLowerCase()
          .includes('.m3u8')
      ) {
        const content =
          typeof response.data === 'string'
            ? response.data
            : String(response.data);

        if (!content.includes('#EXTM3U')) {
          return {
            valid: false,
            reason: 'INVALID_M3U8'
          };
        }
      }

      return { valid: true };
    } catch (_) {
      // A valid media URL may reject a HEAD/range-style probe.
      return { valid: true };
    }
  }
}

/* =========================
   SSRF protection
   ========================= */

class SSRFValidator {
  static isPrivateIPv4(ip) {
    const parts = ip.split('.').map(Number);

    if (
      parts.length !== 4 ||
      parts.some((n) => !Number.isInteger(n))
    ) {
      return false;
    }

    const [a, b] = parts;

    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }

  static isPrivateIPv6(hostname) {
    const h = hostname.toLowerCase();

    return (
      h === '::1' ||
      h.startsWith('fc') ||
      h.startsWith('fd') ||
      h.startsWith('fe80:')
    );
  }

  static async validate(urlString) {
    if (
      typeof urlString !== 'string' ||
      urlString.length > 2048
    ) {
      return {
        valid: false,
        reason: 'URL too long or invalid'
      };
    }

    try {
      const url = new URLParser(urlString);

      if (
        !['http:', 'https:'].includes(
          url.protocol
        )
      ) {
        return {
          valid: false,
          reason: 'Invalid protocol'
        };
      }

      const hostname = url.hostname;

      if (
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        this.isPrivateIPv4(hostname) ||
        this.isPrivateIPv6(hostname)
      ) {
        return {
          valid: false,
          reason: 'Private address'
        };
      }

      const results = await Promise.allSettled([
        dns.resolve4(hostname),
        dns.resolve6(hostname)
      ]);

      for (const result of results) {
        if (result.status !== 'fulfilled') {
          continue;
        }

        for (const address of result.value) {
          if (
            this.isPrivateIPv4(address) ||
            this.isPrivateIPv6(address)
          ) {
            return {
              valid: false,
              reason: 'Private DNS address'
            };
          }
        }
      }

      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        reason: error.message
      };
    }
  }
}

/* =========================
   Cache
   ========================= */

class CacheManager {
  constructor() {
    this.l1 = new Map();
    this.l1MaxSize = 100;
  }

  hash(url) {
    return crypto
      .createHash('sha256')
      .update(url)
      .digest('hex');
  }

  setL1(key, value) {
    if (this.l1.size >= this.l1MaxSize) {
      const firstKey =
        this.l1.keys().next().value;

      if (firstKey) {
        this.l1.delete(firstKey);
      }
    }

    this.l1.set(key, value);
  }

  async get(url) {
    const urlHash = this.hash(url);

    if (this.l1.has(urlHash)) {
      metrics.cacheHits
        .labels('l1')
        .inc();

      return this.l1.get(urlHash);
    }

    try {
      const redisData =
        await redis.get(
          `cache:${urlHash}`
        );

      if (redisData) {
        metrics.cacheHits
          .labels('l2')
          .inc();

        const parsed =
          JSON.parse(redisData);

        this.setL1(urlHash, parsed);

        return parsed;
      }
    } catch (_) {}

    if (db) {
      try {
        const dbCache =
          await db.collection('cache').findOne({
            urlHash,
            expiresAt: {
              $gt: new Date()
            }
          });

        if (dbCache) {
          metrics.cacheHits
            .labels('l3')
            .inc();

          this.setL1(
            urlHash,
            dbCache.data
          );

          return dbCache.data;
        }
      } catch (_) {}
    }

    return null;
  }

  async set(url, data, ttl = 86400) {
    const urlHash = this.hash(url);

    this.setL1(urlHash, data);

    try {
      await redis.setex(
        `cache:${urlHash}`,
        Math.min(ttl, 86400),
        JSON.stringify(data)
      );
    } catch (_) {}

    if (db) {
      try {
        await db.collection('cache').updateOne(
          { urlHash },
          {
            $set: {
              url,
              urlHash,
              data,
              expiresAt: new Date(
                Date.now() +
                  ttl * 1000
              ),
              createdAt: new Date()
            }
          },
          { upsert: true }
        );
      } catch (error) {
        logger.warn(
          { error: error.message },
          'Cache DB save failed'
        );
      }
    }
  }
}

const cacheManager =
  new CacheManager();

/* =========================
   Single flight
   ========================= */

class SingleFlightManager {
  constructor() {
    this.flights = new Map();
  }

  hash(url) {
    return crypto
      .createHash('sha256')
      .update(url)
      .digest('hex');
  }

  get(url) {
    return this.flights.get(
      this.hash(url)
    );
  }

  set(url, promise) {
    const key = this.hash(url);

    this.flights.set(
      key,
      promise
    );

    promise.finally(() => {
      if (
        this.flights.get(key) ===
        promise
      ) {
        this.flights.delete(key);
      }
    }).catch(() => {});

    return key;
  }

  remove(url) {
    this.flights.delete(
      this.hash(url)
    );
  }
}

const singleFlight =
  new SingleFlightManager();

/* =========================
   Circuit breaker
   ========================= */

class CircuitBreaker {
  constructor() {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttempt = 0;
  }

  async execute(fn) {
    if (
      this.state === 'OPEN'
    ) {
      if (
        Date.now() <
        this.nextAttempt
      ) {
        throw new Error(
          'Circuit breaker OPEN'
        );
      }

      this.state = 'HALF_OPEN';
    }

    try {
      const result =
        await fn();

      this.onSuccess();

      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    this.failureCount = 0;

    if (
      this.state === 'HALF_OPEN'
    ) {
      this.successCount++;

      if (
        this.successCount >= 2
      ) {
        this.state = 'CLOSED';
        this.successCount = 0;
      }
    }
  }

  onFailure() {
    this.failureCount++;
    this.successCount = 0;

    if (
      this.failureCount >= 5
    ) {
      this.state = 'OPEN';
      this.nextAttempt =
        Date.now() + 60000;
    }
  }
}

const circuitBreaker =
  new CircuitBreaker();

/* =========================
   Queue
   ========================= */

const extractionQueue =
  new Queue('extraction', REDIS_URL, {
    settings: {
      stalledInterval: 10000,
      maxStalledCount: 2,
      lockDuration: 90000,
      lockRenewTime: 45000
    }
  });

/* =========================
   Middleware
   ========================= */

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  })
);

app.use(mongoSanitize());
app.use(cors());
app.use(
  express.json({
    limit: '10mb'
  })
);

app.use((req, res, next) => {
  const start = Date.now();

  req.requestId = uuidv4();

  res.on('finish', () => {
    const duration =
      (Date.now() - start) / 1000;

    metrics.httpDuration
      .labels(
        req.method,
        req.path,
        String(res.statusCode)
      )
      .observe(duration);
  });

  next();
});

const limiter =
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false
  });

app.use(
  '/api/v1/',
  limiter
);

/* =========================
   Auth
   ========================= */

async function verifyToken(
  req,
  res,
  next
) {
  try {
    const header =
      req.headers.authorization || '';

    const token =
      header.startsWith('Bearer ')
        ? header.slice(7)
        : null;

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No token'
      });
    }

    const decoded =
      jwt.verify(
        token,
        JWT_SECRET
      );

    if (!db) {
      return res.status(503).json({
        success: false,
        error: 'Database unavailable'
      });
    }

    const user =
      await db.collection('users').findOne({
        apiKey: decoded.apiKey
      });

    if (!user) {
      return res.status(403).json({
        success: false,
        error: 'User not found'
      });
    }

    req.user = user;

    next();
  } catch (_) {
    return res.status(403).json({
      success: false,
      error: 'Invalid token'
    });
  }
}

/* =========================
   Swagger
   ========================= */

const swaggerDocs = {
  openapi: '3.0.0',
  info: {
    title:
      'Vd-Pro Video Extraction API',
    version: '2.0.0'
  },
  servers: [
    {
      url: '/api/v1'
    }
  ],
  paths: {
    '/extract': {
      get: {
        summary:
          'Extract video asynchronously',
        parameters: [
          {
            name: 'url',
            in: 'query',
            required: true,
            schema: {
              type: 'string'
            }
          }
        ],
        responses: {
          '202': {
            description:
              'Job queued'
          }
        }
      }
    }
  }
};

app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup(swaggerDocs)
);

/* =========================
   Routes
   ========================= */

app.get(
  '/api/v1/health',
  async (_req, res) => {
    res.json({
      status: 'healthy',
      timestamp:
        new Date().toISOString(),
      redis: redis.status,
      mongodb:
        db
          ? 'connected'
          : 'disconnected',
      browser:
        browserPool
          ? 'ready'
          : 'not_ready',
      name: 'Vd-Pro'
    });
  }
);

app.get(
  '/api/v1/metrics',
  async (_req, res) => {
    try {
      res.set(
        'Content-Type',
        prometheus.register
          .contentType
      );

      res.end(
        await prometheus.register.metrics()
      );
    } catch (error) {
      res.status(500).end(
        error.message
      );
    }
  }
);

app.post(
  '/api/v1/auth/register',
  async (req, res) => {
    try {
      const {
        email,
        password,
        plan = 'free'
      } = req.body || {};

      if (
        typeof email !== 'string' ||
        typeof password !== 'string' ||
        password.length < 8
      ) {
        return res.status(400).json({
          success: false,
          error:
            'Valid email and password (minimum 8 characters) are required'
        });
      }

      if (!db) {
        return res.status(503).json({
          success: false,
          error:
            'Service unavailable'
        });
      }

      const normalizedEmail =
        email.trim().toLowerCase();

      const existing =
        await db.collection('users').findOne({
          email:
            normalizedEmail
        });

      if (existing) {
        return res.status(409).json({
          success: false,
          error:
            'Email already registered'
        });
      }

      const apiKey =
        crypto.randomBytes(32)
          .toString('hex');

      const hashedPassword =
        await bcrypt.hash(
          password,
          12
        );

      await db.collection('users')
        .insertOne({
          email:
            normalizedEmail,
          password:
            hashedPassword,
          apiKey,
          plan:
            ['free', 'pro', 'enterprise']
              .includes(plan)
              ? plan
              : 'free',
          createdAt:
            new Date()
        });

      const token =
        jwt.sign(
          { apiKey },
          JWT_SECRET,
          {
            expiresIn: '30d'
          }
        );

      res.status(201).json({
        success: true,
        apiKey,
        token,
        plan:
          ['free', 'pro', 'enterprise']
            .includes(plan)
            ? plan
            : 'free'
      });
    } catch (error) {
      logger.error(
        { error: error.message },
        'Register failed'
      );

      res.status(500).json({
        success: false,
        error:
          'Registration failed'
      });
    }
  }
);

app.get(
  '/api/v1/extract',
  verifyToken,
  async (req, res) => {
    const { url } =
      req.query;

    try {
      const validation =
        await SSRFValidator.validate(
          url
        );

      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          error:
            validation.reason
        });
      }

      const cached =
        await cacheManager.get(
          url
        );

      if (cached) {
        return res.json({
          success: true,
          fromCache: true,
          ...cached
        });
      }

      const existing =
        singleFlight.get(
          url
        );

      if (existing) {
        return res.status(202).json({
          success: true,
          message:
            'Processing (deduplicated)'
        });
      }

      const job =
        await extractionQueue.add(
          {
            url,
            userId:
              String(req.user._id)
          },
          {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 2000
            },
            priority:
              req.user.plan ===
              'enterprise'
                ? 1
                : 10,
            timeout: 180000
          }
        );

      const promise =
        job.finished();

      singleFlight.set(
        url,
        promise
      );

      res.status(202).json({
        success: true,
        jobId: job.id,
        statusUrl:
          `/api/v1/jobs/${job.id}`
      });
    } catch (error) {
      logger.error(
        { error: error.message },
        'Extract failed'
      );

      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

app.get(
  '/api/v1/jobs/:jobId',
  verifyToken,
  async (req, res) => {
    try {
      const job =
        await extractionQueue.getJob(
          req.params.jobId
        );

      if (!job) {
        return res.status(404).json({
          success: false,
          error:
            'Job not found'
        });
      }

      const state =
        await job.getState();

      const result =
        state === 'completed'
          ? job.returnvalue
          : null;

      res.json({
        success: true,
        jobId: job.id,
        state,
        result
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

app.post(
  '/api/v1/jobs/:jobId/retry',
  verifyToken,
  async (req, res) => {
    try {
      if (!db) {
        return res.status(503).json({
          success: false,
          error:
            'Database unavailable'
        });
      }

      const failedJob =
        await db
          .collection('failed_jobs')
          .findOne({
            jobId:
              req.params.jobId
          });

      if (!failedJob) {
        return res.status(404).json({
          success: false,
          error:
            'Failed job not found'
        });
      }

      const newJob =
        await extractionQueue.add(
          {
            url:
              failedJob.jobData.url,
            userId:
              String(req.user._id)
          },
          {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 2000
            }
          }
        );

      res.status(202).json({
        success: true,
        newJobId:
          newJob.id,
        statusUrl:
          `/api/v1/jobs/${newJob.id}`
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

/* =========================
   Queue worker
   ========================= */

extractionQueue.process(
  4,
  async (job) => {
    let contextData = null;

    try {
      if (!browserPool) {
        throw new Error(
          'Browser pool is not ready'
        );
      }

      const proxy =
        proxyManager.getNextProxy();

      const session =
        await sessionManager
          .getOrCreateSession(
            job.data.userId
          );

      contextData =
        await browserPool
          .getContextForProxy(
            proxy
          );

      contextData.usage++;

      const extractor =
        new VideoExtractor(
          'vd-pro'
        );

      const result =
        await circuitBreaker.execute(
          () =>
            extractor.extract(
              job.data.url,
              contextData.page,
              proxy,
              {
                userId:
                  String(
                    job.data.userId
                  )
              }
            )
        );

      metrics.extractionDuration
        .labels(
          result.success
            ? 'success'
            : 'failure'
        )
        .observe(
          result.duration
        );

      if (result.success) {
        metrics.sourceSuccess.inc();

        const validation =
          await ResultValidator
            .validate(result);

        if (!validation.valid) {
          logger.warn(
            {
              reason:
                validation.reason
            },
            'Result validation failed'
          );
        }

        if (proxy) {
          proxyManager.recordSuccess(
            proxy
          );
        }

        if (db) {
          await db
            .collection('extractions')
            .insertOne({
              extractionId:
                uuidv4(),
              jobId:
                String(job.id),
              userId:
                ObjectId.isValid(
                  String(
                    job.data.userId
                  )
                )
                  ? new ObjectId(
                      String(
                        job.data.userId
                      )
                    )
                  : null,
              url:
                job.data.url,
              result,
              strategy:
                result.strategy,
              attempts:
                result.attempts,
              createdAt:
                new Date(),
              expiresAt:
                new Date(
                  Date.now() +
                    7 *
                      24 *
                      60 *
                      60 *
                      1000
                )
            });

          await cacheManager.set(
            job.data.url,
            result
          );
        }
      } else {
        metrics.sourceFailure
          .labels(
            'extraction_failed'
          )
          .inc();

        if (proxy) {
          proxyManager.recordFailure(
            proxy
          );
        }

        if (db) {
          await db
            .collection('diagnostics')
            .insertOne({
              jobId:
                String(job.id),
              url:
                job.data.url,
              strategy:
                result.strategy,
              attempts:
                result.attempts,
              duration:
                result.duration,
              createdAt:
                new Date()
            });
        }
      }

      return result;
    } catch (error) {
      logger.error(
        {
          jobId: job.id,
          error: error.message
        },
        'Job failed'
      );

      if (db) {
        try {
          await db
            .collection('failed_jobs')
            .insertOne({
              jobId:
                String(job.id),
              jobData:
                job.data,
              error:
                error.message,
              attempts:
                job.attemptsMade,
              createdAt:
                new Date()
            });
        } catch (_) {}
      }

      throw error;
    } finally {
      if (contextData) {
        try {
          await contextData.page.close();
        } catch (_) {}

        try {
          await contextData.context.close();
        } catch (_) {}
      }
    }
  }
);

/* =========================
   WebSocket
   ========================= */

const wss = new WebSocketServer({
  server: httpServer
});

wss.on(
  'connection',
  (ws) => {
    ws.on(
      'message',
      async (message) => {
        try {
          const data =
            JSON.parse(
              message.toString()
            );

          if (
            data.type ===
              'job_status' &&
            data.jobId
          ) {
            const job =
              await extractionQueue
                .getJob(
                  data.jobId
                );

            if (!job) {
              ws.send(
                JSON.stringify({
                  type:
                    'error',
                  message:
                    'Job not found'
                })
              );
              return;
            }

            const state =
              await job.getState();

            ws.send(
              JSON.stringify({
                type:
                  'job_update',
                jobId:
                  data.jobId,
                state
              })
            );
          }
        } catch (error) {
          try {
            ws.send(
              JSON.stringify({
                type:
                  'error',
                message:
                  error.message
              })
            );
          } catch (_) {}
        }
      }
    );
  }
);

/* =========================
   Error handler
   ========================= */

app.use(
  (error, _req, res, _next) => {
    logger.error(
      {
        error:
          error.message
      },
      'Unhandled request error'
    );

    if (res.headersSent) {
      return;
    }

    res.status(500).json({
      success: false,
      error:
        'Internal server error'
    });
  }
);

/* =========================
   Shutdown
   ========================= */

let shuttingDown = false;

async function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(
    'Shutting down...'
  );

  if (proxyHealthTimer) {
    clearInterval(
      proxyHealthTimer
    );
  }

  try {
    await new Promise(
      (resolve) =>
        httpServer.close(
          () => resolve()
        )
    );
  } catch (_) {}

  try {
    await browserPool?.closeAll();
  } catch (_) {}

  try {
    await extractionQueue.close();
  } catch (_) {}

  try {
    await redis.quit();
  } catch (_) {}

  try {
    if (mongoClient) {
      await mongoClient.close();
    }
  } catch (_) {}

  try {
    await new Promise(
      (resolve) =>
        wss.close(() => resolve())
    );
  } catch (_) {}

  logger.info(
    'Shutdown complete'
  );

  process.exit(0);
}

process.on(
  'SIGTERM',
  gracefulShutdown
);

process.on(
  'SIGINT',
  gracefulShutdown
);

/* =========================
   Start
   ========================= */

(async () => {
  try {
    logger.info(
      'Starting Vd-Pro...'
    );

    try {
      await connectDatabase();
    } catch (error) {
      logger.warn(
        {
          error:
            error.message
        },
        'MongoDB unavailable; continuing without MongoDB'
      );
    }

    browserPool =
      new BrowserPool(1);

    await browserPool.initialize();

    proxyHealthTimer =
      setInterval(
        () =>
          proxyManager
            .healthCheck()
            .catch(() => {}),
        300000
      );

    httpServer.listen(
      PORT,
      '0.0.0.0',
      () => {
        logger.info(
          {
            port: PORT
          },
          'Vd-Pro server is running'
        );
      }
    );
  } catch (error) {
    logger.error(
      {
        error:
          error.message,
        stack:
          error.stack
      },
      'Startup error'
    );

    try {
      await browserPool?.closeAll();
    } catch (_) {}

    process.exit(1);
  }
})();

export default app;
