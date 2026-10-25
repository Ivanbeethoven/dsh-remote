/**
 * Walk the exact redirect chain the Android app performs, so the hand-off can be checked
 * without a device.
 *
 * Usage: node tools/check-app-flow.mjs <relayBase> <accessKey>
 */

import https from 'node:https';

const [base, accessKey] = process.argv.slice(2);
if (base === undefined || accessKey === undefined) {
  console.error('usage: node tools/check-app-flow.mjs <relayBase> <accessKey>');
  process.exit(2);
}

const target = new URL(base);
const origin = `${target.protocol}//${target.hostname}:${target.port}`;
const jar = new Map();

/**
 * One GET, carrying the shared cookie jar.
 * @param {string} url - Absolute URL.
 * @returns {Promise<{ status: number, location?: string, body: string, length: number }>}
 */
function get(url) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const cookieHeader = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    const request = https.request({
      host: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      rejectUnauthorized: false,
      timeout: 20_000,
      headers: {
        host: parsed.host,
        ...(cookieHeader === '' ? {} : { cookie: cookieHeader }),
      },
    }, (response) => {
      for (const entry of response.headers['set-cookie'] ?? []) {
        const pair = entry.split(';')[0];
        const index = pair.indexOf('=');
        if (index > 0) {
          jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
          console.log(`      set-cookie: ${pair.slice(0, index)}  (${entry.split(';').slice(1).join(';').trim()})`);
        }
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        location: response.headers.location,
        body,
        length: body.length,
      }));
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.end();
  });
}

let url = `${origin}/ssh-bridge?rk=${encodeURIComponent(accessKey)}&go=1`;
console.log(`start: ${url.replace(accessKey, '<key>')}`);

for (let hop = 1; hop <= 10; hop += 1) {
  const sent = [...jar.keys()].join(',') || '(none)';
  const response = await get(url);
  const shown = url.replace(accessKey, '<key>').replace(/token=[^&]+/, 'token=<token>');
  console.log(`  ${hop}. ${response.status}  ${shown}   [cookie sent: ${sent}]`);
  if (response.location !== undefined) {
    console.log(`      -> ${response.location.replace(accessKey, '<key>').replace(/token=[^&]+/, 'token=<token>')}`);
  }

  if (response.status >= 300 && response.status < 400 && response.location !== undefined) {
    url = new URL(response.location, url).href;
    continue;
  }

  if (response.status === 200) {
    const looksLikeDsh = /__DSH_BOOT__|<div id="root"|dsh/i.test(response.body);
    console.log(`\nfinal: 200, ${response.length} bytes, looks like the DSH UI: ${looksLikeDsh}`);
    console.log(`cookies held: ${[...jar.keys()].join(', ')}`);
    process.exit(looksLikeDsh ? 0 : 1);
  }

  console.log(`\nfinal: ${response.status}`);
  console.log(response.body.slice(0, 300));
  process.exit(1);
}

console.log('\nstill redirecting after 10 hops');
process.exit(1);
