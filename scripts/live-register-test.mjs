import fs from 'node:fs';

const email = `vdpro.test.${Date.now()}@example.com`;
const password = `VdProTest-${Date.now()}-X9`;
const response = await fetch('https://vd-pro-production.up.railway.app/api/v1/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password })
});
const body = await response.json();
if (!response.ok || !body.token) {
  console.error(JSON.stringify({ status: response.status, body }));
  process.exit(1);
}
fs.writeFileSync('/tmp/vdpro_token', body.token, { mode: 0o600 });
console.log(JSON.stringify({ status: response.status, success: body.success, plan: body.plan, hasToken: true, email: 'redacted' }));
