/**
 * Stand-in for a phone: drives the real relay over the real internet, following the same
 * two cookie exchanges a phone browser performs.
 *
 * Usage: node tools/live-phone.mjs <baseUrl> <accessKey> <dshLaunchToken>
 *   e.g. node tools/live-phone.mjs https://relay.example.com:8443 ACCESS TOKEN
 */

import https from 'node:https';

const [base, accessKey, launchToken] = process.argv.slice(2);
if (base === undefined || accessKey === undefined || launchToken === undefined) {
  console.error('usage: node tools/live-phone.mjs <baseUrl> <accessKey> <launchToken>');
  process.exit(2);
}

const target = new URL(base);
const jar = new Map();

/**
 * One HTTPS request with the shared cookie jar.
 * @param {string} pathname - Request target, including query.
 * @returns {Promise<{ status: number, location?: string, body: string, cookies: string[] }>}
 */
function get(pathname) {
  return new Promise((resolve, reject) => {
    const cookieHeader = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    const request = https.request({
      host: target.hostname,
      port: target.port,
      path: pathname,
      method: 'GET',
      rejectUnauthorized: false,
      timeout: 20_000,
      headers: {
        host: `${target.hostname}:${target.port}`,
        ...(cookieHeader === '' ? {} : { cookie: cookieHeader }),
      },
    }, (response) => {
      const setCookies = response.headers['set-cookie'] ?? [];
      for (const entry of setCookies) {
        const [pair] = entry.split(';');
        const index = pair.indexOf('=');
        if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        location: response.headers.location,
        body,
        cookies: setCookies.map((entry) => entry.split(';')[0]),
      }));
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.end();
  });
}

console.log(`[phone] base ${base}`);

const step1 = await get(`/?rk=${encodeURIComponent(accessKey)}&token=${encodeURIComponent(launchToken)}`);
console.log(`[phone] 1) relay gate -> ${step1.status} -> ${step1.location ?? '(no location)'}`);
if (step1.cookies.length > 0) console.log(`[phone]    relay cookie: ${step1.cookies[0]}`);
if (step1.status !== 303) {
  console.log(`[phone]    body: ${step1.body.slice(0, 200)}`);
  process.exit(1);
}

const step2 = await get(step1.location);
console.log(`[phone] 2) DSH token  -> ${step2.status} -> ${step2.location ?? '(no location)'}`);
if (step2.cookies.length > 0) console.log(`[phone]    DSH cookie: ${step2.cookies[0].split('=')[0]}=…`);
if (step2.status !== 303) {
  console.log(`[phone]    body: ${step2.body.slice(0, 300)}`);
  process.exit(1);
}

const step3 = await get('/');
console.log(`[phone] 3) index      -> ${step3.status}, ${step3.body.length} bytes`);
console.log(`[phone]    looks like the DSH shell: ${/__DSH_BOOT__|<div id="root"|dsh/i.test(step3.body)}`);
if (step3.status !== 200) {
  console.log(`[phone]    body: ${step3.body.slice(0, 300)}`);
  process.exit(1);
}

const status = await get('/ssh-bridge/status');
console.log(`[phone] 4) bridge status -> ${status.status}`);
if (status.status === 200) {
  const parsed = JSON.parse(status.body);
  console.log(`[phone]    transport=${parsed.mode} state=${parsed.state} idle=${parsed.idle}/${parsed.poolSize} served=${parsed.stats?.served}`);
  console.log(`[phone]    pairing.url=${parsed.pairing?.url}`);
  console.log(`[phone]    relay=${parsed.relay?.host}:${parsed.relay?.port} public=${parsed.relay?.publicUrl}`);
} else {
  console.log(`[phone]    body: ${status.body.slice(0, 200)}`);
}

process.exit(0);
