/**
 * Vd-Pro v3.2 — Professional Video Extraction Platform
 * Search fixed: API-first (DDG Instant + Wikipedia + optional TMDB)
 * Browser search only as fallback
 */

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
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const JWT_SECRET = process.env.JWT_SECRET;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const MONGODB_URL = process.env.MONGODB_URL || 'mongodb://localhost:27017/vd-pro';
const PROXIES = (process.env.PROXIES || '').split(',').map((p) => p.trim()).filter(Boolean);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const EXTRACT_TIMEOUT_MS = parseInt(process.env.EXTRACT_TIMEOUT_MS || '90000', 10);

if (NODE_ENV === 'production') {
  if (!JWT_SECRET || JWT_SECRET.length < 32) {
    console.error('FATAL: JWT_SECRET must be set and at least 32 characters in production');
    process.exit(1);
  }
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'dev-only-secret-change-me-in-production-min-32-chars';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const metrics = {
  httpDuration: new prometheus.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP duration',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60]
  }),
  extractionDuration: new prometheus.Histogram({
    name: 'extraction_duration_seconds',
    help: 'Extraction duration',
    labelNames: ['status'],
    buckets: [5, 10, 20, 30, 45, 60, 90, 120]
  }),
  sourceSuccess: new prometheus.Counter({ name: 'source_success_total', help: 'Success' }),
  sourceFailure: new prometheus.Counter({ name: 'source_failure_total', help: 'Failure', labelNames: ['reason'] }),
  cacheHits: new prometheus.Counter({ name: 'cache_hits_total', help: 'Cache', labelNames: ['level'] })
};
Object.values(metrics).forEach((m) => {
  try {
    prometheus.register.registerMetric(m);
  } catch (e) {}
});

let mongoClient = null;
let db = null;

async function connectDatabase() {
  try {
    mongoClient = new MongoClient(MONGODB_URL, {
      maxPoolSize: 40,
      minPoolSize: 5,
      maxIdleTimeMS: 60000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      retryWrites: true,
      serverSelectionTimeoutMS: 10000
    });
    await mongoClient.connect();
    db = mongoClient.db('vd-pro');
    for (const col of ['users', 'extractions', 'cache', 'sessions', 'failed_jobs', 'diagnostics']) {
      try {
        await db.createCollection(col);
      } catch (e) {}
    }
    await Promise.all([
      db.collection('extractions').createIndex({ url: 1, userId: 1 }),
      db.collection('extractions').createIndex({ jobId: 1 }, { unique: true }),
      db.collection('users').createIndex({ apiKey: 1 }, { unique: true }),
      db.collection('users').createIndex({ email: 1 }, { unique: true }),
      db.collection('cache').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      db.collection('cache').createIndex({ contentHash: 1 }, { unique: true }),
      db.collection('sessions').createIndex({ userId: 1 }),
      db.collection('failed_jobs').createIndex({ createdAt: -1 })
    ]);
    logger.info('✅ MongoDB connected');
    return true;
  } catch (error) {
    logger.error({ error: error.message }, '❌ MongoDB');
    return false;
  }
}

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  retryStrategy: (t) => Math.min(t * 50, 2000),
  enableReadyCheck: true,
  connectTimeout: 10000,
  commandTimeout: 5000
});
redis.on('error', (e) => logger.warn({ error: e.message }, '⚠️ Redis'));
redis.on('connect', () => logger.info('✅ Redis connected'));

class SSRFValidator {
  static PRIVATE = [
    /^localhost$/i, /^127\./, /^10\./, /^172\.(1[6-9]|2[0-9]|3[01])\./,
    /^192\.168\./, /^169\.254\./, /^0\.0\.0\.0$/, /^::1$/,
    /^fc00:/i, /^fd[0-9a-f]{2}:/i, /^fe80:/i, /^ff00:/i,
    /^100\.(6[4-9]|[7-9][0-9]|1[0-2][0-9])\./
  ];
  static isPrivate(host) {
    if (!host) return true;
    const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
    return this.PRIVATE.some((p) => p.test(h));
  }
  static async validate(urlString) {
    try {
      if (!urlString || typeof urlString !== 'string') return { valid: false, reason: 'URL required' };
      if (urlString.length > 2048) return { valid: false, reason: 'URL too long' };
      const url = new URLParser(urlString);
      if (!['http:', 'https:'].includes(url.protocol)) return { valid: false, reason: 'Invalid protocol' };
      if (this.isPrivate(url.hostname)) return { valid: false, reason: 'Private host blocked' };
      try {
        for (const a of await dns.resolve4(url.hostname)) {
          if (this.isPrivate(a)) return { valid: false, reason: 'Private IPv4' };
        }
      } catch (e) {}
      try {
        for (const a of await dns.resolve6(url.hostname)) {
          if (this.isPrivate(a)) return { valid: false, reason: 'Private IPv6' };
        }
      } catch (e) {}
      return { valid: true };
    } catch (e) {
      return { valid: false, reason: e.message || 'Invalid URL' };
    }
  }
}

function resolveUrl(base, rel) {
  try {
    if (!rel) return null;
    if (/^(https?:|blob:|data:)/i.test(rel)) return rel;
    return new URL(rel, base).href;
  } catch (e) {
    return null;
  }
}

function looksLikeMedia(url = '', ct = '') {
  const u = url.toLowerCase();
  const c = (ct || '').toLowerCase();
  if (/\.(m3u8|mp4|webm|mpd|m4s|ts)(\?|#|$)/i.test(u)) return true;
  if (/\/hls\/|\/dash\/|manifest|playlist/i.test(u)) return true;
  if (c.includes('mpegurl') || c.includes('dash+xml') || c.startsWith('video/')) return true;
  return false;
}

function classifyMedia(url = '', ct = '') {
  const u = url.toLowerCase();
  const c = (ct || '').toLowerCase();
  if (u.includes('.m3u8') || c.includes('mpegurl')) return 'm3u8';
  if (u.includes('.mpd') || c.includes('dash+xml')) return 'mpd';
  if (u.includes('.webm')) return 'webm';
  if (u.includes('.mp4') || c.includes('mp4') || c.startsWith('video/')) return 'mp4';
  if (looksLikeMedia(url, ct)) return 'm3u8';
  return null;
}

function rankScore(url) {
  const u = (url || '').toLowerCase();
  let s = 0;
  if (u.includes('.mp4')) s += 50;
  if (u.includes('.m3u8')) s += 40;
  if (u.includes('.mpd')) s += 35;
  if (u.includes('1080') || u.includes('1920')) s += 20;
  if (u.includes('720')) s += 12;
  if (u.includes('preview') || u.includes('trailer') || u.includes('thumb')) s -= 15;
  if (u.startsWith('blob:')) s -= 40;
  return s;
}

function pickByQuality(variants, quality = 'auto') {
  if (!variants?.length) return null;
  if (!quality || quality === 'auto') {
    return [...variants].sort((a, b) => rankScore(b.url) - rankScore(a.url))[0];
  }
  const q = String(quality).toLowerCase();
  return (
    variants.find((v) => (v.quality || '').toLowerCase().includes(q) || (v.url || '').toLowerCase().includes(q)) ||
    variants[0]
  );
}

function titleSimilarity(a, b) {
  const na = String(a || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const nb = String(b || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const wa = new Set(na.split(' ').filter((w) => w.length > 1));
  const wb = new Set(nb.split(' ').filter((w) => w.length > 1));
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / Math.max(wa.size, wb.size);
}

const httpClient = axios.create({
  timeout: 15000,
  maxRedirects: 5,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: 'application/json, text/html, */*'
  },
  validateStatus: (s) => s >= 200 && s < 400
});

class HLSParser {
  static async fetchText(url) {
    const res = await httpClient.get(url, { maxContentLength: 2_000_000, headers: { Accept: '*/*' } });
    return String(res.data || '');
  }
  static parseMaster(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
      const meta = line.slice('#EXT-X-STREAM-INF:'.length);
      const bw = /BANDWIDTH=(\d+)/i.exec(meta);
      const res = /RESOLUTION=(\d+x\d+)/i.exec(meta);
      const name = /NAME="([^"]+)"/i.exec(meta);
      const next = (lines[i + 1] || '').trim();
      if (!next || next.startsWith('#')) continue;
      const abs = resolveUrl(baseUrl, next);
      if (!abs) continue;
      let quality = name?.[1] || null;
      if (!quality && res) {
        const h = parseInt(res[1].split('x')[1], 10);
        quality = h >= 1080 ? '1080p' : h >= 720 ? '720p' : h >= 480 ? '480p' : `${h}p`;
      }
      variants.push({
        url: abs,
        bandwidth: bw ? parseInt(bw[1], 10) : 0,
        resolution: res?.[1] || null,
        quality: quality || 'unknown'
      });
    }
    return variants;
  }
  static async enrich(m3u8Url) {
    try {
      const text = await this.fetchText(m3u8Url);
      if (!text.includes('#EXTM3U')) return { type: 'invalid', variants: [] };
      if (text.includes('#EXT-X-STREAM-INF')) {
        return { type: 'master', variants: this.parseMaster(text, m3u8Url) };
      }
      return { type: 'media', variants: [{ url: m3u8Url, quality: 'media', bandwidth: 0 }] };
    } catch (e) {
      return { type: 'error', variants: [] };
    }
  }
}

class StealthGenerator {
  static script() {
    const vendor = ['Intel Inc.', 'NVIDIA Corporation', 'AMD'][Math.floor(Math.random() * 3)];
    const renderer = ['Intel UHD Graphics 630', 'NVIDIA GeForce GTX 1660', 'AMD Radeon RX 580'][
      Math.floor(Math.random() * 3)
    ];
    return `(function(){'use strict';
Object.defineProperty(navigator,'webdriver',{get:()=>false});
try{delete navigator.__proto__.webdriver}catch(e){}
Object.defineProperty(navigator,'languages',{get:()=>['en-US','en','ar']});
window.chrome=window.chrome||{runtime:{},app:{}};
const gp=WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter=function(p){if(p===37445)return '${vendor}';if(p===37446)return '${renderer}';return gp.call(this,p)};
Object.defineProperty(navigator,'vendor',{value:'Google Inc.'});
})();`;
  }
}

class ProxyManager {
  constructor() {
    this.proxies = PROXIES.map((url, id) => ({
      url,
      id,
      health: { success: 0, failed: 0, consecutive: 0, available: true }
    }));
  }
  getNext() {
    if (!this.proxies.length) return null;
    const ok = this.proxies.filter((p) => p.health.available);
    if (!ok.length) {
      this.proxies.forEach((p) => {
        p.health.available = true;
        p.health.consecutive = 0;
      });
      return this.proxies[0];
    }
    return ok[Math.floor(Math.random() * ok.length)];
  }
  success(p) {
    if (!p) return;
    p.health.success++;
    p.health.consecutive = 0;
    p.health.available = true;
  }
  fail(p) {
    if (!p) return;
    p.health.failed++;
    p.health.consecutive++;
    if (p.health.consecutive >= 5) p.health.available = false;
  }
  status() {
    return this.proxies.map((p) => {
      let safe = p.url;
      try {
        const u = new URL(p.url.includes('://') ? p.url : `http://${p.url}`);
        if (u.username || u.password) safe = `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`;
      } catch (e) {
        safe = '[redacted]';
      }
      return { url: safe, available: p.health.available, success: p.health.success, failed: p.health.failed };
    });
  }
}
const proxyManager = new ProxyManager();

class SessionManager {
  async load(userId) {
    if (!userId) return [];
    try {
      const c = await redis.get(`session:${userId}`);
      if (c) return JSON.parse(c).cookies || [];
    } catch (e) {}
    if (db) {
      try {
        const s = await db.collection('sessions').findOne({ userId: new ObjectId(userId) });
        if (s?.cookies) return s.cookies;
      } catch (e) {}
    }
    return [];
  }
  async save(userId, cookies) {
    if (!userId) return;
    try {
      await redis.setex(`session:${userId}`, 604800, JSON.stringify({ cookies, updatedAt: new Date() }));
    } catch (e) {}
    if (db) {
      try {
        await db.collection('sessions').updateOne(
          { userId: new ObjectId(userId) },
          { $set: { cookies, updatedAt: new Date() } },
          { upsert: true }
        );
      } catch (e) {}
    }
  }
}
const sessionManager = new SessionManager();

class BrowserContextPool {
  constructor(browser, size = 3) {
    this.browser = browser;
    this.size = size;
    this.available = [];
    this.inUse = new Map();
  }
  ua() {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  }
  async create(proxy = null) {
    const opts = {
      ignoreHTTPSErrors: true,
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      userAgent: this.ua(),
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    };
    if (proxy?.url) opts.proxy = { server: proxy.url };
    const context = await this.browser.newContext(opts);
    const page = await context.newPage();
    await page.addInitScript(StealthGenerator.script());
    return { context, page, createdAt: Date.now(), usage: 0, proxy, pool: this };
  }
  async init() {
    for (let i = 0; i < this.size; i++) this.available.push(await this.create(null));
  }
  async get(proxy = null) {
    if (this.available.length) {
      const ctx = this.available.pop();
      if (proxy && ctx.proxy?.url !== proxy.url) {
        this.close(ctx);
        const fresh = await this.create(proxy);
        this.inUse.set(fresh, true);
        return fresh;
      }
      this.inUse.set(ctx, true);
      return ctx;
    }
    const fresh = await this.create(proxy);
    this.inUse.set(fresh, true);
    return fresh;
  }
  release(ctx) {
    if (!ctx) return;
    this.inUse.delete(ctx);
    if (Date.now() - ctx.createdAt > 45 * 60 * 1000 || ctx.usage > 30) {
      this.close(ctx);
      return;
    }
    ctx.usage++;
    this.available.push(ctx);
  }
  close(ctx) {
    try {
      ctx.page?.close?.().catch(() => {});
      ctx.context?.close?.().catch(() => {});
    } catch (e) {}
  }
  async closeAll() {
    for (const c of this.available) this.close(c);
    for (const c of this.inUse.keys()) this.close(c);
  }
}

class BrowserPool {
  constructor(n = 2) {
    this.n = n;
    this.browsers = [];
    this.pools = [];
  }
  async init() {
    for (let i = 0; i < this.n; i++) {
      const browser = await chromium.launch({
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-gpu',
          '--window-size=1920,1080'
        ],
        timeout: 30000
      });
      this.browsers.push(browser);
      const pool = new BrowserContextPool(browser, 3);
      await pool.init();
      this.pools.push(pool);
    }
    logger.info({ browsers: this.n }, '✅ Browser pool ready');
  }
  async get(proxy = null) {
    if (!this.pools.length) throw new Error('No browser pools');
    return this.pools[Math.floor(Math.random() * this.pools.length)].get(proxy);
  }
  release(ctx) {
    if (ctx?.pool) ctx.pool.release(ctx);
  }
  async closeAll() {
    await Promise.all(this.pools.map((p) => p.closeAll()));
    await Promise.all(this.browsers.map((b) => b.close().catch(() => {})));
  }
}
let browserPool = null;

async function gentleInteract(page) {
  try {
    await page.waitForTimeout(400 + Math.random() * 600);
    await page.evaluate(() => window.scrollBy({ top: 300, behavior: 'smooth' }));
    await page.waitForTimeout(400);
  } catch (e) {}
}

async function tryClickPlay(page) {
  const selectors = [
    'button[aria-label*="Play" i]',
    '.vjs-big-play-button',
    '.plyr__control--overlaid',
    '.jw-icon-display',
    'button.play',
    'video'
  ];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      await el.click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(600);
      return true;
    } catch (e) {}
  }
  return false;
}

/**
 * SearchProvider v3.2 — API first (no brittle HTML scraping)
 */
class SearchProvider {
  add(map, item) {
    const url = item.url;
    if (!url || !/^https?:\/\//i.test(url)) return;
    if (/duckduckgo\.com|google\.[a-z.]+\/search|bing\.com\/search|wikipedia\.org\/w\/api/i.test(url)) return;
    const score =
      (item.score ?? titleSimilarity(item.query || '', item.title || item.name || '')) + (item.boost || 0);
    const prev = map.get(url);
    if (!prev || score > prev.score) {
      map.set(url, {
        name: item.name || item.title || url,
        title: item.title || item.name || url,
        url,
        score,
        source: item.source || 'unknown',
        type: item.type || 'link',
        year: item.year || null,
        overview: item.overview || null
      });
    }
  }

  async searchDuckDuckGoAPI(query, map) {
    try {
      const { data } = await httpClient.get('https://api.duckduckgo.com/', {
        params: { q: query, format: 'json', no_redirect: 1, no_html: 1, skip_disambig: 1 }
      });
      if (data?.Heading && data?.AbstractURL) {
        this.add(map, {
          name: data.Heading,
          title: data.Heading,
          url: data.AbstractURL,
          source: 'ddg-api',
          type: 'abstract',
          overview: data.Abstract || null,
          query,
          boost: 0.15
        });
      }
      const topics = [...(data?.RelatedTopics || [])];
      for (const t of topics) {
        if (t.Topics) {
          for (const sub of t.Topics) {
            if (sub.FirstURL && sub.Text) {
              this.add(map, {
                name: sub.Text.split(' - ')[0].slice(0, 120),
                title: sub.Text.slice(0, 160),
                url: sub.FirstURL,
                source: 'ddg-api',
                type: 'related',
                query,
                boost: 0.05
              });
            }
          }
        } else if (t.FirstURL && t.Text) {
          this.add(map, {
            name: t.Text.split(' - ')[0].slice(0, 120),
            title: t.Text.slice(0, 160),
            url: t.FirstURL,
            source: 'ddg-api',
            type: 'related',
            query,
            boost: 0.05
          });
        }
      }
      if (data?.Results?.length) {
        for (const r of data.Results) {
          if (r.FirstURL && r.Text) {
            this.add(map, {
              name: r.Text.slice(0, 120),
              title: r.Text.slice(0, 160),
              url: r.FirstURL,
              source: 'ddg-api',
              type: 'result',
              query,
              boost: 0.08
            });
          }
        }
      }
    } catch (e) {
      logger.warn({ error: e.message }, 'DDG API search failed');
    }
  }

  async searchWikipedia(query, map) {
    try {
      const { data } = await httpClient.get('https://en.wikipedia.org/w/api.php', {
        params: { action: 'opensearch', search: query, limit: 10, namespace: 0, format: 'json' }
      });
      const titles = data?.[1] || [];
      const descs = data?.[2] || [];
      const urls = data?.[3] || [];
      for (let i = 0; i < titles.length; i++) {
        this.add(map, {
          name: titles[i],
          title: descs[i] ? `${titles[i]} — ${descs[i]}` : titles[i],
          url: urls[i],
          source: 'wikipedia',
          type: 'wiki',
          query,
          boost: 0.12
        });
      }
      if (/[\u0600-\u06FF]/.test(query)) {
        const ar = await httpClient.get('https://ar.wikipedia.org/w/api.php', {
          params: { action: 'opensearch', search: query, limit: 8, namespace: 0, format: 'json' }
        });
        const t2 = ar.data?.[1] || [];
        const d2 = ar.data?.[2] || [];
        const u2 = ar.data?.[3] || [];
        for (let i = 0; i < t2.length; i++) {
          this.add(map, {
            name: t2[i],
            title: d2[i] ? `${t2[i]} — ${d2[i]}` : t2[i],
            url: u2[i],
            source: 'wikipedia-ar',
            type: 'wiki',
            query,
            boost: 0.12
          });
        }
      }
    } catch (e) {
      logger.warn({ error: e.message }, 'Wikipedia search failed');
    }
  }

  async searchTMDB(query, map) {
    if (!TMDB_API_KEY) return;
    try {
      const { data } = await httpClient.get('https://api.themoviedb.org/3/search/multi', {
        params: {
          api_key: TMDB_API_KEY,
          query,
          include_adult: false,
          language: 'en-US',
          page: 1
        }
      });
      for (const item of data?.results || []) {
        if (item.media_type !== 'movie' && item.media_type !== 'tv') continue;
        const name = item.title || item.name;
        const year = (item.release_date || item.first_air_date || '').slice(0, 4) || null;
        const tmdbUrl =
          item.media_type === 'movie'
            ? `https://www.themoviedb.org/movie/${item.id}`
            : `https://www.themoviedb.org/tv/${item.id}`;
        this.add(map, {
          name: year ? `${name} (${year})` : name,
          title: item.overview ? `${name} — ${String(item.overview).slice(0, 120)}` : name,
          url: tmdbUrl,
          source: 'tmdb',
          type: item.media_type,
          year,
          overview: item.overview || null,
          query,
          boost: 0.2
        });
      }
    } catch (e) {
      logger.warn({ error: e.message }, 'TMDB search failed');
    }
  }

  async searchBrowserBing(query, page, map) {
    if (!page) return;
    try {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(query + ' series OR movie')}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.waitForTimeout(2000);
      const links = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('li.b_algo h2 a, h2 a').forEach((a) => {
          const title = (a.textContent || '').trim();
          const href = a.href;
          if (title && href && href.startsWith('http')) out.push({ title: title.slice(0, 160), url: href });
        });
        return out.slice(0, 15);
      });
      for (const l of links) {
        this.add(map, {
          name: l.title,
          title: l.title,
          url: l.url,
          source: 'bing',
          type: 'web',
          query,
          boost: 0.03
        });
      }
    } catch (e) {
      logger.warn({ error: e.message }, 'Bing browser search failed');
    }
  }

  async searchByName(query, page = null) {
    const q = String(query || '').trim();
    if (!q) return [];

    const map = new Map();

    await Promise.all([
      this.searchDuckDuckGoAPI(q, map),
      this.searchDuckDuckGoAPI(`${q} TV series`, map),
      this.searchWikipedia(q, map),
      this.searchTMDB(q, map)
    ]);

    if (map.size < 3 && page) {
      await this.searchBrowserBing(q, page, map);
    }

    let results = [...map.values()].sort((a, b) => b.score - a.score);
    const strong = results.filter((r) => r.score >= 0.15);
    if (strong.length >= 2) results = strong;

    return results.slice(0, 15).map((r, i) => ({
      rank: i + 1,
      name: r.name,
      title: r.title,
      url: r.url,
      matchScore: Math.round(r.score * 1000) / 1000,
      source: r.source,
      type: r.type,
      year: r.year,
      overview: r.overview
    }));
  }
}

class VideoExtractor {
  constructor() {
    this.name = 'vd-pro';
  }

  empty() {
    return { m3u8: new Set(), mp4: new Set(), webm: new Set(), mpd: new Set(), other: new Set() };
  }

  add(bags, url, ct = '') {
    if (!url || url.startsWith('blob:')) return;
    const k = classifyMedia(url, ct);
    if (k) bags[k].add(url);
    else if (looksLikeMedia(url, ct)) bags.other.add(url);
  }

  toObj(bags, base) {
    const abs = (arr) => [...new Set([...arr].map((u) => resolveUrl(base, u)).filter(Boolean))];
    return {
      m3u8: abs(bags.m3u8),
      mp4: abs(bags.mp4),
      webm: abs(bags.webm),
      mpd: abs(bags.mpd),
      other: abs(bags.other)
    };
  }

  async extract(pageUrl, page, userId, options = {}) {
    const quality = options.quality || 'auto';
    const deep = !!options.deep;
    const started = Date.now();
    const diagnostics = {
      framesVisited: 0,
      requestsObserved: 0,
      mediaRequests: 0,
      playClicked: false,
      strategies: []
    };
    const result = {
      success: false,
      primaryUrl: null,
      urls: { m3u8: [], mp4: [], webm: [], mpd: [], other: [] },
      variants: [],
      duration: 0,
      strategy: null,
      quality,
      validated: false,
      error: null,
      errorCode: null,
      diagnostics,
      source: this.name,
      pageTitle: null
    };

    const bags = this.empty();
    const onResponse = async (response) => {
      try {
        diagnostics.requestsObserved++;
        const u = response.url();
        const ct = response.headers()['content-type'] || '';
        if (looksLikeMedia(u, ct)) {
          diagnostics.mediaRequests++;
          this.add(bags, u, ct);
        }
      } catch (e) {}
    };
    page.on('response', onResponse);

    try {
      const cookies = await sessionManager.load(userId);
      if (cookies?.length) {
        try {
          await page.context().addCookies(cookies);
        } catch (e) {}
      }

      try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 50000 });
      } catch (e) {
        diagnostics.navWarning = e.message;
      }

      try {
        result.pageTitle = await page.title();
      } catch (e) {}

      await gentleInteract(page);
      diagnostics.playClicked = await tryClickPlay(page);
      await page.waitForTimeout(deep ? 5500 : 3200);
      diagnostics.strategies.push('network');

      try {
        const html = await page.content();
        const $ = cheerio.load(html);
        $('video, source, [data-src], [data-video], [data-url], [data-stream]').each((_, el) => {
          for (const attr of ['src', 'data-src', 'data-video', 'data-url', 'data-stream']) {
            const v = $(el).attr(attr);
            if (v) this.add(bags, resolveUrl(pageUrl, v) || v);
          }
        });
        diagnostics.strategies.push('dom');
        const rules = [
          [/(https?:\/\/[^"'\\s<>{}]+?\.m3u8[^"'\\s<>{}]*)/gi, 'm3u8'],
          [/(https?:\/\/[^"'\\s<>{}]+?\.mp4[^"'\\s<>{}]*)/gi, 'mp4'],
          [/(https?:\/\/[^"'\\s<>{}]+?\.mpd[^"'\\s<>{}]*)/gi, 'mpd']
        ];
        for (const [re, key] of rules) {
          let m;
          while ((m = re.exec(html)) !== null) bags[key].add(m[1]);
        }
        diagnostics.strategies.push('script');
      } catch (e) {}

      if (deep || diagnostics.mediaRequests < 1) {
        try {
          for (const frame of page.frames().slice(0, 12)) {
            try {
              const html = await frame.content();
              const $ = cheerio.load(html);
              $('video, source, [data-src]').each((_, el) => {
                const src = $(el).attr('src') || $(el).attr('data-src');
                if (src) this.add(bags, resolveUrl(pageUrl, src) || src);
              });
            } catch (e) {}
          }
          diagnostics.strategies.push('frames');
        } catch (e) {}
      }

      page.off('response', onResponse);
      result.urls = this.toObj(bags, pageUrl);

      const variants = [];
      for (const m of result.urls.m3u8.slice(0, 5)) {
        const en = await HLSParser.enrich(m);
        if (en.variants?.length) variants.push(...en.variants);
        else variants.push({ url: m, quality: 'unknown', bandwidth: 0 });
      }
      for (const m of result.urls.mp4) variants.push({ url: m, quality: 'mp4', bandwidth: 0 });
      for (const m of result.urls.webm) variants.push({ url: m, quality: 'webm', bandwidth: 0 });
      for (const m of result.urls.mpd) variants.push({ url: m, quality: 'dash', bandwidth: 0 });
      variants.sort((a, b) => rankScore(b.url) - rankScore(a.url));
      result.variants = variants.slice(0, 20);

      const picked = pickByQuality(result.variants, quality);
      if (picked?.url) {
        result.primaryUrl = picked.url;
        result.success = true;
        result.strategy = diagnostics.strategies.join('+');
        const v = await ResultValidator.validate(result.primaryUrl);
        result.validated = v.valid;
        if (!v.valid) result.validationReason = v.reason;
      } else {
        result.error = 'No video streams found';
        result.errorCode = 'NO_STREAM_FOUND';
      }

      try {
        const c = await page.context().cookies();
        if (c.length) await sessionManager.save(userId, c);
      } catch (e) {}

      diagnostics.framesVisited = page.frames().length;
      result.duration = (Date.now() - started) / 1000;
      result.diagnostics = diagnostics;
      return result;
    } catch (error) {
      try {
        page.off('response', onResponse);
      } catch (e) {}
      result.error = error.message;
      result.errorCode = 'EXTRACTION_ERROR';
      result.duration = (Date.now() - started) / 1000;
      result.diagnostics = diagnostics;
      return result;
    }
  }
}

class ResultValidator {
  static async validate(url) {
    if (!url) return { valid: false, reason: 'NO_URL' };
    try {
      new URLParser(url);
    } catch (e) {
      return { valid: false, reason: 'INVALID_URL' };
    }
    try {
      const res = await axios.get(url, {
        timeout: 12000,
        maxRedirects: 4,
        maxContentLength: 300000,
        validateStatus: () => true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Range: 'bytes=0-16384'
        }
      });
      if (res.status < 200 || res.status >= 400) return { valid: false, reason: 'INVALID_STATUS' };
      if (url.includes('.m3u8') && !String(res.data || '').includes('#EXTM3U')) {
        return { valid: false, reason: 'INVALID_M3U8' };
      }
      return { valid: true };
    } catch (e) {
      return { valid: false, reason: 'VALIDATION_FAILED' };
    }
  }
}

class CacheManager {
  constructor() {
    this.l1 = new Map();
    this.max = 120;
  }
  key(url, quality, deep) {
    return crypto.createHash('sha256').update(`${url}::${quality}::${deep ? 1 : 0}`).digest('hex');
  }
  _set(k, v) {
    if (this.l1.size >= this.max) this.l1.delete(this.l1.keys().next().value);
    this.l1.set(k, v);
  }
  async get(url, quality = 'auto', deep = false) {
    const k = this.key(url, quality, deep);
    if (this.l1.has(k)) {
      metrics.cacheHits.labels('l1').inc();
      return this.l1.get(k);
    }
    try {
      const raw = await redis.get(`cache:${k}`);
      if (raw) {
        metrics.cacheHits.labels('l2').inc();
        const p = JSON.parse(raw);
        this._set(k, p);
        return p;
      }
    } catch (e) {}
    return null;
  }
  async set(url, data, quality = 'auto', deep = false, ttl = 259200) {
    const k = this.key(url, quality, deep);
    this._set(k, data);
    try {
      await redis.setex(`cache:${k}`, Math.min(ttl, 86400), JSON.stringify(data));
    } catch (e) {}
  }
}
const cacheManager = new CacheManager();

class SingleFlight {
  constructor() {
    this.map = new Map();
  }
  h(k) {
    return crypto.createHash('sha256').update(k).digest('hex');
  }
  get(k) {
    return this.map.get(this.h(k));
  }
  set(k, p) {
    const id = this.h(k);
    this.map.set(id, p);
    setTimeout(() => this.map.delete(id), 300000);
  }
  del(k) {
    if (k) this.map.delete(this.h(k));
  }
}
const singleFlight = new SingleFlight();

class CircuitBreaker {
  constructor() {
    this.state = 'CLOSED';
    this.fails = 0;
    this.ok = 0;
    this.next = 0;
  }
  async run(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.next) throw new Error('Circuit breaker OPEN');
      this.state = 'HALF_OPEN';
    }
    try {
      const r = await fn();
      this.fails = 0;
      if (this.state === 'HALF_OPEN') {
        this.ok++;
        if (this.ok >= 2) {
          this.state = 'CLOSED';
          this.ok = 0;
        }
      }
      return r;
    } catch (e) {
      this.fails++;
      this.ok = 0;
      if (this.fails >= 5) {
        this.state = 'OPEN';
        this.next = Date.now() + 60000;
      }
      throw e;
    }
  }
}
const circuitBreaker = new CircuitBreaker();

const extractionQueue = new Queue('vd-pro-extraction', REDIS_URL, {
  settings: {
    stalledInterval: 15000,
    maxStalledCount: 2,
    lockDuration: 150000,
    lockRenewTime: 70000
  }
});

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
if (ALLOWED_ORIGINS.length) app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
else app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    try {
      metrics.httpDuration
        .labels(req.method, req.route?.path || req.path, res.statusCode)
        .observe((Date.now() - t0) / 1000);
    } catch (e) {}
  });
  next();
});

const verifyToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, error: 'No token', code: 'NO_TOKEN' });
    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    if (db) {
      const user = await db.collection('users').findOne({ apiKey: decoded.apiKey });
      if (!user) return res.status(403).json({ success: false, error: 'User not found', code: 'USER_NOT_FOUND' });
      req.user = user;
    } else {
      req.user = { _id: decoded.apiKey, plan: 'free', apiKey: decoded.apiKey };
    }
    next();
  } catch (e) {
    return res.status(403).json({ success: false, error: 'Invalid token', code: 'INVALID_TOKEN' });
  }
};

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const id = req.user?._id?.toString?.() || req.user?._id;
    return id ? `u:${id}` : `ip:${req.ip}`;
  }
});
app.use('/api/v1/', limiter);

app.get('/api/v1/health', (req, res) => {
  res.json({
    status: 'healthy',
    name: 'Vd-Pro',
    version: '3.2.0',
    redis: redis.status,
    mongodb: db ? 'connected' : 'disconnected',
    search: {
      ddgApi: true,
      wikipedia: true,
      tmdb: !!TMDB_API_KEY,
      browserFallback: true
    },
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/v1/metrics', (req, res) => {
  res.set('Content-Type', prometheus.register.contentType);
  res.end(prometheus.register.metrics());
});

app.post('/api/v1/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ success: false, error: 'Missing fields', code: 'MISSING_FIELDS' });
    if (String(password).length < 8)
      return res.status(400).json({ success: false, error: 'Weak password', code: 'WEAK_PASSWORD' });
    if (!db) return res.status(503).json({ success: false, error: 'DB unavailable', code: 'DB_UNAVAILABLE' });
    const normalized = String(email).trim().toLowerCase();
    if (await db.collection('users').findOne({ email: normalized })) {
      return res.status(400).json({ success: false, error: 'Email exists', code: 'EMAIL_EXISTS' });
    }
    const apiKey = crypto.randomBytes(32).toString('hex');
    const hashed = await bcrypt.hash(password, 12);
    await db.collection('users').insertOne({
      email: normalized,
      password: hashed,
      apiKey,
      plan: 'free',
      createdAt: new Date()
    });
    const token = jwt.sign({ apiKey }, EFFECTIVE_JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ success: true, apiKey, token, plan: 'free' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Register failed', code: 'REGISTER_ERROR' });
  }
});

app.get('/api/v1/extract', verifyToken, async (req, res) => {
  try {
    const { url, quality = 'auto', deep } = req.query;
    if (!url) return res.status(400).json({ success: false, error: 'URL required', code: 'MISSING_URL' });
    const v = await SSRFValidator.validate(url);
    if (!v.valid) return res.status(400).json({ success: false, error: v.reason, code: 'INVALID_URL' });
    const deepFlag = deep === '1' || deep === 'true';
    const cached = await cacheManager.get(url, quality, deepFlag);
    if (cached) return res.json({ success: true, fromCache: true, ...cached });
    const flightKey = `ex:${url}::${quality}::${deepFlag ? 1 : 0}`;
    if (singleFlight.get(flightKey))
      return res.status(202).json({ success: true, message: 'Processing', dedup: true });
    const userId = req.user._id?.toString?.() || String(req.user._id);
    const job = await extractionQueue.add(
      { type: 'extract', url, userId, quality, deep: deepFlag },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2500 },
        priority: req.user.plan === 'enterprise' ? 1 : 10,
        timeout: EXTRACT_TIMEOUT_MS + 30000,
        removeOnComplete: 100,
        removeOnFail: 50
      }
    );
    singleFlight.set(flightKey, job.finished().catch(() => null));
    res.status(202).json({ success: true, jobId: job.id, statusUrl: `/api/v1/jobs/${job.id}` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, code: 'EXTRACT_ERROR' });
  }
});

app.get('/api/v1/search', verifyToken, async (req, res) => {
  try {
    const { q, extract, quality = 'auto', deep } = req.query;
    if (!q || !String(q).trim()) {
      return res.status(400).json({ success: false, error: 'Query required (q=name)', code: 'MISSING_QUERY' });
    }
    const userId = req.user._id?.toString?.() || String(req.user._id);
    const doExtract = extract === '1' || extract === 'true';
    const job = await extractionQueue.add(
      {
        type: doExtract ? 'search_extract' : 'search',
        search: String(q).trim(),
        userId,
        quality,
        deep: deep === '1' || deep === 'true'
      },
      {
        attempts: 2,
        backoff: { type: 'exponential', delay: 2000 },
        timeout: doExtract ? EXTRACT_TIMEOUT_MS + 60000 : 60000,
        removeOnComplete: 50,
        removeOnFail: 20
      }
    );
    res.status(202).json({
      success: true,
      jobId: job.id,
      query: String(q).trim(),
      mode: doExtract ? 'search_and_extract' : 'search_only',
      statusUrl: `/api/v1/jobs/${job.id}`
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, code: 'SEARCH_ERROR' });
  }
});

app.get('/api/v1/jobs/:jobId', verifyToken, async (req, res) => {
  try {
    const job = await extractionQueue.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found', code: 'JOB_NOT_FOUND' });
    const userId = req.user._id?.toString?.() || String(req.user._id);
    if (job.data?.userId && String(job.data.userId) !== userId) {
      return res.status(403).json({ success: false, error: 'Forbidden', code: 'JOB_FORBIDDEN' });
    }
    const state = await job.getState();
    let result = null;
    if (state === 'completed') {
      result = job.returnvalue ?? job._returnvalue ?? null;
      if (!result) {
        try {
          result = await job.finished();
        } catch (e) {}
      }
    }
    res.json({
      success: true,
      jobId: job.id,
      state,
      result,
      attemptsMade: job.attemptsMade || 0,
      attempts: job.opts?.attempts || 3,
      failedReason: state === 'failed' ? job.failedReason || null : null
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, code: 'JOB_ERROR' });
  }
});

app.get('/api/v1/proxy-status', verifyToken, (req, res) => {
  res.json({
    success: true,
    proxies: proxyManager.status(),
    total: proxyManager.proxies.length,
    available: proxyManager.proxies.filter((p) => p.health.available).length
  });
});

app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup({
    openapi: '3.0.0',
    info: { title: 'Vd-Pro API', version: '3.2.0' },
    paths: {
      '/search': { get: { summary: 'Search by name (API-first)' } },
      '/extract': { get: { summary: 'Extract from URL' } },
      '/jobs/{id}': { get: { summary: 'Job status' } }
    }
  })
);

extractionQueue.process(4, async (job) => {
  let ctx = null;
  let proxy = null;
  try {
    const userId = job.data.userId;
    const sp = new SearchProvider();

    if (job.data.type === 'search') {
      let results = await sp.searchByName(job.data.search, null);
      if (results.length < 2) {
        proxy = proxyManager.getNext();
        ctx = await browserPool.get(proxy);
        results = await sp.searchByName(job.data.search, ctx.page);
      }
      return {
        success: results.length > 0,
        query: job.data.search,
        results,
        count: results.length,
        providers: ['ddg-api', 'wikipedia', TMDB_API_KEY ? 'tmdb' : null, 'bing-fallback'].filter(Boolean),
        message: results.length ? undefined : 'No matching results for this name'
      };
    }

    if (job.data.type === 'search_extract') {
      proxy = proxyManager.getNext();
      ctx = await browserPool.get(proxy);
      const page = ctx.page;
      const results = await sp.searchByName(job.data.search, page);
      if (!results.length) {
        return {
          success: false,
          query: job.data.search,
          results: [],
          count: 0,
          error: 'No search results',
          errorCode: 'NO_SEARCH_RESULTS'
        };
      }
      const preferred =
        results.find((r) => !/wikipedia\.org|themoviedb\.org/i.test(r.url)) || results[0];
      const extractor = new VideoExtractor();
      const extraction = await circuitBreaker.run(() =>
        extractor.extract(preferred.url, page, userId, {
          quality: job.data.quality || 'auto',
          deep: job.data.deep
        })
      );
      return {
        success: !!extraction.success,
        query: job.data.search,
        matchedName: preferred.name,
        matchedUrl: preferred.url,
        matchScore: preferred.matchScore,
        searchResults: results.slice(0, 10),
        extraction
      };
    }

    proxy = proxyManager.getNext();
    ctx = await browserPool.get(proxy);
    const { page } = ctx;
    const extractor = new VideoExtractor();
    const result = await circuitBreaker.run(() =>
      extractor.extract(job.data.url, page, userId, {
        quality: job.data.quality || 'auto',
        deep: job.data.deep
      })
    );

    metrics.extractionDuration.labels(result.success ? 'success' : 'failure').observe(result.duration || 0);
    if (result.success) {
      metrics.sourceSuccess.inc();
      proxyManager.success(proxy);
      await cacheManager.set(job.data.url, result, job.data.quality || 'auto', !!job.data.deep);
      if (db) {
        try {
          await db.collection('extractions').updateOne(
            { jobId: String(job.id) },
            {
              $set: {
                jobId: String(job.id),
                userId: ObjectId.isValid(userId) ? new ObjectId(userId) : userId,
                url: job.data.url,
                result,
                createdAt: new Date()
              }
            },
            { upsert: true }
          );
        } catch (e) {}
      }
    } else {
      metrics.sourceFailure.labels(result.errorCode || 'unknown').inc();
      proxyManager.fail(proxy);
    }
    singleFlight.del(`ex:${job.data.url}::${job.data.quality || 'auto'}::${job.data.deep ? 1 : 0}`);
    return result;
  } catch (error) {
    logger.error({ jobId: job.id, error: error.message }, 'Job failed');
    proxyManager.fail(proxy);
    if (/timeout|net::|Circuit breaker|Target closed/i.test(error.message || '')) throw error;
    return { success: false, error: error.message, errorCode: 'JOB_EXCEPTION' };
  } finally {
    if (ctx) browserPool.release(ctx);
  }
});

const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', async (ws, req) => {
  let uid = null;
  try {
    const u = new URL(req.url || '', `http://${req.headers.host}`);
    const token = u.searchParams.get('token');
    if (!token) return ws.close(4401, 'Unauthorized');
    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    if (db) {
      const user = await db.collection('users').findOne({ apiKey: decoded.apiKey });
      if (!user) return ws.close(4403, 'Forbidden');
      uid = user._id.toString();
    } else uid = decoded.apiKey;
  } catch (e) {
    return ws.close(4401, 'Unauthorized');
  }
  ws.on('message', async (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type !== 'job_status' || !data.jobId) return;
      const job = await extractionQueue.getJob(data.jobId);
      if (!job) return ws.send(JSON.stringify({ type: 'error', message: 'Not found' }));
      if (job.data?.userId && String(job.data.userId) !== uid) {
        return ws.send(JSON.stringify({ type: 'error', message: 'Forbidden' }));
      }
      const state = await job.getState();
      const result = state === 'completed' ? job.returnvalue || job._returnvalue || null : null;
      ws.send(JSON.stringify({ type: 'job_update', jobId: data.jobId, state, result }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  });
});

async function shutdown() {
  try {
    await new Promise((r) => httpServer.close(r));
    await browserPool?.closeAll();
    await redis.quit();
    await extractionQueue.close();
    if (mongoClient) await mongoClient.close();
    wss.close();
    process.exit(0);
  } catch (e) {
    process.exit(1);
  }
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

(async () => {
  try {
    logger.info('🚀 Vd-Pro v3.2 starting...');
    await connectDatabase();
    browserPool = new BrowserPool(2);
    await browserPool.init();
    httpServer.listen(PORT, '0.0.0.0', () => {
      logger.info(`Vd-Pro v3.2 on :${PORT}`);
      console.log(`
╔══════════════════════════════════════════════════════════╗
║  VD-PRO v3.2 — SEARCH FIXED                              ║
║  ✓ DuckDuckGo Instant Answer API                         ║
║  ✓ Wikipedia OpenSearch (EN + AR)                        ║
║  ✓ TMDB (optional TMDB_API_KEY)                          ║
║  ✓ Bing browser fallback                                 ║
║  GET /api/v1/search?q=Silo                               ║
║  GET /api/v1/search?q=Silo&extract=1                     ║
╚══════════════════════════════════════════════════════════╝
`);
    });
  } catch (e) {
    logger.error({ error: e.message }, 'Startup failed');
    process.exit(1);
  }
})();

export default app;
