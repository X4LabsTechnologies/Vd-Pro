from pathlib import Path

path = Path('/home/ubuntu/Vd-Pro-upgrade/server.js')
text = path.read_text(encoding='utf-8')

if 'async discoverEmbeddedCandidates' in text:
    print('generic extractor upgrade already applied')
    raise SystemExit(0)

old = """      try {
        const frames = page.frames().slice(0, deep ? 10 : 6);
        diagnostics.framesVisited = page.frames().length;
        for (const frame of frames) {
          try {
            const html = await frame.content();
            this.mineHtml(html, bags, pageUrl);
            const fu = await frame.evaluate(() => {
              const out = [];
              document.querySelectorAll('video').forEach((v) => {
                if (v.currentSrc) out.push(v.currentSrc);
                if (v.src) out.push(v.src);
              });
              (window.__vdCaptured || []).forEach((x) => out.push(x.url));
              return out;
            });
            fu.forEach((u) => this.add(bags, u));
          } catch (e) {}
        }
        diagnostics.strategies.push('frames');
      } catch (e) {}

      const mid = this.toObj(bags, pageUrl);
      if (deep && !(mid.m3u8.length || mid.mp4.length || mid.mpd.length)) {
        diagnostics.playClicked = (await tryClickPlay(page)) || diagnostics.playClicked;
        await page.waitForTimeout(3500);
        try {
          const html2 = await page.content();
          this.mineHtml(html2, bags, pageUrl);
        } catch (e) {}
        diagnostics.strategies.push('deep-pass');
      }
"""

new = """      try {
        const frames = page.frames().slice(0, deep ? 10 : 6);
        diagnostics.framesVisited = page.frames().length;
        for (const frame of frames) {
          try {
            const html = await frame.content();
            this.mineHtml(html, bags, pageUrl);
            const fu = await frame.evaluate(() => {
              const out = [];
              document.querySelectorAll('video, audio, source').forEach((v) => {
                if (v.currentSrc) out.push(v.currentSrc);
                if (v.src) out.push(v.src);
                if (v.getAttribute('data-src')) out.push(v.getAttribute('data-src'));
              });
              document.querySelectorAll('iframe').forEach((f) => {
                if (f.src) out.push(f.src);
                if (f.getAttribute('data-src')) out.push(f.getAttribute('data-src'));
              });
              (window.__vdCaptured || []).forEach((x) => out.push(x.url));
              return out;
            });
            fu.forEach((u) => this.add(bags, u));
          } catch (e) {}
        }
        diagnostics.framesVisited = Math.max(diagnostics.framesVisited, page.frames().length);
        diagnostics.strategies.push('frames');
      } catch (e) {}

      let mid = this.toObj(bags, pageUrl);
      if (!(mid.m3u8.length || mid.mp4.length || mid.mpd.length || mid.webm.length)) {
        try {
          const embedded = await this.discoverEmbeddedCandidates(page, pageUrl, deep);
          if (embedded.length) {
            diagnostics.embeddedCandidates = embedded.length;
            for (const candidate of embedded) this.add(bags, candidate);
            diagnostics.strategies.push('embedded-candidates');
            await this.probeEmbeddedCandidates(page, embedded, bags, diagnostics, deep);
          }
        } catch (e) {
          diagnostics.embeddedWarning = e.message;
        }
        mid = this.toObj(bags, pageUrl);
      }

      if (deep && !(mid.m3u8.length || mid.mp4.length || mid.mpd.length || mid.webm.length)) {
        diagnostics.playClicked = (await tryClickPlay(page)) || diagnostics.playClicked;
        await page.waitForTimeout(3500);
        try {
          const html2 = await page.content();
          this.mineHtml(html2, bags, pageUrl);
          for (const frame of page.frames().slice(0, 10)) {
            try { this.mineHtml(await frame.content(), bags, pageUrl); } catch (e) {}
          }
        } catch (e) {}
        diagnostics.strategies.push('deep-pass');
      }
"""

if old not in text:
    raise SystemExit('target extraction block not found')
text = text.replace(old, new, 1)

needle = """  }
}

class ResultValidator {
"""
methods = """  async discoverEmbeddedCandidates(page, baseUrl, deep = false) {
    const base = new URLParser(baseUrl);
    const raw = await page.evaluate(() => {
      const values = [];
      const add = (value) => {
        if (typeof value === 'string' && value.trim()) values.push(value.trim());
      };
      document.querySelectorAll('iframe, video, audio, source, a, [data-src], [data-url], [data-href]').forEach((el) => {
        ['src', 'href', 'data-src', 'data-url', 'data-href', 'data-play', 'data-player'].forEach((key) => add(el.getAttribute(key)));
      });
      document.querySelectorAll('script').forEach((s) => add(s.textContent || ''));
      return values;
    });
    const out = new Set();
    const add = (value) => {
      if (!value || typeof value !== 'string') return;
      const candidates = [value];
      const decoded = value.replace(/\\u002F/g, '/').replace(/\\\//g, '/');
      if (decoded !== value) candidates.push(decoded);
      for (const item of candidates) {
        const matches = item.match(/https?:\\/\\/[^\\s"'<>`\\\\]+/gi) || [];
        for (const match of matches) {
          try {
            const u = new URLParser(match.replace(/[),;]+$/, ''));
            if (!['http:', 'https:'].includes(u.protocol)) continue;
            if (u.href === base.href) continue;
            const path = (u.pathname + u.search).toLowerCase();
            const likelyPlayer = /iframe|embed|player|play|watch|video|stream|source|file|download|m3u8|mp4|mpd/.test(path);
            if (u.hostname !== base.hostname || likelyPlayer) out.add(u.href);
          } catch (e) {}
        }
      }
    };
    for (const value of raw) add(value);
    return [...out].slice(0, deep ? 12 : 6);
  }

  async probeEmbeddedCandidates(page, candidates, bags, diagnostics, deep = false) {
    const context = page.context();
    for (const candidate of candidates.slice(0, deep ? 8 : 4)) {
      let child = null;
      try {
        child = await context.newPage();
        child.on('request', (req) => {
          try { if (looksLikeMedia(req.url())) this.add(bags, req.url()); } catch (e) {}
        });
        child.on('response', (res) => {
          try {
            const u = res.url();
            const ct = res.headers()['content-type'] || '';
            if (looksLikeMedia(u, ct)) this.add(bags, u, ct);
          } catch (e) {}
        });
        await child.goto(candidate, { waitUntil: 'domcontentloaded', timeout: Math.min(NAV_TIMEOUT_MS, 20000) });
        await tryClickPlay(child);
        await child.waitForTimeout(deep ? 2200 : 1200);
        this.mineHtml(await child.content(), bags, candidate);
        const media = await child.evaluate(() => {
          const out = [];
          document.querySelectorAll('video, audio, source').forEach((el) => {
            if (el.currentSrc) out.push(el.currentSrc);
            if (el.src) out.push(el.src);
            if (el.getAttribute('data-src')) out.push(el.getAttribute('data-src'));
          });
          (window.__vdCaptured || []).forEach((x) => out.push(x.url));
          return out;
        });
        media.forEach((u) => this.add(bags, u));
        diagnostics.framesVisited += child.frames().length;
        const found = this.toObj(bags, candidate);
        if (found.m3u8.length || found.mp4.length || found.mpd.length || found.webm.length) break;
      } catch (e) {
        diagnostics.embeddedErrors = (diagnostics.embeddedErrors || 0) + 1;
      } finally {
        try { await child?.close(); } catch (e) {}
      }
    }
  }
}

class ResultValidator {
"""
if needle not in text:
    raise SystemExit('class insertion point not found')
text = text.replace(needle, "  }\n" + methods + "}\n\nclass ResultValidator {\n", 1)
path.write_text(text, encoding='utf-8')
print('patched', path)
