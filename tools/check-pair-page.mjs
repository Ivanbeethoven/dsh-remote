/**
 * Verify that the live pairing page still exposes the selector the Android app reads,
 * and that the value is a usable absolute pairing URL.
 *
 * Usage: node tools/check-pair-page.mjs <relayBase> <accessKey>
 */

import https from 'node:https';

const [base, accessKey] = process.argv.slice(2);
if (base === undefined || accessKey === undefined) {
  console.error('usage: node tools/check-pair-page.mjs <relayBase> <accessKey>');
  process.exit(2);
}

const target = new URL(base);
let cookie = '';

/**
 * One GET with a shared cookie jar.
 * @param {string} pathname - Request target.
 * @returns {Promise<{ status: number, location?: string, body: string }>}
 */
function get(pathname) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: target.hostname,
      port: target.port,
      path: pathname,
      method: 'GET',
      rejectUnauthorized: false,
      timeout: 15_000,
      headers: {
        host: `${target.hostname}:${target.port}`,
        ...(cookie === '' ? {} : { cookie }),
      },
    }, (response) => {
      const setCookies = (response.headers['set-cookie'] ?? []).map((entry) => entry.split(';')[0]);
      if (setCookies.length > 0) cookie = setCookies.join('; ');
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, location: response.headers.location, body }));
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.end();
  });
}

const gate = await get(`/ssh-bridge?rk=${encodeURIComponent(accessKey)}`);
const page = gate.status === 303 ? await get(gate.location) : gate;

console.log(`pairing page status : ${page.status}`);
const hasSelector = page.body.includes('id="pair-url"');
console.log(`id="pair-url" found : ${hasSelector}`);

const match = /<pre id="pair-url">([\s\S]*?)<\/pre>/.exec(page.body);
if (match === null) {
  console.log('pair-url element    : NOT FOUND');
  process.exit(1);
}

const url = match[1].replaceAll('&amp;', '&').trim();
console.log(`pair-url content    : ${url.slice(0, 80)}${url.length > 80 ? '…' : ''}`);
console.log(`  absolute https    : ${url.startsWith('https://')}`);
console.log(`  carries rk        : ${url.includes('rk=')}`);
console.log(`  carries token     : ${url.includes('token=')}`);

process.exit(url.startsWith('https://') && url.includes('token=') ? 0 : 1);
