import fs from 'node:fs';

const token = fs.readFileSync('/tmp/vdpro_token', 'utf8').trim();
const jobId = fs.readFileSync('/tmp/vdpro_jobid', 'utf8').trim();
let last;
for (let i = 0; i < 36; i += 1) {
  const response = await fetch(`https://vd-pro-production.up.railway.app/api/v1/jobs/${encodeURIComponent(jobId)}`, { headers: { authorization: `Bearer ${token}` } });
  const body = await response.json();
  last = body;
  console.log(JSON.stringify({ attempt: i + 1, status: response.status, state: body.state, statusText: body.statusText, code: body.code, progress: body.progress }));
  if (['completed', 'failed', 'stuck'].includes(String(body.state || '').toLowerCase()) || body.finished) break;
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
fs.writeFileSync('/tmp/vdpro_job_final.json', JSON.stringify(last, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ saved: '/tmp/vdpro_job_final.json', finalState: last?.state, code: last?.code, hasResult: Boolean(last?.result) }));
