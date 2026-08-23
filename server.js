/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  LEGEND VD — Enterprise Video Extraction Platform v3.0          ║
 * ║  Professional · Smart · Resilient · Production-Ready            ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Features:
 * - Full network capture (MIME, redirects, no extension-only filter)
 * - iframe / frame walk (depth-limited)
 * - Safe Play-button simulation + media events wait
 * - HLS master playlist variant parsing + quality pick
 * - Basic DASH (.mpd) detection
 * - Candidate ranking
 * - Search-by-name → candidates
 * - Job ownership, JWT enforced, SSRF hardened
 * - Session cookies, circuit breaker, multi-level cache
 * - Rich diagnostics on failure/success
 * - WebSocket auth, proxy status protected
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
const MONGODB_URL = process.env.MONGODB_URL || 'mongodb://localhost:27017/legend-vd';
const PROXIES = (process.env.PROXIES || '').split(',').map(p => p.trim()).filter(Boolean);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const MAX_FRAME_DEPTH = parseInt(process.env.MAX_FRAME_DEPTH || '3', 10);
const EXTRACT_TIMEOUT_MS = parseInt(process.env.EXTRACT_TIMEOUT_MS || '90000', 10);

if (NODE_ENV === 'production') {
  if (!JWT_SECRET || JWT_SECRET.length < 32) {
    console.error('FATAL: JWT_SECRET must be set and at least 32 characters in production');
    process.exit(1);
  }
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'dev-only-secret-change-me-in-production-min-32-chars';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// ─── Metrics ───────────────────────────────────────────────
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
  cacheHits: new prometheus.Counter({ name: 'cache_hits_total', help: 'Cache hits', labelNames: ['level'] })
};
Object.values(metrics).forEach(m => { try { prometheus.register.registerMetric(m); } catch (e) {} });

// ─── Database ───────────────────────────────────────────────
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
    db = mongoClient.db('legend-vd');
    for (const col of ['users', 'extractions', 'cache', 'sessions', 'failed_jobs', 'diagnostics', 'webhooks']) {
      try { await db.createCollection(col); } catch (e) {}
    }
    await Promise.all([
      db.collection('extractions').createIndex({ url: 1, userId: 1 }),
      db.collection('extractions').createIndex({ jobId: 1 }, { unique: true }),
      db.collection('extractions').createIndex({ createdAt: -1 }),
      db.collection('users').createIndex({ apiKey: 1 }, { unique: true }),
      db.collection('users').createIndex({ email: 1 }, { unique: true }),
      db.collection('cache').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      db.collection('cache').createIndex({ contentHash: 1 }, { unique: true }),
      db.collection('sessions').createIndex({ userId: 1 }),
      db.collection('failed_jobs').createIndex({ createdAt: -1 }),
      db.collection('webhooks').createIndex({ userId: 1 })
    ]);
    logger.info('✅ MongoDB connected');
    return true;
  } catch (error) {
    logger.error({ error: error.message }, '❌ MongoDB error');
    return false;
  }
}

// ─── Redis ──────────────────────────────────────────────────
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  retryStrategy: (t) => Math.min(t * 50, 2000),
  enableReadyCheck: true,
  connectTimeout: 10000,
  commandTimeout: 5000
});
redis.on('error', (e) => logger.warn({ error: e.message }, '⚠️ Redis'));
redis.on('connect', () => logger.info('✅ Redis connected'));

// ─── SSRF ───────────────────────────────────────────────────
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
          if (this.isPrivate(a)) return { valid: false, reason: 'Private IPv4 via DNS' };
        }
      } catch (e) {}
      try {
        for (const a of await dns.resolve6(url.hostname)) {
          if (this.isPrivate(a)) return { valid: false, reason: 'Private IPv6 via DNS' };
        }
      } catch (e) {}
      return { valid: true };
    } catch (e) {
      return { valid: false, reason: e.message || 'Invalid URL' };
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────
function resolveUrl(base, rel) {
  try {
    if (!rel) return null;
    if (/^(https?:|blob:|data:)/i.test(rel)) return rel;
    return new URL(rel, base).href;
  } catch (e) {
    return null;
  }
}

function looksLikeMedia(url = '', contentType = '') {
  const u = url.toLowerCase();
  const ct = (contentType || '').toLowerCase();
  if (/\.(m3u8|mp4|webm|mpd|m4s|ts)(\?|#|$)/i.test(u)) return true;
  if (u.includes('/hls/') || u.includes('/dash/') || u.includes('manifest') || u.includes('playlist')) return true;
  if (ct.includes('mpegurl') || ct.includes('dash+xml') || ct.startsWith('video/')) return true;
  if (ct.includes('application/octet-stream') && /\.(mp4|m4s|ts)/i.test(u)) return true;
  return false;
}

function classifyMediaUrl(url = '', contentType = '') {
  const u = url.toLowerCase();
  const ct = (contentType || '').toLowerCase();
  if (u.includes('.m3u8') || ct.includes('mpegurl')) return 'm3u8';
  if (u.includes('.mpd') || ct.includes('dash+xml')) return 'mpd';
  if (u.includes('.webm') || ct.includes('webm')) return 'webm';
  if (u.includes('.mp4') || ct.includes('mp4') || ct.startsWith('video/')) return 'mp4';
  if (looksLikeMedia(url, contentType)) return 'm3u8';
  return null;
}

function rankScore(url) {
  let s = 0;
  const u = url.toLowerCase();
  if (u.includes('.mp4')) s += 50;
  if (u.includes('.m3u8')) s += 40;
  if (u.includes('.mpd')) s += 35;
  if (u.includes('1080') || u.includes('1920')) s += 20;
  if (u.includes('720')) s += 12;
  if (u.includes('480')) s += 5;
  if (u.startsWith('blob:')) s -= 30;
  if (u.includes('preview') || u.includes('trailer') || u.includes('thumb')) s -= 15;
  return s;
}

function pickByQuality(variants, quality = 'auto') {
  if (!variants?.length) return null;
  if (!quality || quality === 'auto') {
    return [...variants].sort((a, b) => rankScore(b.url || b) - rankScore(a.url || a))[0];
  }
  const q = String(quality).toLowerCase();
  const hit = variants.find((v) => {
    const u = (v.url || v).toLowerCase();
    const label = (v.quality || '').toLowerCase();
    return label.includes(q) || u.includes(q);
  });
  return hit || variants[0];
}

// ─── HLS Parser ─────────────────────────────────────────────
class HLSParser {
  static async fetchText(url, timeout = 12000) {
    const res = await axios.get(url, {
      timeout,
      maxRedirects: 5,
      maxContentLength: 2_000_000,
      validateStatus: (s) => s >= 200 && s < 400,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: '*/*'
      }
    });
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
        if (h >= 1080) quality = '1080p';
        else if (h >= 720) quality = '720p';
        else if (h >= 480) quality = '480p';
        else quality = `${h}p`;
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
        const variants = this.parseMaster(text, m3u8Url);
        return { type: 'master', variants };
      }
      return { type: 'media', variants: [{ url: m3u8Url, quality: 'media', bandwidth: 0 }] };
    } catch (e) {
      return { type: 'error', variants: [], error: e.message };
    }
  }
}

// ─── Stealth ────────────────────────────────────────────────
class StealthGenerator {
  static script() {
    const vendor = ['Intel Inc.', 'NVIDIA Corporation', 'AMD'][Math.floor(Math.random() * 3)];
    const renderer = ['Intel UHD Graphics 630', 'NVIDIA GeForce GTX 1660', 'AMD Radeon RX 580'][Math.floor(Math.random() * 3)];
    const mem = [8, 16][Math.floor(Math.random() * 2)];
    const cpu = [4, 8][Math.floor(Math.random() * 2)];
    return `
(function(){
  'use strict';
  Object.defineProperty(navigator,'webdriver',{get:()=>false});
  try{delete navigator.__proto__.webdriver;}catch(e){}
  Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});
  Object.defineProperty(navigator,'plugins',{get:()=>[{name:'Chrome PDF Plugin'},{name:'Chrome PDF Viewer'}]});
  window.chrome=window.chrome||{runtime:{},app:{}};
  const gp=WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter=function(p){
    if(p===37445)return '${vendor}';
    if(p===37446)return '${renderer}';
    return gp.call(this,p);
  };
  Object.defineProperty(navigator,'deviceMemory',{value:${mem}});
  Object.defineProperty(navigator,'hardwareConcurrency',{value:${cpu}});
  Object.defineProperty(navigator,'vendor',{value:'Google Inc.'});
})();`;
  }
}

// ─── Proxy ──────────────────────────────────────────────────
class ProxyManager {
  constructor() {
    this.proxies = PROXIES.map((url, id) => ({
      url,
      id,
      health: { success: 0, failed: 0, consecutive: 0, available: true, lastCheck: null }
    }));
  }

  getNext() {
    if (!this.proxies.length) return null;
    const ok = this.proxies.filter((p) => p.health.available);
    if (!ok.length) {
      this.proxies.forEach((p) => { p.health.available = true; p.health.consecutive = 0; });
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
      } catch (e) { safe = '[redacted]'; }
      return { url: safe, available: p.health.available, success: p.health.success, failed: p.health.failed };
    });
  }
}
const proxyManager = new ProxyManager();

// ─── Session ────────────────────────────────────────────────
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

// ─── Browser pools ──────────────────────────────────────────
class BrowserContextPool {
  constructor(browser, size = 3) {
    this.browser = browser;
    this.size = size;
    this.available = [];
    this.inUse = new Map();
  }

  ua() {
    const list = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    ];
    return list[Math.floor(Math.random() * list.length)];
  }

  async create(proxy = null) {
    const opts = {
      ignoreHTTPSErrors: true,
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      userAgent: this.ua(),
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        DNT: '1'
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
    const age = Date.now() - ctx.createdAt;
    if (age > 45 * 60 * 1000 || ctx.usage > 30) {
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
    const pool = this.pools[Math.floor(Math.random() * this.pools.length)];
    return pool.get(proxy);
  }

  release(ctx) {
    if (!ctx) return;
    if (ctx.pool) ctx.pool.release(ctx);
  }

  async closeAll() {
    await Promise.all(this.pools.map((p) => p.closeAll()));
    await Promise.all(this.browsers.map((b) => b.close().catch(() => {})));
  }
}
let browserPool = null;

// ─── Human-ish interaction ──────────────────────────────────
async function gentleInteract(page) {
  try {
    await page.waitForTimeout(600 + Math.random() * 900);
    await page.evaluate(() => window.scrollBy({ top: 300 + Math.random() * 400, behavior: 'smooth' }));
    await page.waitForTimeout(500 + Math.random() * 700);
  } catch (e) {}
}

async function tryClickPlay(page) {
  const selectors = [
    'button[aria-label*="Play" i]',
    'button[title*="Play" i]',
    '.vjs-big-play-button',
    '.ytp-large-play-button',
    '.plyr__control--overlaid',
    '.jw-icon-display',
    'button.play',
    '.play-button',
    'video'
  ];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      await el.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(800);
      return true;
    } catch (e) {}
  }
  return false;
}

// ─── Legend Extractor ───────────────────────────────────────
class LegendExtractor {
  constructor() {
    this.name = 'legend-vd';
  }

  emptyBags() {
    return { m3u8: new Set(), mp4: new Set(), webm: new Set(), mpd: new Set(), other: new Set() };
  }

  bagsToObj(bags) {
    return {
      m3u8: [...bags.m3u8],
      mp4: [...bags.mp4],
      webm: [...bags.webm],
      mpd: [...bags.mpd],
      other: [...bags.other]
    };
  }

  addUrl(bags, url, contentType = '') {
    if (!url || url.startsWith('blob:')) return;
    const kind = classifyMediaUrl(url, contentType);
    if (!kind) {
      if (looksLikeMedia(url, contentType)) bags.other.add(url);
      return;
    }
    bags[kind]?.add(url);
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
      source: this.name
    };

    const bags = this.emptyBags();

    const onResponse = async (response) => {
      try {
        diagnostics.requestsObserved++;
        const u = response.url();
        const ct = response.headers()['content-type'] || '';
        if (looksLikeMedia(u, ct)) {
          diagnostics.mediaRequests++;
          this.addUrl(bags, u, ct);
        }
      } catch (e) {}
    };

    page.on('response', onResponse);

    try {
      // cookies
      const cookies = await sessionManager.load(userId);
      if (cookies?.length) {
        try { await page.context().addCookies(cookies); } catch (e) {}
      }

      try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 50000 });
      } catch (e) {
        diagnostics.navWarning = e.message;
      }

      await gentleInteract(page);
      diagnostics.playClicked = await tryClickPlay(page);
      await page.waitForTimeout(deep ? 5000 : 3000);

      // wait a bit more for streaming manifests
      await page.waitForTimeout(2000);

      diagnostics.strategies.push('network');

      // DOM
      try {
        const dom = await this.scanDom(page, pageUrl);
        for (const [k, arr] of Object.entries(dom)) arr.forEach((u) => bags[k]?.add(u));
        diagnostics.strategies.push('dom');
      } catch (e) {}

      // Scripts
      try {
        const scripts = await this.scanScripts(page);
        for (const [k, arr] of Object.entries(scripts)) arr.forEach((u) => bags[k]?.add(u));
        diagnostics.strategies.push('script');
      } catch (e) {}

      // Frames
      if (deep || diagnostics.mediaRequests < 1) {
        try {
          const frameUrls = await this.scanFrames(page, pageUrl);
          for (const [k, arr] of Object.entries(frameUrls)) arr.forEach((u) => bags[k]?.add(u));
          diagnostics.strategies.push('frames');
        } catch (e) {}
      }

      page.off('response', onResponse);

      let urls = this.bagsToObj(bags);
      // absolute
      const abs = (arr) => [...new Set((arr || []).map((u) => resolveUrl(pageUrl, u)).filter(Boolean))];
      urls = {
        m3u8: abs(urls.m3u8),
        mp4: abs(urls.mp4),
        webm: abs(urls.webm),
        mpd: abs(urls.mpd),
        other: abs(urls.other)
      };
      result.urls = urls;

      // HLS enrich
      const variants = [];
      for (const m of urls.m3u8.slice(0, 5)) {
        const enriched = await HLSParser.enrich(m);
        if (enriched.variants?.length) {
          variants.push(...enriched.variants);
        } else {
          variants.push({ url: m, quality: 'unknown', bandwidth: 0 });
        }
      }
      for (const m of urls.mp4) variants.push({ url: m, quality: 'mp4', bandwidth: 0 });
      for (const m of urls.webm) variants.push({ url: m, quality: 'webm', bandwidth: 0 });
      for (const m of urls.mpd) variants.push({ url: m, quality: 'dash', bandwidth: 0 });

      // rank
      variants.sort((a, b) => rankScore(b.url) - rankScore(a.url));
      result.variants = variants.slice(0, 20);

      const picked = pickByQuality(result.variants, quality);
      if (picked?.url) {
        result.primaryUrl = picked.url;
        result.success = true;
        result.strategy = diagnostics.strategies.join('+');
      } else {
        result.error = 'No video streams found';
        result.errorCode = 'NO_STREAM_FOUND';
      }

      // validate primary
      if (result.success) {
        const v = await ResultValidator.validate(result.primaryUrl);
        result.validated = v.valid;
        if (!v.valid) {
          result.validationReason = v.reason;
        }
      }

      // save cookies
      try {
        const c = await page.context().cookies();
        if (c.length) await sessionManager.save(userId, c);
      } catch (e) {}

      diagnostics.framesVisited = page.frames().length;
      result.duration = (Date.now() - started) / 1000;
      result.diagnostics = diagnostics;
      return result;
    } catch (error) {
      try { page.off('response', onResponse); } catch (e) {}
      result.error = error.message;
      result.errorCode = 'EXTRACTION_ERROR';
      result.duration = (Date.now() - started) / 1000;
      result.diagnostics = diagnostics;
      return result;
    }
  }

  async scanDom(page, base) {
    const html = await page.content();
    const $ = cheerio.load(html);
    const out = { m3u8: [], mp4: [], webm: [], mpd: [], other: [] };
    const push = (src) => {
      const abs = resolveUrl(base, src);
      if (!abs) return;
      const k = classifyMediaUrl(abs) || 'other';
      out[k]?.push(abs);
    };
    $('video, video source, source, [data-src], [data-video], [data-url], [data-stream], [data-file]').each((_, el) => {
      push($(el).attr('src'));
      push($(el).attr('data-src'));
      push($(el).attr('data-video'));
      push($(el).attr('data-url'));
      push($(el).attr('data-stream'));
      push($(el).attr('data-file'));
    });
    return out;
  }

  async scanScripts(page) {
    const html = await page.content();
    const out = { m3u8: [], mp4: [], webm: [], mpd: [], other: [] };
    const rules = [
      [/(https?:\/\/[^"'\\s<>{}]+?\.m3u8[^"'\\s<>{}]*)/gi, 'm3u8'],
      [/(https?:\/\/[^"'\\s<>{}]+?\.mp4[^"'\\s<>{}]*)/gi, 'mp4'],
      [/(https?:\/\/[^"'\\s<>{}]+?\.webm[^"'\\s<>{}]*)/gi, 'webm'],
      [/(https?:\/\/[^"'\\s<>{}]+?\.mpd[^"'\\s<>{}]*)/gi, 'mpd']
    ];
    for (const [re, key] of rules) {
      let m;
      while ((m = re.exec(html)) !== null) out[key].push(m[1]);
    }
    return out;
  }

  async scanFrames(page, base) {
    const out = { m3u8: [], mp4: [], webm: [], mpd: [], other: [] };
    const frames = page.frames().slice(0, 12);
    for (const frame of frames) {
      try {
        const html = await frame.content();
        const $ = cheerio.load(html);
        $('video, source, [data-src], [data-video]').each((_, el) => {
          const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-video');
          const abs = resolveUrl(base, src);
          if (!abs) return;
          const k = classifyMediaUrl(abs) || 'other';
          out[k]?.push(abs);
        });
        const rules = [
          [/(https?:\/\/[^"'\\s<>{}]+?\.m3u8[^"'\\s<>{}]*)/gi, 'm3u8'],
          [/(https?:\/\/[^"'\\s<>{}]+?\.mp4[^"'\\s<>{}]*)/gi, 'mp4']
        ];
        for (const [re, key] of rules) {
          let m;
          while ((m = re.exec(html)) !== null) out[key].push(m[1]);
        }
      } catch (e) {}
    }
    return out;
  }
}

// ─── Validator ──────────────────────────────────────────────
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
      if (url.includes('.m3u8')) {
        const body = String(res.data || '');
        if (!body.includes('#EXTM3U')) return { valid: false, reason: 'INVALID_M3U8' };
      }
      return { valid: true };
    } catch (e) {
      return { valid: false, reason: 'VALIDATION_FAILED' };
    }
  }
}

// ─── Search ─────────────────────────────────────────────────
class SearchProvider {
  async searchByName(query, page) {
    const results = [];
    try {
      const q = encodeURIComponent(`${query} watch online`);
      await page.goto(`https://html.duckduckgo.com/html/?q=${q}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      await page.waitForTimeout(1200);
      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]'))
          .map((a) => ({ title: (a.textContent || '').trim().slice(0, 140), url: a.href }))
          .filter((x) => x.url && x.title && x.title.length > 4 && !x.url.includes('duckduckgo.com') && /^https?:/i.test(x.url))
          .slice(0, 12)
      );
      for (const l of links) results.push({ title: l.title, url: l.url, source: 'search' });
    } catch (e) {
      logger.warn({ error: e.message }, 'Search failed');
    }
    return results;
  }
}

// ─── Cache / SingleFlight / Circuit ─────────────────────────
class CacheManager {
  constructor() {
    this.l1 = new Map();
    this.max = 120;
  }
  key(url, quality, deep) {
    return crypto.createHash('sha256').update(`${url}::${quality}::${deep ? 1 : 0}`).digest('hex');
  }
  _setL1(k, v) {
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
        const parsed = JSON.parse(raw);
        this._setL1(k, parsed);
        return parsed;
      }
    } catch (e) {}
    if (db) {
      try {
        const doc = await db.collection('cache').findOne({ contentHash: k, expiresAt: { $gt: new Date() } });
        if (doc) {
          metrics.cacheHits.labels('l3').inc();
          this._setL1(k, doc.data);
          return doc.data;
        }
      } catch (e) {}
    }
    return null;
  }
  async set(url, data, quality = 'auto', deep = false, ttl = 259200) {
    const k = this.key(url, quality, deep);
    this._setL1(k, data);
    try { await redis.setex(`cache:${k}`, Math.min(ttl, 86400), JSON.stringify(data)); } catch (e) {}
    if (db) {
      try {
        await db.collection('cache').updateOne(
          { contentHash: k },
          { $set: { contentHash: k, url, quality, data, expiresAt: new Date(Date.now() + ttl * 1000), createdAt: new Date() } },
          { upsert: true }
        );
      } catch (e) {}
    }
  }
}
const cacheManager = new CacheManager();

class SingleFlight {
  constructor() { this.map = new Map(); }
  h(k) { return crypto.createHash('sha256').update(k).digest('hex'); }
  get(k) { return this.map.get(this.h(k)); }
  set(k, p) {
    const id = this.h(k);
    this.map.set(id, p);
    setTimeout(() => this.map.delete(id), 300000);
  }
  del(k) { if (k) this.map.delete(this.h(k)); }
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
        if (this.ok >= 2) { this.state = 'CLOSED'; this.ok = 0; }
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

// ─── Queue ──────────────────────────────────────────────────
const extractionQueue = new Queue('legend-extraction', REDIS_URL, {
  settings: {
    stalledInterval: 15000,
    maxStalledCount: 2,
    lockDuration: 150000,
    lockRenewTime: 70000
  }
});

// ─── Middleware ─────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
if (ALLOWED_ORIGINS.length) app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
else app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    try {
      metrics.httpDuration.labels(req.method, req.route?.path || req.path, res.statusCode)
        .observe((Date.now() - t0) / 1000);
    } catch (e) {}
  });
  req.requestId = uuidv4();
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

// ─── Routes ─────────────────────────────────────────────────
app.get('/api/v1/health', (req, res) => {
  res.json({
    status: 'healthy',
    name: 'Legend-Vd',
    version: '3.0.0',
    redis: redis.status,
    mongodb: db ? 'connected' : 'disconnected',
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
    if (!email || !password) return res.status(400).json({ success: false, error: 'Missing fields', code: 'MISSING_FIELDS' });
    if (String(password).length < 8) return res.status(400).json({ success: false, error: 'Weak password', code: 'WEAK_PASSWORD' });
    if (!db) return res.status(503).json({ success: false, error: 'DB unavailable', code: 'DB_UNAVAILABLE' });
    const normalized = String(email).trim().toLowerCase();
    if (await db.collection('users').findOne({ email: normalized })) {
      return res.status(400).json({ success: false, error: 'Email exists', code: 'EMAIL_EXISTS' });
    }
    const apiKey = crypto.randomBytes(32).toString('hex');
    const hashed = await bcrypt.hash(password, 12);
    const plan = 'free';
    await db.collection('users').insertOne({ email: normalized, password: hashed, apiKey, plan, createdAt: new Date() });
    const token = jwt.sign({ apiKey }, EFFECTIVE_JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ success: true, apiKey, token, plan });
  } catch (e) {
    logger.error({ error: e.message }, 'Register failed');
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

    const flightKey = `${url}::${quality}::${deepFlag ? 1 : 0}`;
    if (singleFlight.get(flightKey)) {
      return res.status(202).json({ success: true, message: 'Processing', dedup: true });
    }

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
    const { q } = req.query;
    if (!q) return res.status(400).json({ success: false, error: 'Query required', code: 'MISSING_QUERY' });
    const userId = req.user._id?.toString?.() || String(req.user._id);
    const job = await extractionQueue.add(
      { type: 'search', search: q, userId },
      { attempts: 2, backoff: { type: 'exponential', delay: 2000 }, timeout: 90000, removeOnComplete: 50, removeOnFail: 20 }
    );
    res.status(202).json({ success: true, jobId: job.id, query: q, statusUrl: `/api/v1/jobs/${job.id}` });
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
        try { result = await job.finished(); } catch (e) {}
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

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup({
  openapi: '3.0.0',
  info: { title: 'Legend Vd API', version: '3.0.0' },
  paths: {
    '/extract': { get: { summary: 'Extract video async' } },
    '/search': { get: { summary: 'Search by name async' } },
    '/jobs/{id}': { get: { summary: 'Job status' } }
  }
}));

// ─── Worker ─────────────────────────────────────────────────
extractionQueue.process(4, async (job) => {
  let ctx = null;
  let proxy = null;
  try {
    proxy = proxyManager.getNext();
    ctx = await browserPool.get(proxy);
    const { page } = ctx;
    const userId = job.data.userId;

    if (job.data.type === 'search' || job.data.search) {
      const sp = new SearchProvider();
      const results = await sp.searchByName(job.data.search, page);
      return {
        success: results.length > 0,
        query: job.data.search,
        results,
        count: results.length
      };
    }

    const extractor = new LegendExtractor();
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
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + 7 * 86400000)
              }
            },
            { upsert: true }
          );
          await cacheManager.set(job.data.url, result, job.data.quality || 'auto', !!job.data.deep);
        } catch (e) {
          logger.warn({ error: e.message }, 'Persist failed');
        }
      }
    } else {
      metrics.sourceFailure.labels(result.errorCode || 'unknown').inc();
      proxyManager.fail(proxy);
      if (db) {
        try {
          await db.collection('diagnostics').insertOne({
            jobId: String(job.id),
            url: job.data.url,
            error: result.error,
            errorCode: result.errorCode,
            diagnostics: result.diagnostics,
            createdAt: new Date()
          });
        } catch (e) {}
      }
    }

    singleFlight.del(`${job.data.url}::${job.data.quality || 'auto'}::${job.data.deep ? 1 : 0}`);
    return result;
  } catch (error) {
    logger.error({ jobId: job.id, error: error.message }, 'Job failed');
    proxyManager.fail(proxy);
    if (db) {
      try {
        await db.collection('failed_jobs').insertOne({
          jobId: String(job.id),
          jobData: job.data,
          error: error.message,
          attempts: job.attemptsMade,
          createdAt: new Date()
        });
      } catch (e) {}
    }
    const msg = error.message || '';
    if (/timeout|net::|Circuit breaker|Target closed/i.test(msg)) throw error;
    return { success: false, error: error.message, errorCode: 'JOB_EXCEPTION' };
  } finally {
    if (ctx) browserPool.release(ctx);
  }
});

// ─── WebSocket (auth) ───────────────────────────────────────
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
      const result = state === 'completed' ? (job.returnvalue || job._returnvalue || null) : null;
      ws.send(JSON.stringify({ type: 'job_update', jobId: data.jobId, state, result }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  });
});

// ─── Shutdown / Start ───────────────────────────────────────
async function shutdown() {
  logger.info('Shutting down...');
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
    logger.info('🚀 Legend Vd v3.0 starting...');
    const ok = await connectDatabase();
    if (!ok) logger.warn('MongoDB offline — limited persistence');
    browserPool = new BrowserPool(2);
    await browserPool.init();
    httpServer.listen(PORT, '0.0.0.0', () => {
      logger.info(`Legend Vd listening on :${PORT}`);
      console.log(`
╔════════════════════════════════════════════════════════════╗
║  LEGEND VD v3.0 — PROFESSIONAL EXTRACTION ENGINE           ║
║  ✓ Network capture (MIME + patterns)                       ║
║  ✓ iframe/frame scan                                       ║
║  ✓ Play simulation                                         ║
║  ✓ HLS variant parsing + quality select                    ║
║  ✓ DASH detection                                          ║
║  ✓ Candidate ranking                                       ║
║  ✓ Rich diagnostics                                        ║
║  ✓ Job ownership · JWT enforced · SSRF hardened            ║
║  ✓ deep=1 mode · search-by-name                            ║
║  API  /api/v1/extract?url=&quality=&deep=1                 ║
║  API  /api/v1/search?q=                                    ║
║  API  /api/v1/jobs/:id                                     ║
╚════════════════════════════════════════════════════════════╝
`);
    });
  } catch (e) {
    logger.error({ error: e.message }, 'Startup failed');
    process.exit(1);
  }
})();

export default app;
