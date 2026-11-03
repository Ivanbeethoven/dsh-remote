/**
 * The relay: one public port that serves one *or several* DSH hosts to browsers.
 *
 * Two independent axes:
 *
 * - Transport: TLS by default, or plain HTTP when the operator asks for it. Plain mode exists
 *   because a self-signed certificate costs every new browser a warning; it also puts the
 *   access key and the DSH launch token on the wire in clear text, so it is the operator's
 *   call, never an automatic fallback.
 * - Tenancy: every host registers with its own `hostId`, `hostToken`, and `accessToken`. A
 *   browser selects a host by the access key it presents — in the URL while pairing, in the
 *   `dsh_relay` cookie afterwards. That is why one port carries several machines without
 *   rewriting paths: the credential *is* the routing key.
 *
 * Per connection the relay still does one thing: it gate-checks the first request head, then
 * becomes a blind byte pipe, so HTTP keep-alive, chunked bodies, and WebSocket upgrades pass
 * through untouched.
 *
 * @module dsh-ssh-bridge/relay-server
 */

import net from 'node:net';
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

/** Browser cookie that carries a host's access token. */
const ACCESS_COOKIE = 'dsh_relay';

/** Browser cookie that remembers which machine was picked when a key is shared. */
const HOST_COOKIE = 'dsh_host';

/** Terminator of an HTTP request head. */
const HEAD_TERMINATOR = Buffer.from('\r\n\r\n');

/**
 * Read from a socket until a terminator appears.
 * @param {import('node:net').Socket} socket - Connection to read.
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
 * Write a complete HTTP response and close the socket.
 * @param {import('node:net').Socket} socket - Connection to answer.
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
 * Render the relay's own login page, shown when a browser presents no usable credential.
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
 * Normalise the accepted host shapes into one list.
 * @param {object} options - createRelay options.
 * @returns {{ hostId: string, hostToken: string, accessToken: string }[]} Hosts to serve.
 */
function normalizeHosts({ hosts, hostId = 'default', hostToken, accessToken }) {
  const source = Array.isArray(hosts) && hosts.length > 0
    ? hosts
    : [{ hostId, hostToken, accessToken }];
  return source.map((host, index) => ({
    hostId: typeof host.hostId === 'string' && host.hostId !== '' ? host.hostId : `host-${index + 1}`,
    hostToken: host.hostToken,
    accessToken: host.accessToken,
  }));
}

/**
 * Render the machine picker, shown when one access key covers several hosts.
 * @param {object[]} hosts - Hosts sharing the key.
 * @returns {string} HTML document.
 */
function renderPicker(hosts) {
  const items = hosts.map((host) => {
    const state = host.idle.length > 0
      ? `${host.idle.length} ready`
      : (host.registered ? 'reconnecting' : 'offline');
    return `  <a class="host" href="/?h=${encodeURIComponent(host.hostId)}">
    <span class="name">${escape(host.hostId)}</span>
    <span class="state${host.idle.length > 0 ? '' : ' dim'}">${state}</span>
  </a>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH relay</title>
<style>
 body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;
      min-height:100vh;display:grid;place-items:center;padding:1.5rem}
 main{max-width:24rem;width:100%}
 h1{font-size:1.15rem;margin:0 0 .35rem}
 p{opacity:.7;font-size:.9rem;margin:0 0 1rem}
 a.host{display:flex;justify-content:space-between;align-items:center;gap:.75rem;
        padding:.85rem 1rem;margin-bottom:.6rem;border-radius:.7rem;text-decoration:none;
        color:inherit;border:1px solid rgba(128,128,128,.35)}
 a.host:active{border-color:#2563eb}
 .name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .state{font-size:.78rem;opacity:.65;white-space:nowrap}
 .state.dim{opacity:.4}
</style></head><body>
<main>
  <h1>Choose a machine</h1>
  <p>This access key covers ${hosts.length} DSH machines. Your choice is remembered.</p>
${items}
</main>
</body></html>`;
}

/**
 * Start the relay.
 *
 * @param {object} options - Relay options.
 * @param {number} [options.port] - Public port, default 8443.
 * @param {string} [options.bind] - Bind address, default `0.0.0.0`.
 * @param {boolean} [options.secure] - Serve TLS. Default `true`; `false` serves plain HTTP.
 * @param {{ hostId: string, hostToken: string, accessToken: string }[]} [options.hosts] - Several hosts on one port.
 * @param {string} [options.hostToken] - Single-host shorthand.
 * @param {string} [options.accessToken] - Single-host shorthand.
 * @param {string} [options.hostId] - Single-host shorthand, default `default`.
 * @param {string} [options.certFile] - PEM certificate, generated when unset (TLS only).
 * @param {string} [options.keyFile] - PEM key, generated when unset (TLS only).
 * @param {string[]} [options.certHosts] - Addresses the generated certificate must cover.
 * @param {number} [options.poolSize] - Idle host connections held per host, default 16.
 * @param {number} [options.waitMs] - How long a browser waits for a free connection, default 6000.
 * @param {(level: string, message: string) => void} [options.log] - Log sink.
 * @returns {Promise<object>} Running relay handle.
 */
export async function createRelay({
  port = 8443,
  bind = '0.0.0.0',
  secure = true,
  hosts = [],
  hostToken,
  accessToken,
  hostId = 'default',
  certFile,
  keyFile,
  certHosts = [],
  poolSize = 16,
  waitMs = 6000,
  log = () => {},
} = {}) {
  const configured = normalizeHosts({ hosts, hostId, hostToken, accessToken });
  if (configured.length === 0) throw new Error('relay: no hosts configured');

  for (const host of configured) {
    if (typeof host.hostToken !== 'string' || host.hostToken.length < 16) {
      throw new Error(`relay: host ${host.hostId} needs a hostToken of at least 16 characters`);
    }
    if (typeof host.accessToken !== 'string' || host.accessToken.length < 12) {
      throw new Error(`relay: host ${host.hostId} needs an accessToken of at least 12 characters`);
    }
  }

  /* Several hosts may share one accessToken on purpose: that is the "one link, pick a machine"
     mode. A shared key turns those hosts into a group the browser chooses from. */
  const seenHostIds = new Set();
  for (const host of configured) {
    if (seenHostIds.has(host.hostId)) {
      throw new Error(`relay: two hosts share the same hostId (${host.hostId})`);
    }
    seenHostIds.add(host.hostId);
  }

  const material = secure
    ? await ensureCertificate({
      certFile,
      keyFile,
      hosts: [...certHosts, bind === '0.0.0.0' ? '' : bind].filter(Boolean),
    })
    : undefined;

  /** Per-host runtime: idle connections, waiting browsers, counters. */
  const table = configured.map((host) => ({
    ...host,
    idle: [],
    waiters: [],
    registered: false,
    open: 0,
    served: 0,
    refused: 0,
  }));

  const stats = { rejectedHosts: 0, rejectedBrowsers: 0 };

  /**
   * Find every host that accepts an access key. More than one means the key is shared and the
   * browser must pick a machine.
   * @param {string | null | undefined} key - Candidate access token.
   * @returns {object[]} Matching hosts, empty when the key is unknown.
   */
  const hostsByAccessKey = (key) => (key === null || key === undefined
    ? []
    : table.filter((host) => tokenEquals(key, host.accessToken)));

  /**
   * Find a host by the credentials a host connection presented.
   * @param {string} claimedHostId - Host identifier from the handshake.
   * @param {unknown} token - Host token from the handshake.
   * @returns {object | undefined} The matching host, when one exists.
   */
  const hostByHostToken = (claimedHostId, token) => table.find(
    (host) => host.hostId === claimedHostId && tokenEquals(token, host.hostToken),
  );

  /**
   * Drop one idle entry.
   * @param {object} host - Host record.
   * @param {object} entry - Pool entry.
   */
  const dropIdle = (host, entry) => {
    const index = host.idle.indexOf(entry);
    if (index >= 0) host.idle.splice(index, 1);
  };

  /**
   * Take a live idle connection for one host.
   * @param {object} host - Host record.
   * @returns {object | undefined} A usable entry.
   */
  const takeIdle = (host) => {
    while (host.idle.length > 0) {
      const entry = host.idle.pop();
      if (entry.closed || entry.socket.destroyed) continue;
      return entry;
    }
    return undefined;
  };

  /**
   * Pipe one browser connection to one host connection.
   * @param {import('node:net').Socket} browser - Browser connection.
   * @param {Buffer} prefix - Request bytes to replay to the host.
   * @param {object} host - Host record.
   * @param {object} entry - Host pool entry.
   */
  const bridge = (browser, prefix, host, entry) => {
    const upstream = entry.socket;
    host.open += 1;
    host.served += 1;

    const close = () => {
      browser.destroy();
      upstream.destroy();
    };
    browser.on('error', close);
    upstream.on('error', close);
    browser.on('close', () => {
      host.open = Math.max(0, host.open - 1);
      upstream.destroy();
    });
    upstream.on('close', () => browser.destroy());

    if (prefix.length > 0) upstream.write(prefix);
    upstream.pipe(browser);
    browser.pipe(upstream);
    browser.resume();
  };

  /**
   * Bridge any browsers of one host that were waiting for a free connection.
   * @param {object} host - Host record.
   */
  const flushWaiting = (host) => {
    while (host.waiters.length > 0) {
      const waiter = host.waiters[0];
      const entry = takeIdle(host);
      if (entry === undefined) return;
      host.waiters.shift();
      clearTimeout(waiter.timer);
      bridge(waiter.socket, waiter.prefix, host, entry);
    }
  };

  /**
   * Queue a browser until one of its host's connections frees up.
   * @param {import('node:net').Socket} socket - Browser connection.
   * @param {Buffer} prefix - Request bytes to replay.
   * @param {object} host - Host record.
   */
  const enqueueWaiting = (socket, prefix, host) => {
    const waiter = { socket, prefix, timer: undefined };
    waiter.timer = setTimeout(() => {
      const index = host.waiters.indexOf(waiter);
      if (index < 0) return;
      host.waiters.splice(index, 1);
      host.refused += 1;
      respond(socket, 503, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH relay</title><body style="font:16px/1.6 system-ui;padding:2rem">
<h1 style="font-size:1.1rem">No free relay connection</h1>
<p style="opacity:.7">${escape(host.hostId)} did not supply an idle connection in time. It retries
automatically — reload in a few seconds.</p></body>`);
    }, waitMs);
    waiter.timer.unref?.();

    socket.once('close', () => {
      const index = host.waiters.indexOf(waiter);
      if (index >= 0) host.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
    });

    host.waiters.push(waiter);
  };

  /**
   * Add one authenticated connection to a host's idle pool.
   * @param {import('node:net').Socket} socket - Connection.
   * @param {object} host - The host this connection belongs to.
   */
  const registerHost = (socket, host) => {
    if (host.idle.length >= poolSize) {
      socket.end('ERR pool-full\n');
      return;
    }

    const entry = { socket, at: Date.now(), closed: false };
    const forget = () => {
      entry.closed = true;
      dropIdle(host, entry);
    };
    socket.on('close', forget);
    socket.on('error', forget);
    socket.setKeepAlive(true, 15_000);
    host.idle.push(entry);
    if (!host.registered) {
      host.registered = true;
      log('info', `relay: host ${JSON.stringify(host.hostId)} registered`);
    }
    socket.resume();
    flushWaiting(host);
  };

  /**
   * Answer one browser request: reserved health route, then per-host gating, then the proxy.
   * @param {import('node:net').Socket} socket - Browser connection.
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
      url = new URL(target, 'http://relay.invalid');
    } catch {
      respond(socket, 403, 'bad request');
      return;
    }

    if (url.pathname === `${RESERVED_PREFIX}health`) {
      respond(socket, 200, `${JSON.stringify({
        ok: true,
        secure,
        hosts: table.map((host) => ({
          hostId: host.hostId,
          registered: host.registered,
          idle: host.idle.length,
          open: host.open,
          served: host.served,
          refused: host.refused,
        })),
      }, null, 2)}\n`, { 'content-type': 'application/json; charset=utf-8' });
      return;
    }

    /* The credential selects a *group*: `?rk=` while pairing, the cookie afterwards. A cookie
       always wins, so a stale key cannot redirect an authenticated session. When several hosts
       share one key, `dsh_host` picks one and the root offers a picker instead. */
    const presented = url.searchParams.get('rk');
    const cookieKey = readCookie(headers.cookie, ACCESS_COOKIE);
    const cookieGroup = hostsByAccessKey(cookieKey);
    const presentedGroup = hostsByAccessKey(presented);
    const group = cookieGroup.length > 0 ? cookieGroup : presentedGroup;

    if (group.length === 0) {
      if (presented !== null) {
        stats.rejectedBrowsers += 1;
        respond(socket, 403, renderLogin('That access key was not accepted.'));
        return;
      }
      respond(socket, 200, renderLogin());
      return;
    }

    if (cookieGroup.length === 0) {
      if (presentedGroup.length === 0) {
        respond(socket, 200, renderLogin());
        return;
      }
      /* Gate once on the root path and drop the key from the redirect. Deeper paths are
         proxied with the key intact, which is what lets an installed app pair in one hop. */
      if (url.pathname === '' || url.pathname === '/') {
        url.searchParams.delete('rk');
        const attributes = `Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`;
        respond(socket, 303, '', {
          location: `${url.pathname === '' ? '/' : url.pathname}${url.search}`,
          'set-cookie': `${ACCESS_COOKIE}=${group[0].accessToken}; ${attributes}`,
        });
        return;
      }
    }

    const requestedId = url.searchParams.get('h');
    const requested = requestedId === null
      ? undefined
      : group.find((host) => host.hostId === requestedId);
    if (requested !== undefined) {
      url.searchParams.delete('h');
      const attributes = `Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`;
      respond(socket, 303, '', {
        location: `${url.pathname === '' ? '/' : url.pathname}${url.search}`,
        'set-cookie': `${HOST_COOKIE}=${requested.hostId}; ${attributes}`,
      });
      return;
    }

    const chosenId = readCookie(headers.cookie, HOST_COOKIE);
    const chosen = chosenId === undefined ? undefined : group.find((host) => host.hostId === chosenId);

    /* A shared key with no machine chosen yet gets the picker; a per-machine key goes straight
       through, so existing single-host links keep working unchanged. */
    if (group.length > 1 && chosen === undefined) {
      respond(socket, 200, renderPicker(group));
      return;
    }

    const host = chosen ?? group[0];

    const prefix = Buffer.concat([head, HEAD_TERMINATOR, leftover]);
    const entry = takeIdle(host);
    if (entry !== undefined) {
      bridge(socket, prefix, host, entry);
      return;
    }
    enqueueWaiting(socket, prefix, host);
  };

  /**
   * Handle one accepted connection.
   * @param {import('node:net').Socket} socket - Connection.
   */
  const onConnection = (socket) => {
    socket.setNoDelay(true);
    socket.on('error', () => {});
    const handshakeDeadline = setTimeout(() => socket.destroy(), 20_000);
    handshakeDeadline.unref?.();

    let buffer = Buffer.alloc(0);

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
          if (payload?.v !== HANDSHAKE_VERSION) {
            socket.end('ERR bad-handshake\n');
            return;
          }
          /* Resolve the host before acknowledging: a client must see the refusal as its
             handshake reply, not as a connection that succeeded and then vanished. */
          const host = hostByHostToken(
            typeof payload.hostId === 'string' ? payload.hostId : 'default',
            payload.token,
          );
          if (host === undefined) {
            stats.rejectedHosts += 1;
            log('warn', `relay: rejected host connection for ${JSON.stringify(payload.hostId)} (unknown id or token)`);
            socket.end('ERR unauthorized\n');
            return;
          }
          socket.write('OK\n');
          registerHost(socket, host);
        }, () => socket.destroy());
        return;
      }

      readUntil(socket, buffer, HEAD_TERMINATOR, MAX_HEAD_BYTES, (head, rest) => {
        handleBrowser(socket, head, rest);
      }, () => respond(socket, 403, 'request head too large'));
    };

    socket.on('data', onFirstBytes);
  };

  const server = secure
    ? tls.createServer({ cert: material.cert, key: material.key, minVersion: 'TLSv1.2' }, onConnection)
    : net.createServer(onConnection);
  server.on('tlsClientError', () => {});

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, resolve);
  });

  const address = server.address();

  return {
    server,
    secure,
    port: typeof address === 'object' && address !== null ? address.port : port,
    fingerprint: material?.fingerprint,
    generatedCertificate: material?.generated ?? false,
    status: () => ({
      secure,
      hosts: table.map((host) => ({
        hostId: host.hostId,
        registered: host.registered,
        idle: host.idle.length,
        open: host.open,
        served: host.served,
        refused: host.refused,
      })),
      ...stats,
    }),
    close: async () => {
      for (const host of table) {
        for (const entry of host.idle) entry.socket.destroy();
        host.idle.length = 0;
        for (const waiter of host.waiters) {
          clearTimeout(waiter.timer);
          waiter.socket.destroy();
        }
        host.waiters.length = 0;
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export { ACCESS_COOKIE, renderLogin };
