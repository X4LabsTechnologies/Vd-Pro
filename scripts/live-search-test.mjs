import fs from 'node:fs';

const token = fs.readFileSync('/tmp/vdpro_token', 'utf8').trim();
const url = new URL('https://vd-pro-production.up.railway.app/api/v1/search');
url.searchParams.set('q', 'Interstellar');
url.searchParams.set('site', 'Fasel HD');
url.searchParams.set('extract', '1');
url.searchParams.set('deep', '1');
const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
const body = await response.json();
if (!response.ok || !body.jobId) {
  console.error(JSON.stringify({ status: response.status, body }));
  process.exit(1);
}
fs.writeFileSync('/tmp/vdpro_jobid', String(body.jobId), { mode: 0o600 });
console.log(JSON.stringify({ status: response.status, success: body.success, jobId: body.jobId, mode: body.mode, statusUrl: body.statusUrl }));
