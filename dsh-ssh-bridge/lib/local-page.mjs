/**
 * A fixed, loopback-only pairing page for the owner.
 *
 * The DSH web listener's port is chosen per launch, and the Desktop shell renders over
 * `file://` without a browser cookie, so there is no stable address an owner can bookmark
 * to reach `/ssh-bridge`. This page solves that: it binds one fixed loopback port and
 * always renders the *current* pairing material, so a bookmark keeps working across DSH
 * restarts and launch-token rotation.
 *
 * It serves nothing but status and the pairing link, and it is gated by the relay access
 * key — the same secret that link already carries.
 *
 * @module dsh-ssh-bridge/local-page
 */

import http from 'node:http';

import { renderStatusPage } from './page.mjs';
import { tokenEquals } from './relay-protocol.mjs';

/**
 * Whether a request carries the access key, as a query parameter or a cookie.
 * @param {import('node:http').IncomingMessage} request - HTTP request.
 * @param {import('node:http').ServerResponse} response - Response, used to set the cookie once.
 * @param {string} accessKey - Configured access key; empty disables the gate.
 * @returns {boolean} Whether the caller may proceed.
 */
function allow(request, response, accessKey) {
  if (accessKey === '') return true;

  let url;
  try {
    url = new URL(request.url ?? '/', 'http://127.0.0.1');
  } catch {
    return false;
  }

  if (tokenEquals(url.searchParams.get('rk'), accessKey)) {
    /* Remember it, so the bare bookmark works from the next visit on. */
    response.setHeader('set-cookie', `dsh_pair=${accessKey}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
    return true;
  }

  const cookie = request.headers.cookie ?? '';
  for (const part of cookie.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === 'dsh_pair' && tokenEquals(part.slice(index + 1).trim(), accessKey)) {
      return true;
    }
  }
  return false;
}

/**
 * Start the loopback pairing page.
 *
 * @param {object} options - Page options.
 * @param {string} [options.host] - Bind address; loopback by default.
 * @param {number} options.port - Fixed port to bind.
 * @param {string} [options.accessKey] - Relay access key used as the gate.
 * @param {() => object} options.getStatus - Transport snapshot.
 * @param {() => Promise<object | undefined>} options.getPairing - Current pairing material.
 * @param {(level: string, message: string) => void} [options.log] - Log sink.
 * @returns {Promise<{ port: number, close: () => Promise<void> }>} Running page handle.
 */
export async function startLocalPage({ host = '127.0.0.1', port, accessKey = '', getStatus, getPairing, log = () => {} }) {
  const server = http.createServer((request, response) => {
    const pathname = (() => {
      try {
        return new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      } catch {
        return '/';
      }
    })();

    if (pathname === '/health') {
      const status = getStatus();
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(`${JSON.stringify({ ok: true, state: status.state })}\n`);
      return;
    }

    if (!allow(request, response, accessKey)) {
      response.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH bridge pairing</title>
<body style="font:16px/1.6 system-ui;padding:2rem;max-width:30rem">
<h1 style="font-size:1.1rem">Pairing needs the access key</h1>
<p style="opacity:.7">Open this page with <code>?rk=&lt;access key&gt;</code> once; it is remembered afterwards.</p>
<p style="opacity:.7">The key is <code>relay.accessToken</code> in the plugin configuration.</p>
</body>`);
      return;
    }

    void (async () => {
      const status = getStatus();
      let material;
      try {
        material = await getPairing();
      } catch {
        material = undefined;
      }

      if (pathname === '/status') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(`${JSON.stringify({
          ...status,
          pairing: material === undefined
            ? null
            : { mode: material.mode, url: material.url, tokenUrl: material.tokenUrl ?? null },
        }, null, 2)}\n`);
        return;
      }

      const hint = material === undefined
        ? 'Waiting for the first successful connection before a pairing link exists.'
        : undefined;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(renderStatusPage({ status, pairing: material, hint }));
    })().catch(() => {
      try {
        response.destroy();
      } catch {
        // The client is already gone.
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const bound = typeof address === 'object' && address !== null ? address.port : port;
  log('info', `ssh-bridge: pairing page on http://${host}:${bound}/${accessKey === '' ? '' : `?rk=${accessKey}`}`);

  return {
    port: bound,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
