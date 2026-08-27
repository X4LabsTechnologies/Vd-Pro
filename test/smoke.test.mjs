import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('source catalog contains valid enabled HTTP sources', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../config/sources.json', import.meta.url), 'utf8'));
  const sources = Object.values(catalog).filter(Array.isArray).flat();
  assert.ok(sources.length > 0);
  assert.ok(sources.every((source) => source.enabled === true && /^https?:\/\//.test(source.url)));
});

test('external integration exports remain compatible and reject empty input safely', async () => {
  const integration = await import('../src/widevine-remote.js');
  assert.equal(typeof integration.getWidevineKeys, 'function');
  assert.equal(typeof integration.bypassCloudflare, 'function');
  assert.equal(await integration.getWidevineKeys('', ''), null);
  assert.equal(await integration.bypassCloudflare(''), null);
});
