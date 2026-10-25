/**
 * Walk the app's hand-off, then check what a real browser needs next: every asset the
 * index page references, and the WebSocket the DSH client opens.
 *
 * Usage: node tools/check-assets.mjs <relayBase> <accessKey>
 */

import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';

const [base, accessKey] = process.argv.slice(2);
if (base === undefined || accessKey === undefined) {
  console.error('usage: node tools/check-assets.mjs <relayBase> <accessKey>');
  process.exit(2);
}

const target = new URL(base);
const origin = `${target.protocol}//${target.hostname}:${target.port}`;
const jar = new Map();

/**
 * One GET with the shared cookie jar.
 * @param {string} url - Absolute URL.
 * @param {object} [options] - Extra request options.
 * @returns {Promise<{ status: number, location?: string, body: string, headers: object }>}
 */
function get(url, options = {}) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const cookieHeader = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    const request = https.request({
      host: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      rejectUnauthorized: false,
      timeout: 20_000,
      headers: {
        host: parsed.host,
        ...(cookieHeader === '' ? {} : { cookie: cookieHeader }),
        ...(options.headers ?? {}),
      },
    }, (response) => {
      for (const entry of response.headers['set-cookie'] ?? []) {
        const pair = entry.split(';')[0];
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
        headers: response.headers,
      }));
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.end();
  });
}

/* 1. Complete the hand-off. */
let url = `${origin}/ssh-bridge?rk=${encodeURIComponent(accessKey)}&go=1`;
for (let hop = 0; hop < 8; hop += 1) {
  const response = await get(url);
  if (response.status >= 300 && response.status < 400 && response.location !== undefined) {
    url = new URL(response.location, url).href;
    continue;
  }
  console.log(`hand-off ended with ${response.status}`);
  break;
}
console.log(`cookies: ${[...jar.keys()].map((name) => name.split('-')[0]).join(', ')}`);

/* 2. Fetch the index and every asset it references. */
const index = await get(`${origin}/`);
console.log(`\nindex: ${index.status}, ${index.body.length} bytes`);

const refs = new Set();
const decodeHtml = (value) => value.replaceAll('&amp;', '&').replaceAll('&#39;', "'").replaceAll('&quot;', '"');
for (const match of index.body.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const raw = decodeHtml(match[1]);
  if (raw.startsWith('data:') || raw.startsWith('#')) continue;
  refs.add(raw.startsWith('/') ? raw : `/${raw}`);
}

let bad = 0;
for (const ref of [...refs].slice(0, 25)) {
  const asset = await get(new URL(ref, origin).href);
  const ok = asset.status === 200;
  if (!ok) bad += 1;
  console.log(`  ${String(asset.status).padEnd(4)} ${String(asset.body.length).padStart(7)}B  ${asset.headers['content-type'] ?? '?'}  ${ref.slice(0, 70)}`);
}
console.log(`assets: ${refs.size} referenced, ${bad} failed`);

/* 3. Attempt the WebSocket upgrade the client depends on. */
const key = crypto.randomBytes(16).toString('base64');
const cookies = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');

const upgraded = await new Promise((resolve) => {
  const socket = tls.connect({ host: target.hostname, port: target.port || 443, rejectUnauthorized: false }, () => {
    socket.write([
      'GET /api/remote.mux HTTP/1.1',
      `host: ${target.hostname}:${target.port}`,
      'upgrade: websocket',
      'connection: Upgrade',
      `sec-websocket-key: ${key}`,
      'sec-websocket-version: 13',
      `cookie: ${cookies}`,
      'origin: ' + origin,
      '', '',
    ].join('\r\n'));
  });
  let buffer = '';
  socket.setTimeout(12_000, () => { socket.destroy(); resolve({ status: 'timeout', head: '' }); });
  socket.on('data', (chunk) => {
    buffer += chunk.toString('latin1');
    if (buffer.includes('\r\n\r\n')) {
      const status = Number(buffer.split(' ')[1]);
      socket.destroy();
      resolve({ status, head: buffer.slice(0, 160) });
    }
  });
  socket.on('error', (error) => resolve({ status: `ERR ${error.message}`, head: '' }));
});

console.log(`\nwebsocket /api/remote.mux -> ${upgraded.status}`);
if (upgraded.status !== 101) console.log(`  ${JSON.stringify(upgraded.head)}`);

process.exit(bad === 0 && upgraded.status === 101 ? 0 : 1);
