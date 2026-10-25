/**
 * Plugin-side transport for the relay: keeps a small pool of idle, authenticated TLS
 * connections open to the relay so a browser connection is bridged the instant it
 * arrives — no extra round trip, no custom multiplexing.
 *
 * The pool is also the health signal: a non-empty pool means the relay is reachable
 * and willing to take traffic.
 *
 * @module dsh-ssh-bridge/relay-client
 */

import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';

import { MAGIC, encodeHandshake, fingerprintOf, tokenEquals } from './relay-protocol.mjs';

/** Largest handshake reply accepted from the relay. */
const MAX_REPLY_BYTES = 256;

/**
 * Whether a host string is an IP literal (no SNI, no hostname verification value).
 * @param {string} host - Address or name.
 * @returns {boolean} True for IP literals.
 */
function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/**
 * Maintains idle relay connections and bridges them to the local DSH listener.
 *
 * @extends EventEmitter
 */
export class RelayClient extends EventEmitter {
  #config;
  #resolveTarget;
  #log;
  /** @type {{ socket: import('node:tls').TLSSocket, at: number }[]} */
  #pool = [];
  #timer;
  #stopped = true;
  #state = 'stopped';
  #lastError;
  #connectedAt;
  #opening = 0;
  #failures = 0;
  #stats = { served: 0, failed: 0 };

  /**
   * @param {object} options - Construction inputs.
   * @param {object} options.config - Resolved relay configuration.
   * @param {() => ({ host: string, port: number } | undefined)} options.resolveTarget - Live DSH listener.
   * @param {(level: string, message: string) => void} [options.log] - Log sink.
   */
  constructor({ config, resolveTarget, log }) {
    super();
    this.#config = config;
    this.#resolveTarget = resolveTarget;
    this.#log = log ?? (() => {});
  }

  /** @returns {boolean} Whether the client should stay connected. */
  get running() {
    return !this.#stopped;
  }

  /** @returns {string} Current state. */
  get state() {
    return this.#state;
  }

  /** Start maintaining the pool. */
  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#state = 'connecting';
    this.#tick();
  }

  /** Stop maintaining the pool and close every idle connection. */
  stop() {
    this.#stopped = true;
    this.#state = 'stopped';
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    for (const entry of this.#pool.splice(0)) entry.socket.destroy();
  }

  /** Restart the pool from scratch. */
  restart() {
    this.stop();
    this.start();
  }

  /**
   * Snapshot for the status route and the owner's log.
   * @returns {object} Plain, JSON-serialisable state.
   */
  status() {
    const relay = this.#config.relay;
    return {
      mode: 'relay',
      state: this.#state,
      idle: this.#pool.length,
      poolSize: relay.poolSize,
      connectedAt: this.#connectedAt ?? null,
      uptimeMs: this.#connectedAt === undefined ? 0 : Date.now() - this.#connectedAt,
      lastError: this.#lastError ?? null,
      relay: {
        host: relay.host,
        port: relay.port,
        publicHost: relay.publicHost,
        publicPort: relay.publicPort,
        publicUrl: this.#publicUrl(),
        pinned: relay.fingerprint !== undefined && relay.fingerprint !== '',
      },
      stats: { ...this.#stats },
    };
  }

  /**
   * The browser-facing URL of this relay.
   * @returns {string} `https://<publicHost>:<publicPort>/`
   */
  #publicUrl() {
    const relay = this.#config.relay;
    const host = relay.publicHost === '' ? relay.host : relay.publicHost;
    return `https://${isIpLiteral(host) && host.includes(':') ? `[${host}]` : host}:${relay.publicPort}/`;
  }

  /**
   * One pool maintenance pass: prune stale entries, then top the pool up.
   * @returns {void}
   */
  #tick() {
    if (this.#stopped) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);

    const relay = this.#config.relay;
    const now = Date.now();
    for (const entry of [...this.#pool]) {
      if (now - entry.at > relay.idleTtlMs || entry.socket.destroyed) {
        this.#pool.splice(this.#pool.indexOf(entry), 1);
        entry.socket.destroy();
      }
    }

    const wanted = Math.min(relay.poolSize, relay.poolSize - this.#pool.length - this.#opening);
    for (let index = 0; index < wanted; index += 1) void this.#open();

    const delay = this.#failures > 0 ? Math.min(relay.refreshMs * 3, 10_000) : relay.refreshMs;
    this.#timer = setTimeout(() => this.#tick(), delay);
    this.#timer.unref?.();
  }

  /** Open one idle relay connection. */
  async #open() {
    if (this.#stopped) return;
    this.#opening += 1;
    try {
      const socket = await this.#handshake();
      if (this.#stopped) {
        socket.destroy();
        return;
      }
      this.#failures = 0;
      this.#connectedAt ??= Date.now();
      this.#lastError = undefined;
      this.#state = this.#pool.length + 1 >= this.#config.relay.poolSize ? 'ready' : 'connecting';
      const entry = { socket, at: Date.now() };
      this.#pool.push(entry);
      this.#arm(entry);
      this.emit('ready', { idle: this.#pool.length });
    } catch (error) {
      this.#failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (this.#lastError !== message) {
        this.#lastError = message;
        this.#log('warn', `ssh-bridge: relay: ${message}`);
      }
      this.#state = 'retrying';
      this.emit('unavailable', { error: message });
    } finally {
      this.#opening -= 1;
    }
  }

  /**
   * Authenticate one connection to the relay.
   * @returns {Promise<import('node:tls').TLSSocket>} A socket the relay holds idle.
   */
  #handshake() {
    const relay = this.#config.relay;

    return new Promise((resolve, reject) => {
      const pinned = relay.fingerprint !== undefined && relay.fingerprint !== '';
      const verify = pinned ? false : relay.insecure !== true;

      const socket = tls.connect({
        host: relay.host,
        port: relay.port,
        ...(isIpLiteral(relay.host) ? {} : { servername: relay.servername ?? relay.host }),
        rejectUnauthorized: verify,
      });

      let settled = false;
      let buffer = Buffer.alloc(0);

      const fail = (error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error);
      };

      socket.setTimeout(relay.timeoutMs, () => fail(new Error(`connecting to ${relay.host}:${relay.port} timed out`)));
      socket.on('error', (error) => {
        if (settled) {
          this.#log('warn', `ssh-bridge: relay connection error: ${error.message}`);
          return;
        }
        const hint = error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || error.code === 'SELF_SIGNED_CERT_IN_CHAIN'
          ? 'self-signed certificate; set relay.fingerprint to the value printed by the relay, or relay.insecure'
          : error.message;
        fail(new Error(`cannot reach relay ${relay.host}:${relay.port}: ${hint}`));
      });
      socket.on('close', () => fail(new Error('relay closed the connection during the handshake')));

      socket.once('secureConnect', () => {
        if (pinned) {
          const peer = socket.getPeerCertificate();
          if (peer === null || peer === undefined || peer.raw === undefined) {
            fail(new Error('relay presented no certificate'));
            return;
          }
          if (!tokenEquals(fingerprintOf(peer.raw), relay.fingerprint)) {
            fail(new Error(`relay certificate fingerprint mismatch: expected ${relay.fingerprint}, got ${fingerprintOf(peer.raw)}`));
            return;
          }
        }

        socket.write(Buffer.concat([MAGIC, encodeHandshake({ hostId: relay.hostId, token: relay.token })]));

        const onData = (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length > MAX_REPLY_BYTES) {
            socket.off('data', onData);
            fail(new Error('relay handshake reply was too long'));
            return;
          }
          const index = buffer.indexOf(0x0a);
          if (index === -1) return;
          socket.off('data', onData);
          socket.setTimeout(0);
          const reply = buffer.subarray(0, index).toString('utf8').trim();
          if (reply !== 'OK') {
            fail(new Error(`relay rejected this host: ${reply.replace(/^ERR\s+/, '')}`));
            return;
          }
          settled = true;
          socket.pause();
          resolve(socket);
        };
        socket.on('data', onData);
      });
    });
  }

  /**
   * Watch an idle connection for the moment the relay attaches a browser to it.
   * @param {{ socket: import('node:tls').TLSSocket, at: number }} entry - Pool entry.
   */
  #arm(entry) {
    const { socket } = entry;

    const forget = () => {
      const index = this.#pool.indexOf(entry);
      if (index >= 0) this.#pool.splice(index, 1);
    };
    socket.once('close', forget);

    const onFirstBytes = (chunk) => {
      socket.off('data', onFirstBytes);
      socket.off('close', forget);
      forget();
      socket.pause();
      this.#serve(socket, chunk);
    };
    socket.on('data', onFirstBytes);
    socket.resume();
  }

  /**
   * Bridge one attached relay connection to the local DSH listener.
   * @param {import('node:tls').TLSSocket} socket - The relay connection.
   * @param {Buffer} firstChunk - Bytes that arrived with the attachment.
   */
  #serve(socket, firstChunk) {
    const target = this.#resolveTarget();
    if (target === undefined) {
      this.#log('warn', 'ssh-bridge: relay attached a browser before the DSH web listener was ready');
      socket.destroy();
      return;
    }

    const local = net.connect({ host: target.host, port: target.port });
    const close = () => {
      socket.destroy();
      local.destroy();
    };

    local.on('error', close);
    socket.on('error', close);
    local.on('close', () => socket.destroy());
    socket.on('close', () => local.destroy());

    local.once('connect', () => {
      this.#stats.served += 1;
      if (firstChunk.length > 0) local.write(firstChunk);
      socket.pipe(local);
      local.pipe(socket);
      socket.resume();
    });
  }
}
