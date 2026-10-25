/**
 * The relay: one public TLS port that multiplexes a DSH host and phone browsers.
 *
 * Responsibilities, in order:
 * 1. terminate TLS;
 * 2. tell a DSH host connection (opened by the plugin) from a browser connection;
 * 3. hold authenticated host connections in an idle pool;
 * 4. gate browsers behind an access token, then hand each one a pooled host
 *    connection and become a raw byte pipe.
 *
 * Because the last step is a blind pipe, the relay never parses HTTP bodies,
 * WebSocket frames, or DSH's own protocol — it only inspects the first request head
 * to authenticate and route.
 *
 * @module dsh-ssh-bridge/relay-server
 */

import tls from 'node:tls';

import { ensureCertificate } from './relay-cert.mjs';
import {
  HANDSHAKE_VERSION,
  MAGIC,
  RESERVED_PREFIX,
  classify,
  readCookie,
  tokenEquals,
} from './relay-protocol.mjs';

/** Largest request head the relay buffers before refusing the connection. */
const MAX_HEAD_BYTES = 32 * 1024;

/** Largest host handshake line accepted. */
const MAX_HANDSHAKE_BYTES = 4 * 1024;

/** Browser cookie that carries the relay access token. */
const ACCESS_COOKIE = 'dsh_relay';

/** Terminator of an HTTP request head. */
const HEAD_TERMINATOR = Buffer.from('\r\n\r\n');

/**
 * Read from a socket until a terminator appears.
 *
 * @param {import('node:tls').TLSSocket} socket - Connection to read.
 * @param {Buffer} initial - Bytes already read.
 * @param {Buffer} terminator - Byte sequence to stop at.
 * @param {number} limit - Maximum bytes buffered before giving up.
 * @param {(head: Buffer, rest: Buffer) => void} onDone - Receives the head and leftover bytes.
 * @param {() => void} onOverflow - Called when the limit is exceeded.
 */
function readUntil(socket, initial, terminator, limit, onDone, onOverflow) {
  let buffer = initial;
  let attached = false;

  const detach = () => {
    if (attached) socket.off('data', onData);
    socket.pause();
  };

  const inspect = () => {
    const index = buffer.indexOf(terminator);
    if (index === -1) return false;
    detach();
    onDone(buffer.subarray(0, index), buffer.subarray(index + terminator.length));
    return true;
  };

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > limit) {
      detach();
      onOverflow();
      return;
    }
    inspect();
  };

  if (inspect()) return;
  attached = true;
  socket.on('data', onData);
  socket.resume();
}

/**
 * Write a complete HTTP response and close the socket.
 * @param {import('node:tls').TLSSocket} socket - Connection to answer.
 * @param {number} status - HTTP status code.
 * @param {string} body - Response body.
 * @param {Record<string, string | string[]>} [headers] - Extra headers.
 */
function respond(socket, status, body, headers = {}) {
  const payload = Buffer.from(body, 'utf8');
  const lines = [
    `HTTP/1.1 ${status} ${statusName(status)}`,
    `content-length: ${payload.length}`,
    'content-type: text/html; charset=utf-8',
    'cache-control: no-store',
    'referrer-policy: no-referrer',
    'connection: close',
  ];
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const entry of value) lines.push(`${name}: ${entry}`);
    else lines.push(`${name}: ${value}`);
  }
  socket.end(Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'), payload]));
}

/**
 * Reason phrase for a status code this relay emits.
 * @param {number} status - Status code.
 * @returns {string} Reason phrase.
 */
function statusName(status) {
  switch (status) {
    case 200: return 'OK';
    case 303: return 'See Other';
    case 403: return 'Forbidden';
    case 503: return 'Service Unavailable';
    default: return 'Error';
  }
}

/**
 * Minimal HTML escape.
 * @param {unknown} value - Value to escape.
 * @returns {string} Escaped text.
 */
function escape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Render the relay's own login page, shown when the browser has no access cookie.
 * @param {string} [message] - Optional explanation.
 * @returns {string} HTML document.
 */
function renderLogin(message) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH relay</title>
<style>
 body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;
      min-height:100vh;display:grid;place-items:center;padding:1.5rem}
 form{max-width:22rem;width:100%}
 h1{font-size:1.15rem;margin:0 0 .35rem}
 p{opacity:.7;font-size:.9rem;margin:0 0 1rem}
 input{width:100%;box-sizing:border-box;padding:.7rem .8rem;font:inherit;border-radius:.6rem;
       border:1px solid rgba(128,128,128,.45);background:transparent;color:inherit}
 button{margin-top:.7rem;width:100%;padding:.7rem;font:inherit;font-weight:600;border-radius:.6rem;
        border:0;background:#2563eb;color:#fff}
 .msg{color:#dc2626;font-size:.86rem;margin-top:.7rem}
</style></head><body>
<form method="get" action="/">
  <h1>DSH relay</h1>
  <p>Enter the access key, or open the pairing link from the DSH status page.</p>
  <input name="rk" type="password" autocomplete="current-password" placeholder="access key" autofocus>
  <button type="submit">Continue</button>
  ${message === undefined ? '' : `<div class="msg">${escape(message)}</div>`}
</form>
</body></html>`;
}

/**
 * Start the relay.
 *
 * @param {object} options - Relay options.
 * @param {number} [options.port] - Public port, default 8443.
 * @param {string} [options.bind] - Bind address, default `0.0.0.0`.
 * @param {string} options.hostToken - Secret the DSH host must present.
 * @param {string} options.accessToken - Secret a browser must present once.
 * @param {string} [options.hostId] - Expected host identifier.
 * @param {string} [options.certFile] - PEM certificate, generated when unset.
 * @param {string} [options.keyFile] - PEM key, generated when unset.
 * @param {string[]} [options.hosts] - Addresses the generated certificate must cover.
 * @param {number} [options.poolSize] - Idle host connections held, default 16.
 * @param {(level: string, message: string) => void} [options.log] - Log sink.
 * @returns {Promise<object>} Running relay handle.
 */
export async function createRelay({
  port = 8443,
  bind = '0.0.0.0',
  hostToken,
  accessToken,
  hostId = 'default',
  certFile,
  keyFile,
  hosts = [],
  poolSize = 16,
  waitMs = 6000,
  log = () => {},
} = {}) {
  if (typeof hostToken !== 'string' || hostToken.length < 16) {
    throw new Error('relay: hostToken must be at least 16 characters');
  }
  if (typeof accessToken !== 'string' || accessToken.length < 12) {
    throw new Error('relay: accessToken must be at least 12 characters');
  }

  const material = await ensureCertificate({ certFile, keyFile, hosts: [...hosts, bind === '0.0.0.0' ? '' : bind].filter(Boolean) });

  /** @type {{ socket: import('node:tls').TLSSocket, at: number, closed: boolean }[]} */
  const idle = [];
  /** @type {{ socket: import('node:tls').TLSSocket, prefix: Buffer, timer: any }[]} */
  const waiting = [];
  /** Host connections that have been handed to a browser. */
  const active = new Set();
  const stats = { served: 0, refused: 0, rejectedHosts: 0, blockedBrowsers: 0 };
  let registeredHostId;
  let closed = false;

  /**
   * Remove a dead or consumed entry from the idle pool.
   * @param {object} entry - Pool entry.
   */
  const dropIdle = (entry) => {
    const index = idle.indexOf(entry);
    if (index >= 0) idle.splice(index, 1);
  };

  /**
   * Take a live idle host connection.
   * @returns {object | undefined} A usable entry.
   */
  const takeIdle = () => {
    while (idle.length > 0) {
      const entry = idle.pop();
      if (entry.closed || entry.socket.destroyed) continue;
      return entry;
    }
    return undefined;
  };

  /**
   * Bridge any browsers that were waiting for a free host connection.
   *
   * A browser opens a handful of connections in parallel for one page — scripts, styles,
   * the WebSocket — so a small idle pool empties instantly at first paint. Rather than
   * answer 503 (which aborts those assets and leaves the app unmounted and white), a
   * request waits briefly for the next host connection to arrive.
   */
  const flushWaiting = () => {
    while (waiting.length > 0) {
      const waiter = waiting[0];
      const entry = takeIdle();
      if (entry === undefined) return;
      waiting.shift();
      clearTimeout(waiter.timer);
      bridge(waiter.socket, waiter.prefix, entry);
    }
  };

  /**
   * Queue one browser connection until a host connection frees up.
   * @param {import('node:tls').TLSSocket} socket - Browser connection.
   * @param {Buffer} prefix - Request bytes to replay to the host.
   */
  const enqueueWaiting = (socket, prefix) => {
    const waiter = { socket, prefix, timer: undefined };
    waiter.timer = setTimeout(() => {
      const index = waiting.indexOf(waiter);
      if (index < 0) return;
      waiting.splice(index, 1);
      stats.refused += 1;
      respond(socket, 503, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH relay</title><body style="font:16px/1.6 system-ui;padding:2rem">
<h1 style="font-size:1.1rem">No free relay connection</h1>
<p style="opacity:.7">The DSH host did not supply an idle connection in time. It retries
automatically — reload in a few seconds.</p></body>`);
    }, waitMs);
    waiter.timer.unref?.();

    socket.once('close', () => {
      const index = waiting.indexOf(waiter);
      if (index >= 0) waiting.splice(index, 1);
      clearTimeout(waiter.timer);
    });

    waiting.push(waiter);
  };

  /**
   * Register a connection that presented a valid host handshake.
   * @param {import('node:tls').TLSSocket} socket - Connection.
   * @param {string} claimedHostId - Host identifier from the handshake.
   */
  const registerHost = (socket, claimedHostId) => {
    if (registeredHostId === undefined) registeredHostId = claimedHostId;
    if (claimedHostId !== registeredHostId) {
      stats.rejectedHosts += 1;
      log('warn', `relay: refused host ${JSON.stringify(claimedHostId)}; this port already serves ${JSON.stringify(registeredHostId)}`);
      socket.end('ERR host-id-taken\n');
      return;
    }
    if (idle.length >= poolSize) {
      socket.end('ERR pool-full\n');
      return;
    }

    const entry = { socket, at: Date.now(), closed: false };
    const forget = () => {
      entry.closed = true;
      dropIdle(entry);
      active.delete(entry);
    };
    socket.on('close', forget);
    socket.on('error', forget);
    socket.setKeepAlive(true, 15_000);
    idle.push(entry);
    socket.resume();
    flushWaiting();
  };

  /**
   * Pipe one browser connection to one host connection.
   * @param {import('node:tls').TLSSocket} browser - Browser connection.
   * @param {Buffer} leftover - Bytes already read past the request head.
   * @param {object} entry - Host pool entry.
   */
  const bridge = (browser, leftover, entry) => {
    const host = entry.socket;
    active.add(entry);
    stats.served += 1;

    const close = () => {
      browser.destroy();
      host.destroy();
    };
    browser.on('error', close);
    host.on('error', close);
    browser.on('close', () => host.destroy());
    host.on('close', () => browser.destroy());

    if (leftover.length > 0) host.write(leftover);
    host.pipe(browser);
    browser.pipe(host);
    browser.resume();
  };

  /**
   * Answer one browser request: reserved routes first, then the access gate, then the proxy.
   * @param {import('node:tls').TLSSocket} socket - Browser connection.
   * @param {Buffer} head - Request head.
   * @param {Buffer} leftover - Bytes past the head.
   */
  const handleBrowser = (socket, head, leftover) => {
    const text = head.toString('latin1');
    const [requestLine = '', ...headerLines] = text.split('\r\n');
    const [, target = '/'] = requestLine.split(' ');
    const headers = {};
    for (const line of headerLines) {
      const index = line.indexOf(':');
      if (index > 0) headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
    }

    let url;
    try {
      url = new URL(target, 'https://relay.invalid');
    } catch {
      respond(socket, 403, 'bad request');
      return;
    }

    if (url.pathname === `${RESERVED_PREFIX}health`) {
      respond(socket, 200, `${JSON.stringify({
        ok: true,
        host: registeredHostId ?? null,
        idle: idle.length,
        active: active.size,
        served: stats.served,
      }, null, 2)}\n`, { 'content-type': 'application/json; charset=utf-8' });
      return;
    }

    /* A valid ?rk=<accessToken> authorises the request on its own — that is what the key is
       for. Two shapes:
         - the root path without a cookie is a one-time gate: answer 303, set the cookie,
           and drop the key from the URL so it stays out of history;
         - everything else (and any request that already has the cookie) is proxied with the
           key left intact, because the plugin authenticates /ssh-bridge by reading it. That
           keeps an installed app to a single hop and means a browser that drops the cookie
           still gets through instead of being bounced to itself forever. */
    const presented = url.searchParams.get('rk');
    const authenticated = tokenEquals(readCookie(headers.cookie, ACCESS_COOKIE), accessToken);
    let authorized = authenticated;

    if (presented !== null) {
      if (!tokenEquals(presented, accessToken)) {
        stats.blockedBrowsers += 1;
        respond(socket, 403, renderLogin('That access key was not accepted.'));
        return;
      }
      authorized = true;

      if (!authenticated && (url.pathname === '' || url.pathname === '/')) {
        url.searchParams.delete('rk');
        respond(socket, 303, '', {
          location: `${url.pathname === '' ? '/' : url.pathname}${url.search}`,
          'set-cookie': `${ACCESS_COOKIE}=${accessToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
        });
        return;
      }
    }

    if (!authorized) {
      stats.blockedBrowsers += 1;
      respond(socket, 200, renderLogin());
      return;
    }

    const prefix = Buffer.concat([head, HEAD_TERMINATOR, leftover]);
    const entry = takeIdle();
    if (entry !== undefined) {
      bridge(socket, prefix, entry);
      return;
    }

    enqueueWaiting(socket, prefix);
  };

  /**
   * Handle one accepted TLS connection.
   * @param {import('node:tls').TLSSocket} socket - Connection.
   */
  const onConnection = (socket) => {
    socket.setNoDelay(true);
    socket.on('error', () => {});
    const handshakeDeadline = setTimeout(() => socket.destroy(), 20_000);
    handshakeDeadline.unref?.();

    const onFirstBytes = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const kind = classify(buffer);
      if (kind === 'unknown') return;
      socket.off('data', onFirstBytes);
      clearTimeout(handshakeDeadline);
      socket.pause();

      if (kind === 'host') {
        const tail = buffer.subarray(MAGIC.length);
        readUntil(socket, tail, Buffer.from('\n'), MAX_HANDSHAKE_BYTES, (line) => {
          let payload;
          try {
            payload = JSON.parse(line.toString('utf8'));
          } catch {
            socket.end('ERR bad-handshake\n');
            return;
          }
          if (payload?.v !== HANDSHAKE_VERSION || !tokenEquals(payload?.token, hostToken)) {
            stats.rejectedHosts += 1;
            log('warn', 'relay: rejected a host connection with a bad token');
            socket.end('ERR unauthorized\n');
            return;
          }
          socket.write('OK\n');
          registerHost(socket, typeof payload.hostId === 'string' ? payload.hostId : 'default');
          log('info', `relay: host ${JSON.stringify(registeredHostId)} registered (idle ${idle.length}/${poolSize})`);
        }, () => socket.destroy());
        return;
      }

      readUntil(socket, buffer, Buffer.from('\r\n\r\n'), MAX_HEAD_BYTES, (head, rest) => {
        handleBrowser(socket, head, rest);
      }, () => respond(socket, 403, 'request head too large'));
    };

    let buffer = Buffer.alloc(0);
    socket.on('data', onFirstBytes);
  };

  const server = tls.createServer({
    cert: material.cert,
    key: material.key,
    minVersion: 'TLSv1.2',
  }, onConnection);
  server.on('tlsClientError', () => {});

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, resolve);
  });

  const address = server.address();

  return {
    server,
    port: typeof address === 'object' && address !== null ? address.port : port,
    fingerprint: material.fingerprint,
    generatedCertificate: material.generated,
    status: () => ({
      host: registeredHostId ?? null,
      idle: idle.length,
      active: active.size,
      ...stats,
    }),
    close: async () => {
      if (closed) return;
      closed = true;
      for (const entry of idle) entry.socket.destroy();
      idle.length = 0;
      for (const entry of active) entry.socket.destroy();
      active.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export { ACCESS_COOKIE, renderLogin };
