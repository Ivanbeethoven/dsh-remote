/**
 * A minimal browser stand-in for relay tests: one HTTP/1.1 request over TLS (or a plain
 * socket), connection close. Deliberately dumb so the test asserts on bytes, not on a
 * client library's behaviour.
 *
 * @module tests/helpers/relay-phone
 */

import net from 'node:net';
import tls from 'node:tls';

/**
 * Decode a chunked transfer-encoded body.
 * @param {Buffer} buffer - Raw bytes after the response head.
 * @returns {string} Decoded text.
 */
function decodeChunked(buffer) {
  const parts = [];
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd === -1) break;
    const size = Number.parseInt(buffer.subarray(offset, lineEnd).toString('latin1'), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    parts.push(buffer.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts).toString('utf8');
}

/**
 * Split a raw HTTP response into status, headers, and a decoded body.
 * @param {Buffer} buffer - Complete response bytes.
 * @returns {{ status: number, headers: Record<string, string>, body: string }} Parsed response.
 */
function parseResponse(buffer) {
  const split = buffer.indexOf('\r\n\r\n');
  if (split === -1) throw new Error(`no response head in ${JSON.stringify(buffer.toString('utf8').slice(0, 200))}`);

  const headLines = buffer.subarray(0, split).toString('latin1').split('\r\n');
  const status = Number(headLines[0].split(' ')[1]);
  const headers = {};
  for (const line of headLines.slice(1)) {
    const index = line.indexOf(':');
    if (index > 0) headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
  }

  const raw = buffer.subarray(split + 4);
  const body = /chunked/i.test(headers['transfer-encoding'] ?? '') ? decodeChunked(raw) : raw.toString('utf8');
  return { status, headers, body };
}

/**
 * Send one HTTP request to the relay.
 *
 * @param {object} options - Request inputs.
 * @param {number} options.port - Relay port on loopback.
 * @param {string} [options.path] - Request target.
 * @param {string} [options.cookie] - `Cookie` header value.
 * @param {string} [options.method] - HTTP method.
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: string }>}
 */
export function request({ port, path = '/', cookie, method = 'GET', secure = true }) {
  return new Promise((resolve, reject) => {
    const onConnect = () => {
      const lines = [`${method} ${path} HTTP/1.1`, 'host: 127.0.0.1', 'connection: close'];
      if (cookie !== undefined) lines.push(`cookie: ${cookie}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    };
    const socket = secure
      ? tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, onConnect)
      : net.connect({ host: '127.0.0.1', port }, onConnect);

    let buffer = Buffer.alloc(0);
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error('relay did not answer within 10s'));
    });
    socket.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); });
    socket.on('error', reject);
    socket.on('close', () => {
      try {
        resolve(parseResponse(buffer));
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * Perform the two-step pairing exchange and return the cookie.
 *
 * @param {object} options - Pairing inputs.
 * @param {number} options.port - Relay port.
 * @param {string} options.accessToken - Relay access key.
 * @param {string} [options.extraQuery] - Extra query string without the leading `&`.
 * @param {boolean} [options.secure] - Use TLS; `false` for a plain relay.
 * @returns {Promise<{ cookie: string, location: string, status: number }>}
 */
export async function pair({ port, accessToken, extraQuery, secure = true }) {
  const query = extraQuery === undefined ? `rk=${encodeURIComponent(accessToken)}` : `rk=${encodeURIComponent(accessToken)}&${extraQuery}`;
  const first = await request({ port, path: `/?${query}`, secure });
  const setCookie = first.headers['set-cookie'];
  if (setCookie === undefined) throw new Error(`pairing did not set a cookie (status ${first.status})`);
  return { cookie: setCookie.split(';')[0], location: first.headers.location ?? '', status: first.status };
}
