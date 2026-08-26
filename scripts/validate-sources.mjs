import fs from 'node:fs';

const file = new URL('../config/sources.json', import.meta.url);
const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
const seen = new Set();
let count = 0;
for (const [category, sources] of Object.entries(catalog)) {
  if (!Array.isArray(sources)) continue;
  for (const source of sources) {
    if (!source.name || !source.url || source.enabled !== true) throw new Error(`invalid source in ${category}`);
    const url = new URL(source.url);
    if (!/^https?:$/.test(url.protocol)) throw new Error(`unsupported protocol for ${source.name}`);
    const key = `${category}:${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, '')}`;
    if (seen.has(key)) throw new Error(`duplicate source ${key}`);
    seen.add(key);
    count += 1;
  }
}
console.log(`sources valid: ${count}`);
