/**
 * Vd-Pro Ultra v4.0 — Maximum legitimate extraction strength
 *
 * Power features:
 * - Pre-navigation network + response capture
 * - In-page hooks: fetch, XHR, MediaSource, HTMLMediaElement
 * - Multi-frame play + video.currentSrc / srcObject
 * - Generic player JSON / config URL mining
 * - Adaptive deep mode (longer waits, second pass)
 * - HLS master variant parse + ranking
 * - API-first name search (DDG + Wikipedia + optional TMDB)
 * - Security: JWT, job ownership, SSRF, WS auth
 *
 * Reality: DRM, interactive CAPTCHA, and private paywalled streams
 * cannot be reliably extracted. Ultra maximizes open/HTML5/HLS capture.
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
const EXTRACT_TIMEOUT_MS = parseInt(process.env.EXTRACT_TIMEOUT_MS || '120000', 10);

if (NODE_ENV === 'production' && (!JWT_SECRET || JWT_SECRET.length < 32)) {
  console.error('FATAL: JWT_SECRET must be set and at least 32 characters in production');
  process.exit(1);
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'dev-only-secret-change-me-in-production-min-32-chars';
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const metrics = {
  httpDuration: new prometheus.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60]
  }),
  extractionDuration: new prometheus.Histogram({
    name: 'extraction_duration_seconds',
    help: 'Extract',
    labelNames: ['status'],
    buckets: [5, 10, 20, 30, 45, 60, 90, 120, 180]
  }),
  sourceSuccess: new prometheus.Counter({ name: 'source_success_total', help: 'ok' }),
  sourceFailure: new prometheus.Counter({ name: 'source_failure_total', help: 'fail', labelNames: ['reason'] }),
  cacheHits: new prometheus.Counter({ name: 'cache_hits_total', help: 'cache', labelNames: ['level'] })
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
      db.collection('extractions').createIndex({ jobId: 1 }, { unique: true }),
      db.collection('users').createIndex({ apiKey: 1 }, { unique: true }),
      db.collection('users').createIndex({ email: 1 }, { unique: true }),
      db.collection('cache').createIndex({ contentHash: 1 }, { unique: true }),
      db.collection('sessions').createIndex({ userId: 1 })
    ]);
    logger.info('✅ MongoDB connected');
    return true;
  } catch (e) {
    logger.error({ error: e.message }, 'MongoDB failed');
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
redis.on('error', (e) => logger.warn({ error: e.message }, 'Redis'));
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
        for (const a of await dns.resolve4(url.hostname)) if (this.isPrivate(a)) return { valid: false, reason: 'Private IPv4' };
      } catch (e) {}
      try {
        for (const a of await dns.resolve6(url.hostname)) if (this.isPrivate(a)) return { valid: false, reason: 'Private IPv6' };
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
  const u = (url || '').toLowerCase();
  const c = (ct || '').toLowerCase();
  if (/\.(m3u8|mp4|webm|mpd|m4s|ts)(\?|#|$)/i.test(u)) return true;
  if (/\/hls\/|\/dash\/|\/stream\/|manifest|playlist|master\.json|play\./i.test(u)) return true;
  if (c.includes('mpegurl') || c.includes('dash+xml') || c.startsWith('video/') || c.includes('application/vnd.apple')) return true;
  return false;
}

function classifyMedia(url = '', ct = '') {
  const u = (url || '').toLowerCase();
  const c = (ct || '').toLowerCase();
  if (u.includes('.m3u8') || c.includes('mpegurl') || c.includes('vnd.apple')) return 'm3u8';
  if (u.includes('.mpd') || c.includes('dash+xml')) return 'mpd';
  if (u.includes('.webm') || c.includes('webm')) return 'webm';
  if (u.includes('.mp4') || c.includes('mp4') || c.startsWith('video/')) return 'mp4';
  if (looksLikeMedia(url, ct)) return 'm3u8';
  return null;
}

function rankScore(url) {
  const u = (url || '').toLowerCase();
  let s = 0;
  if (u.includes('.mp4')) s += 55;
  if (u.includes('.m3u8')) s += 45;
  if (u.includes('.mpd')) s += 40;
  if (/1080|1920|2160|4k/.test(u)) s += 25;
  if (/720/.test(u)) s += 14;
  if (/480|360/.test(u)) s += 4;
  if (/preview|trailer|thumb|poster|sample/.test(u)) s -= 20;
  if (u.startsWith('blob:')) s -= 50;
  return s;
}

function pickByQuality(variants, quality = 'auto') {
  if (!variants?.length) return null;
  if (!quality || quality === 'auto') return [...variants].sort((a, b) => rankScore(b.url) - rankScore(a.url))[0];
  const q = String(quality).toLowerCase();
  return variants.find((v) => (v.quality || '').toLowerCase().includes(q) || (v.url || '').toLowerCase().includes(q)) || variants[0];
}

function titleSimilarity(a, b) {
  const na = String(a || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const nb = String(b || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
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
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: 'application/json, text/html, */*'
  },
  validateStatus: (s) => s >= 200 && s < 400
});

class HLSParser {
  static async fetchText(url) {
    const res = await httpClient.get(url, { maxContentLength: 2_500_000, headers: { Accept: '*/*' } });
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
        quality = h >= 2160 ? '2160p' : h >= 1080 ? '1080p' : h >= 720 ? '720p' : h >= 480 ? '480p' : `${h}p`;
      }
      variants.push({ url: abs, bandwidth: bw ? parseInt(bw[1], 10) : 0, resolution: res?.[1] || null, quality: quality || 'unknown' });
    }
    return variants;
  }
  static async enrich(m3u8Url) {
    try {
      const text = await this.fetchText(m3u8Url);
      if (!text.includes('#EXTM3U')) return { variants: [] };
      if (text.includes('#EXT-X-STREAM-INF')) return { variants: this.parseMaster(text, m3u8Url) };
      return { variants: [{ url: m3u8Url, quality: 'media', bandwidth: 0 }] };
    } catch (e) {
      return { variants: [] };
    }
  }
}

/** Injected before any page JS — captures media URLs from the page itself */
const PAGE_HOOK_SCRIPT = `
(function(){
  if (window.__vdProHooks) return;
  window.__vdProHooks = true;
  window.__vdCaptured = window.__vdCaptured || [];
  function push(u, why){
    try {
      if (!u || typeof u !== 'string') return;
      if (u.indexOf('http') !== 0 && u.indexOf('blob:') !== 0 && u.indexOf('//') !== 0) return;
      if (u.indexOf('//') === 0) u = location.protocol + u;
      window.__vdCaptured.push({ url: u, why: why || 'hook', t: Date.now() });
    } catch(e){}
  }
  try {
    const ofetch = window.fetch;
    window.fetch = function(){
      try {
        const a = arguments[0];
        const u = typeof a === 'string' ? a : (a && a.url);
        if (u) push(String(u), 'fetch');
      } catch(e){}
      return ofetch.apply(this, arguments);
    };
  } catch(e){}
  try {
    const xo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url){
      try { if (url) push(String(url), 'xhr'); } catch(e){}
      return xo.apply(this, arguments);
    };
  } catch(e){}
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (desc && desc.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        set: function(v){ push(String(v), 'media.src'); return desc.set.call(this, v); },
        get: function(){ return desc.get.call(this); },
        configurable: true
      });
    }
  } catch(e){}
  try {
    const os = HTMLMediaElement.prototype.setAttribute;
    HTMLMediaElement.prototype.setAttribute = function(n, v){
      if (String(n).toLowerCase() === 'src') push(String(v), 'media.attr');
      return os.apply(this, arguments);
    };
  } catch(e){}
  try {
    if (window.MediaSource) {
      const add = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function(mime){
        try { push(String(mime), 'mse.mime'); } catch(e){}
        return add.apply(this, arguments);
      };
    }
  } catch(e){}
})();
`;

class StealthGenerator {
  static script() {
    return `
(function(){
  Object.defineProperty(navigator,'webdriver',{get:()=>false});
  try{delete navigator.__proto__.webdriver}catch(e){}
  Object.defineProperty(navigator,'languages',{get:()=>['en-US','en','ar']});
  window.chrome = window.chrome || { runtime: {}, app: {} };
  const gp = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(p){
    if (p === 37445) return 'Google Inc. (NVIDIA)';
    if (p === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11)';
    return gp.call(this, p);
  };
  Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>8});
  Object.defineProperty(navigator,'deviceMemory',{get:()=>8});
  Object.defineProperty(navigator,'vendor',{get:()=>'Google Inc.'});
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
    return [];
  }
  async save(userId, cookies) {
    if (!userId) return;
    try {
      await redis.setex(`session:${userId}`, 604800, JSON.stringify({ cookies, updatedAt: new Date() }));
    } catch (e) {}
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
  async create(proxy = null) {
    const opts = {
      ignoreHTTPSErrors: true,
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"'
      }
    };
    if (proxy?.url) opts.proxy = { server: proxy.url };
    const context = await this.browser.newContext(opts);
    const page = await context.newPage();
    await page.addInitScript(StealthGenerator.script());
    await page.addInitScript(PAGE_HOOK_SCRIPT);
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
    if (Date.now() - ctx.createdAt > 40 * 60 * 1000 || ctx.usage > 25) {
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
          '--window-size=1920,1080',
          '--autoplay-policy=no-user-gesture-required'
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

async function tryClickPlayEverywhere(page) {
  const selectors = [
    'button[aria-label*="Play" i]',
    'button[title*="Play" i]',
    '.vjs-big-play-button',
    '.ytp-large-play-button',
    '.plyr__control--overlaid',
    '.jw-icon-display',
    '.fp-play',
    'button.play',
    '.play-button',
    '[data-testid*="play" i]',
    'video'
  ];
  let clicked = false;
  for (const frame of page.frames()) {
    for (const sel of selectors) {
      try {
        const el = await frame.$(sel);
        if (!el) continue;
        await el.click({ timeout: 1200 }).catch(() => {});
        clicked = true;
        await page.waitForTimeout(400);
      } catch (e) {}
    }
  }
  return clicked;
}

/**
 * Ultra extractor — maximum capture surface
 */
class UltraExtractor {
  constructor() {
    this.name = 'vd-pro-ultra';
  }

  empty() {
    return { m3u8: new Set(), mp4: new Set(), webm: new Set(), mpd: new Set(), other: new Set() };
  }

  add(bags, url, ct = '') {
    if (!url || typeof url !== 'string') return;
    if (url.startsWith('blob:')) return;
    const abs = url;
    const k = classifyMedia(abs, ct);
    if (k) bags[k].add(abs);
    else if (looksLikeMedia(abs, ct)) bags.other.add(abs);
  }

  toObj(bags, base) {
    const abs = (arr) =>
      [...new Set([...arr].map((u) => resolveUrl(base, u) || u).filter((u) => u && /^https?:/i.test(u)))];
    return {
      m3u8: abs(bags.m3u8),
      mp4: abs(bags.mp4),
      webm: abs(bags.webm),
      mpd: abs(bags.mpd),
      other: abs(bags.other)
    };
  }

  mineHtml(html, bags, base) {
    const $ = cheerio.load(html);
    $('video, source, [data-src], [data-video], [data-url], [data-stream], [data-file], [data-hls], [data-mp4]').each(
      (_, el) => {
        for (const a of ['src', 'data-src', 'data-video', 'data-url', 'data-stream', 'data-file', 'data-hls', 'data-mp4']) {
          const v = $(el).attr(a);
          if (v) this.add(bags, resolveUrl(base, v) || v);
        }
      }
    );
    // generic quoted media urls
    const rules = [
      [/(https?:\/\/[^"'\\s<>{}]+?\.m3u8[^"'\\s<>{}]*)/gi, 'm3u8'],
      [/(https?:\/\/[^"'\\s<>{}]+?\.mp4[^"'\\s<>{}]*)/gi, 'mp4'],
      [/(https?:\/\/[^"'\\s<>{}]+?\.mpd[^"'\\s<>{}]*)/gi, 'mpd'],
      [/(https?:\/\/[^"'\\s<>{}]+?\.webm[^"'\\s<>{}]*)/gi, 'webm']
    ];
    for (const [re, key] of rules) {
      let m;
      while ((m = re.exec(html)) !== null) bags[key].add(m[1]);
    }
    // player config-ish keys
    const cfg = /"(?:file|src|source|sources|hls|dash|playlist|stream|videoUrl|mediaUrl|playbackUrl)"\s*:\s*"([^"]+)"/gi;
    let cm;
    while ((cm = cfg.exec(html)) !== null) {
      const u = cm[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
      this.add(bags, resolveUrl(base, u) || u);
    }
  }

  async extract(pageUrl, page, userId, options = {}) {
    const quality = options.quality || 'auto';
    const deep = options.deep === true || options.deep === '1' || options.deep === 'true';
    const started = Date.now();
    const diagnostics = {
      framesVisited: 0,
      requestsObserved: 0,
      mediaRequests: 0,
      playClicked: false,
      hookCaptures: 0,
      strategies: [],
      captchaSuspected: false,
      passes: 1
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

    const onRequest = (req) => {
      try {
        diagnostics.requestsObserved++;
        const u = req.url();
        if (looksLikeMedia(u)) {
          diagnostics.mediaRequests++;
          this.add(bags, u);
        }
      } catch (e) {}
    };

    const onResponse = async (response) => {
      try {
        const u = response.url();
        const ct = response.headers()['content-type'] || '';
        if (looksLikeMedia(u, ct)) {
          diagnostics.mediaRequests++;
          this.add(bags, u, ct);
        }
      } catch (e) {}
    };

    page.on('request', onRequest);
    page.on('response', onResponse);

    try {
      const cookies = await sessionManager.load(userId);
      if (cookies?.length) {
        try {
          await page.context().addCookies(cookies);
        } catch (e) {}
      }

      // Ensure hooks exist on this page instance
      try {
        await page.addInitScript(PAGE_HOOK_SCRIPT);
      } catch (e) {}

      try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 55000 });
      } catch (e) {
        diagnostics.navWarning = e.message;
      }

      try {
        result.pageTitle = await page.title();
        const bodyText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 2000));
        if (/captcha|cloudflare|verify you are human|attention required/i.test(bodyText + (result.pageTitle || ''))) {
          diagnostics.captchaSuspected = true;
        }
      } catch (e) {}

      // human-ish
      try {
        await page.waitForTimeout(500 + Math.random() * 700);
        await page.evaluate(() => window.scrollBy(0, 350));
      } catch (e) {}

      diagnostics.playClicked = await tryClickPlayEverywhere(page);
      await page.waitForTimeout(deep ? 6000 : 3500);
      diagnostics.strategies.push('network');

      // DOM + scripts main frame
      try {
        const html = await page.content();
        this.mineHtml(html, bags, pageUrl);
        diagnostics.strategies.push('dom+script');
      } catch (e) {}

      // video element state
      try {
        const mediaUrls = await page.evaluate(() => {
          const out = [];
          document.querySelectorAll('video').forEach((v) => {
            if (v.currentSrc) out.push(v.currentSrc);
            if (v.src) out.push(v.src);
            v.querySelectorAll('source').forEach((s) => {
              if (s.src) out.push(s.src);
            });
          });
          if (window.__vdCaptured) {
            window.__vdCaptured.forEach((x) => out.push(x.url));
          }
          return out;
        });
        diagnostics.hookCaptures = mediaUrls.length;
        mediaUrls.forEach((u) => this.add(bags, u));
        diagnostics.strategies.push('media-element+hooks');
      } catch (e) {}

      // frames
      try {
        const frames = page.frames();
        diagnostics.framesVisited = frames.length;
        for (const frame of frames.slice(0, deep ? 16 : 10)) {
          try {
            const html = await frame.content();
            this.mineHtml(html, bags, pageUrl);
            const fu = await frame.evaluate(() => {
              const out = [];
              document.querySelectorAll('video').forEach((v) => {
                if (v.currentSrc) out.push(v.currentSrc);
                if (v.src) out.push(v.src);
              });
              if (window.__vdCaptured) window.__vdCaptured.forEach((x) => out.push(x.url));
              return out;
            });
            fu.forEach((u) => this.add(bags, u));
          } catch (e) {}
        }
        diagnostics.strategies.push('frames');
      } catch (e) {}

      // Second pass if deep and still empty
      const provisional = this.toObj(bags, pageUrl);
      const hasAny =
        provisional.m3u8.length + provisional.mp4.length + provisional.webm.length + provisional.mpd.length > 0;
      if (deep && !hasAny) {
        diagnostics.passes = 2;
        diagnostics.playClicked = (await tryClickPlayEverywhere(page)) || diagnostics.playClicked;
        await page.waitForTimeout(5000);
        try {
          const html2 = await page.content();
          this.mineHtml(html2, bags, pageUrl);
          const more = await page.evaluate(() => (window.__vdCaptured || []).map((x) => x.url));
          more.forEach((u) => this.add(bags, u));
        } catch (e) {}
        diagnostics.strategies.push('deep-second-pass');
      }

      page.off('request', onRequest);
      page.off('response', onResponse);

      result.urls = this.toObj(bags, pageUrl);

      const variants = [];
      for (const m of result.urls.m3u8.slice(0, 6)) {
        const en = await HLSParser.enrich(m);
        if (en.variants?.length) variants.push(...en.variants);
        else variants.push({ url: m, quality: 'unknown', bandwidth: 0 });
      }
      for (const m of result.urls.mp4) variants.push({ url: m, quality: 'mp4', bandwidth: 0 });
      for (const m of result.urls.webm) variants.push({ url: m, quality: 'webm', bandwidth: 0 });
      for (const m of result.urls.mpd) variants.push({ url: m, quality: 'dash', bandwidth: 0 });
      variants.sort((a, b) => rankScore(b.url) - rankScore(a.url));
      result.variants = variants.slice(0, 25);

      const picked = pickByQuality(result.variants, quality);
      if (picked?.url) {
        result.primaryUrl = picked.url;
        result.success = true;
        result.strategy = diagnostics.strategies.join('+');
        const v = await ResultValidator.validate(result.primaryUrl);
        result.validated = v.valid;
        if (!v.valid) result.validationReason = v.reason;
      } else {
        result.error = diagnostics.captchaSuspected
          ? 'Possible bot protection page; no media streams observed'
          : 'No video streams found';
        result.errorCode = diagnostics.captchaSuspected ? 'BOT_PROTECTION_SUSPECTED' : 'NO_STREAM_FOUND';
      }

      try {
        const c = await page.context().cookies();
        if (c.length) await sessionManager.save(userId, c);
      } catch (e) {}

      result.duration = (Date.now() - started) / 1000;
      result.diagnostics = diagnostics;
      return result;
    } catch (error) {
      try {
        page.off('request', onRequest);
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
        maxContentLength: 400000,
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
          query,
          boost: 0.15,
          overview: data.Abstract || null
        });
      }
      for (const t of data?.RelatedTopics || []) {
        const items = t.Topics || [t];
        for (const sub of items) {
          if (sub.FirstURL && sub.Text) {
            this.add(map, {
              name: sub.Text.split(' - ')[0].slice(0, 120),
              title: sub.Text.slice(0, 160),
              url: sub.FirstURL,
              source: 'ddg-api',
              query,
              boost: 0.05
            });
          }
        }
      }
    } catch (e) {
      logger.warn({ error: e.message }, 'DDG API failed');
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
          query,
          boost: 0.12
        });
      }
    } catch (e) {}
  }

  async searchTMDB(query, map) {
    if (!TMDB_API_KEY) return;
    try {
      const { data } = await httpClient.get('https://api.themoviedb.org/3/search/multi', {
        params: { api_key: TMDB_API_KEY, query, include_adult: false, language: 'en-US', page: 1 }
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
          title: name,
          url: tmdbUrl,
          source: 'tmdb',
          type: item.media_type,
          year,
          overview: item.overview || null,
          query,
          boost: 0.2
        });
      }
    } catch (e) {}
  }

  async searchByName(query) {
    const q = String(query || '').trim();
    if (!q) return [];
    const map = new Map();
    await Promise.all([
      this.searchDuckDuckGoAPI(q, map),
      this.searchDuckDuckGoAPI(`${q} TV series`, map),
      this.searchWikipedia(q, map),
      this.searchTMDB(q, map)
    ]);
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

class CacheManager {
  constructor() {
    this.l1 = new Map();
    this.max = 100;
  }
  key(url, quality, deep) {
    return crypto.createHash('sha256').update(`${url}::${quality}::${deep ? 1 : 0}`).digest('hex');
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
        return JSON.parse(raw);
      }
    } catch (e) {}
    return null;
  }
  async set(url, data, quality = 'auto', deep = false) {
    const k = this.key(url, quality, deep);
    if (this.l1.size >= this.max) this.l1.delete(this.l1.keys().next().value);
    this.l1.set(k, data);
    try {
      await redis.setex(`cache:${k}`, 86400, JSON.stringify(data));
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

const extractionQueue = new Queue('vd-pro-ultra', REDIS_URL, {
  settings: { stalledInterval: 15000, maxStalledCount: 2, lockDuration: 180000, lockRenewTime: 80000 }
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
    } else req.user = { _id: decoded.apiKey, plan: 'free', apiKey: decoded.apiKey };
    next();
  } catch (e) {
    return res.status(403).json({ success: false, error: 'Invalid token', code: 'INVALID_TOKEN' });
  }
};

app.use(
  '/api/v1/',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    keyGenerator: (req) => {
      const id = req.user?._id?.toString?.() || req.user?._id;
      return id ? `u:${id}` : `ip:${req.ip}`;
    }
  })
);

app.get('/api/v1/health', (req, res) => {
  res.json({
    status: 'healthy',
    name: 'Vd-Pro',
    version: '4.0.0-ultra',
    redis: redis.status,
    mongodb: db ? 'connected' : 'disconnected',
    features: [
      'pre-nav-network-capture',
      'page-hooks-fetch-xhr-media',
      'multi-frame-play',
      'hls-variants',
      'deep-second-pass',
      'api-search'
    ],
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.post('/api/v1/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ success: false, error: 'Missing fields' });
    if (String(password).length < 8) return res.status(400).json({ success: false, error: 'Weak password' });
    if (!db) return res.status(503).json({ success: false, error: 'DB unavailable' });
    const normalized = String(email).trim().toLowerCase();
    if (await db.collection('users').findOne({ email: normalized })) {
      return res.status(400).json({ success: false, error: 'Email exists' });
    }
    const apiKey = crypto.randomBytes(32).toString('hex');
    await db.collection('users').insertOne({
      email: normalized,
      password: await bcrypt.hash(password, 12),
      apiKey,
      plan: 'free',
      createdAt: new Date()
    });
    const token = jwt.sign({ apiKey }, EFFECTIVE_JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ success: true, apiKey, token, plan: 'free' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Register failed' });
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
    if (singleFlight.get(flightKey)) return res.status(202).json({ success: true, message: 'Processing', dedup: true });
    const userId = req.user._id?.toString?.() || String(req.user._id);
    const job = await extractionQueue.add(
      { type: 'extract', url, userId, quality, deep: deepFlag },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        timeout: EXTRACT_TIMEOUT_MS + 40000,
        removeOnComplete: 80,
        removeOnFail: 40
      }
    );
    singleFlight.set(flightKey, job.finished().catch(() => null));
    res.status(202).json({ success: true, jobId: job.id, statusUrl: `/api/v1/jobs/${job.id}` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/v1/search', verifyToken, async (req, res) => {
  try {
    const { q, extract, quality = 'auto', deep } = req.query;
    if (!q?.trim()) return res.status(400).json({ success: false, error: 'q required' });
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
      { attempts: 2, timeout: doExtract ? EXTRACT_TIMEOUT_MS + 60000 : 45000, removeOnComplete: 50 }
    );
    res.status(202).json({
      success: true,
      jobId: job.id,
      query: String(q).trim(),
      mode: doExtract ? 'search_and_extract' : 'search_only',
      statusUrl: `/api/v1/jobs/${job.id}`
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/v1/jobs/:jobId', verifyToken, async (req, res) => {
  try {
    const job = await extractionQueue.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
    const userId = req.user._id?.toString?.() || String(req.user._id);
    if (job.data?.userId && String(job.data.userId) !== userId) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
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
      failedReason: state === 'failed' ? job.failedReason || null : null
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/v1/proxy-status', verifyToken, (req, res) => {
  res.json({ success: true, proxies: proxyManager.status() });
});

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup({ openapi: '3.0.0', info: { title: 'Vd-Pro Ultra', version: '4.0.0' } }));

extractionQueue.process(3, async (job) => {
  let ctx = null;
  let proxy = null;
  try {
    const userId = job.data.userId;

    if (job.data.type === 'search') {
      const results = await new SearchProvider().searchByName(job.data.search);
      return {
        success: results.length > 0,
        query: job.data.search,
        results,
        count: results.length,
        providers: ['ddg-api', 'wikipedia', TMDB_API_KEY ? 'tmdb' : null].filter(Boolean)
      };
    }

    proxy = proxyManager.getNext();
    ctx = await browserPool.get(proxy);
    const { page } = ctx;

    if (job.data.type === 'search_extract') {
      const results = await new SearchProvider().searchByName(job.data.search);
      if (!results.length) {
        return { success: false, query: job.data.search, results: [], errorCode: 'NO_SEARCH_RESULTS' };
      }
      const preferred = results.find((r) => !/wikipedia\.org|themoviedb\.org/i.test(r.url)) || results[0];
      const extraction = await circuitBreaker.run(() =>
        new UltraExtractor().extract(preferred.url, page, userId, {
          quality: job.data.quality,
          deep: job.data.deep
        })
      );
      return {
        success: !!extraction.success,
        query: job.data.search,
        matchedName: preferred.name,
        matchedUrl: preferred.url,
        searchResults: results.slice(0, 10),
        extraction
      };
    }

    const result = await circuitBreaker.run(() =>
      new UltraExtractor().extract(job.data.url, page, userId, {
        quality: job.data.quality,
        deep: job.data.deep
      })
    );

    metrics.extractionDuration.labels(result.success ? 'success' : 'failure').observe(result.duration || 0);
    if (result.success) {
      metrics.sourceSuccess.inc();
      proxyManager.success(proxy);
      await cacheManager.set(job.data.url, result, job.data.quality || 'auto', !!job.data.deep);
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
    logger.info('🚀 Vd-Pro Ultra v4.0 starting...');
    await connectDatabase();
    browserPool = new BrowserPool(2);
    await browserPool.init();
    httpServer.listen(PORT, '0.0.0.0', () => {
      logger.info(`Vd-Pro Ultra on :${PORT}`);
      console.log(`
╔════════════════════════════════════════════════════════════╗
║  VD-PRO ULTRA v4.0                                         ║
║  ✓ Pre-nav request/response capture                        ║
║  ✓ In-page hooks (fetch/XHR/media/MSE)                     ║
║  ✓ Multi-frame Play + currentSrc                           ║
║  ✓ Player config JSON mining                               ║
║  ✓ Deep second pass                                        ║
║  ✓ HLS variants + ranking                                  ║
║  ✓ CAPTCHA suspicion diagnostics                           ║
║  extract?url=&deep=1&quality=1080p                         ║
╚════════════════════════════════════════════════════════════╝
`);
    });
  } catch (e) {
    logger.error({ error: e.message }, 'Startup failed');
    process.exit(1);
  }
})();

export default app;
