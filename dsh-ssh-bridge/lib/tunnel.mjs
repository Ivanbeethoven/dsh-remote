/**
 * The bridge's SSH transport: one outbound connection to an SSH server that
 * publishes this DSH web listener on the server's own loopback through a remote
 * TCP forward.
 *
 * Outbound-only by design: no inbound port on the DSH host, no NAT traversal, and
 * no hole punching. The phone reaches the same server and opens a local forward to
 * the published port, so the browser traffic never leaves the two SSH channels.
 *
 * @module dsh-ssh-bridge/tunnel
 */

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import ssh2 from 'ssh2';

import { appendKnownHost, verifyHostKey } from './host-key.mjs';

const { Client } = ssh2;

/** SSH default port, used for the hashed `known_hosts` host field. */
const READY_TIMEOUT_MIN_MS = 1000;

/**
 * Candidate private keys considered by `authMethod: auto`, in OpenSSH's own order.
 * @returns {string[]} Existing key paths.
 */
export function defaultPrivateKeyCandidates() {
  const directory = path.join(os.homedir(), '.ssh');
  return ['id_ed25519', 'id_ecdsa', 'id_rsa']
    .map((name) => path.join(directory, name))
    .filter((candidate) => fs.existsSync(candidate));
}

/**
 * The agent socket for this platform, when one is configured.
 * @returns {string | undefined} Path or named pipe of the SSH agent.
 */
export function defaultAgentPath() {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent';
  return undefined;
}

/**
 * Resolve one SSH authentication method from config.
 * @param {object} config - Resolved plugin config.
 * @returns {{ method: string, options: object }} The chosen method and ssh2 options.
 */
export function resolveAuth(config) {
  const { authMethod, privateKeyPath, privateKeyPassphrase, password } = config.ssh;
  const agent = config.ssh.agentPath ?? defaultAgentPath();

  const keyPath = privateKeyPath
    ?? (authMethod === 'auto' ? defaultPrivateKeyCandidates()[0] : undefined);

  const useKey = () => {
    if (keyPath === undefined) throw new Error('ssh-bridge: no private key path configured and none found in ~/.ssh');
    return {
      method: 'privateKey',
      options: {
        privateKey: fs.readFileSync(keyPath, 'utf8'),
        ...(privateKeyPassphrase === undefined ? {} : { passphrase: privateKeyPassphrase }),
      },
    };
  };

  switch (authMethod) {
    case 'agent':
      if (agent === undefined) throw new Error('ssh-bridge: authMethod is "agent" but no SSH agent is available');
      return { method: 'agent', options: { agent } };
    case 'privateKey':
      return useKey();
    case 'password':
      if (password === undefined) throw new Error('ssh-bridge: authMethod is "password" but no password is configured');
      return { method: 'password', options: { password } };
    default: {
      if (agent !== undefined) return { method: 'agent', options: { agent } };
      if (privateKeyPath !== undefined || defaultPrivateKeyCandidates().length > 0) return useKey();
      if (password !== undefined) return { method: 'password', options: { password } };
      throw new Error('ssh-bridge: no usable SSH credentials; configure privateKeyPath, password, or an agent');
    }
  }
}

/**
 * Manage one SSH connection and its remote forward, with reconnect and status.
 *
 * The tunnel connects before it knows the DSH port: `resolveTarget` is called when
 * the connection is ready and again on every reconnect, and a forward is only
 * requested once it reports a live listener.
 *
 * @extends EventEmitter
 */
export class SshTunnel extends EventEmitter {
  /** @type {object} */
  #config;
  /** @type {() => ({ host: string, port: number } | undefined)} */
  #resolveTarget;
  #logger;
  /** @type {import('ssh2').Client | undefined} */
  #client;
  /** @type {NodeJS.Timeout | undefined} */
  #timer;
  #stopped = true;
  #state = 'stopped';
  #attempt = 0;
  #lastError;
  #connectedAt;
  #forwardedAt;
  #remotePort;
  #target;
  #authMethod;
  #channels = new Set();
  #stats = { totalChannels: 0, bytesUp: 0, bytesDown: 0 };
  #pinnedWarningLogged = false;
  /** Specific reason a host key was refused, kept for the report instead of ssh2's generic error. */
  #hostKeyReason;

  /**
   * @param {object} options - Construction inputs.
   * @param {object} options.config - Resolved plugin config.
   * @param {() => ({ host: string, port: number } | undefined)} options.resolveTarget - Live DSH listener.
   * @param {(level: string, message: string) => void} [options.log] - Sink for lifecycle messages.
   */
  constructor({ config, resolveTarget, log }) {
    super();
    this.#config = config;
    this.#resolveTarget = resolveTarget;
    this.#logger = log ?? (() => {});
  }

  /** @returns {boolean} Whether the transport is trying to stay connected. */
  get running() {
    return !this.#stopped;
  }

  /** @returns {string} Current lifecycle state. */
  get state() {
    return this.#state;
  }

  /**
   * Start connecting and keep the connection alive until `stop()`.
   * Never rejects: a failure is reported through `status()` and retried.
   */
  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#attempt = 0;
    void this.#connect();
  }

  /** Stop reconnecting and tear the connection down. */
  stop() {
    this.#stopped = true;
    this.#state = 'stopped';
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#teardown('stopped');
  }

  /** Restart from a clean state, resetting the backoff sequence. */
  restart() {
    this.stop();
    this.start();
  }

  /**
   * A snapshot for the status route and the owner's log.
   * @returns {object} Plain, JSON-serialisable state.
   */
  status() {
    return {
      mode: 'ssh',
      state: this.#state,
      enabled: this.#config.enabled,
      attempt: this.#attempt,
      connectedAt: this.#connectedAt ?? null,
      forwardedAt: this.#forwardedAt ?? null,
      uptimeMs: this.#connectedAt === undefined ? 0 : Date.now() - this.#connectedAt,
      lastError: this.#lastError ?? null,
      authMethod: this.#authMethod ?? null,
      ssh: {
        host: this.#config.ssh.host,
        port: this.#config.ssh.port,
        username: this.#config.ssh.username,
      },
      forward: {
        bindAddress: this.#config.forward.bindAddress,
        remotePort: this.#remotePort ?? this.#config.forward.port,
        target: this.#target ?? null,
      },
      stats: {
        openChannels: this.#channels.size,
        totalChannels: this.#stats.totalChannels,
        bytesUp: this.#stats.bytesUp,
        bytesDown: this.#stats.bytesDown,
      },
    };
  }

  /**
   * Tear down the current connection without affecting the reconnect loop.
   * @param {string} state - State to publish.
   */
  #teardown(state) {
    this.#state = state;
    for (const channel of this.#channels) channel.destroy();
    this.#channels.clear();
    const client = this.#client;
    this.#client = undefined;
    this.#remotePort = undefined;
    this.#connectedAt = undefined;
    this.#forwardedAt = undefined;
    if (client !== undefined) {
      client.removeAllListeners();
      /* ssh2 may still emit `error` while the socket unwinds; without a listener an
         EventEmitter throws, so keep a sink attached until the client is gone. */
      client.on('error', () => {});
      client.end();
    }
  }

  /** @param {string} message - Human-readable failure reason. */
  #fail(message) {
    this.#lastError = message;
    this.#logger('warn', message);
  }

  /** Connect once. Resolves when the connection is established or has failed. */
  #connect() {
    if (this.#stopped) return;

    this.#state = 'connecting';
    this.#hostKeyReason = undefined;
    let auth;
    try {
      auth = resolveAuth(this.#config);
    } catch (error) {
      this.#state = 'failed';
      this.#fail(error instanceof Error ? error.message : String(error));
      this.#scheduleReconnect();
      return;
    }
    this.#authMethod = auth.method;

    const client = new Client();
    this.#client = client;
    let settled = false;

    const settle = () => {
      if (settled) return;
      settled = true;
      this.#onDisconnected();
    };

    client.on('ready', () => {
      this.#connectedAt = Date.now();
      this.#attempt = 0;
      this.#lastError = undefined;
      this.#state = 'connected';
      this.#logger('info', `ssh-bridge: connected to ${this.#config.ssh.username}@${this.#config.ssh.host}:${this.#config.ssh.port} via ${auth.method}`);
      this.emit('connected');
      void this.#establishForward(client);
    });

    client.on('error', (error) => {
      const code = typeof error === 'object' && error !== null && 'code' in error ? ` (${String(error.code)})` : '';
      this.#state = 'failed';
      if (this.#hostKeyReason === undefined) {
        this.#fail(`ssh-bridge: ${error.message}${code}`);
      } else {
        /* Already logged by the verifier; keep its specific wording over ssh2's generic one. */
        this.#lastError = `ssh-bridge: ${this.#hostKeyReason}`;
      }
      settle();
    });

    client.on('close', () => {
      if (this.#state !== 'stopped' && this.#state !== 'failed') this.#state = 'disconnected';
      settle();
    });

    client.on('end', () => {
      settle();
    });

    client.on('tcp connection', (info, accept, reject) => {
      this.#handleChannel(info, accept, reject);
    });

    const hostKey = this.#hostVerifier();
    try {
      client.connect({
        host: this.#config.ssh.host,
        port: this.#config.ssh.port,
        username: this.#config.ssh.username,
        readyTimeout: this.#config.ssh.readyTimeoutMs,
        keepaliveInterval: this.#config.ssh.keepaliveIntervalMs,
        keepaliveCountMax: 3,
        hostVerifier: (key) => hostKey(key),
        ...auth.options,
      });
    } catch (error) {
      this.#state = 'failed';
      this.#fail(`ssh-bridge: ${error instanceof Error ? error.message : String(error)}`);
      settle();
    }
  }

  /**
   * Build the host-key callback, recording a first-use key under `accept-new`.
   * @returns {(key: Buffer) => boolean} Verifier for ssh2.
   */
  #hostVerifier() {
    return (key) => {
      const { hostKeyPolicy: policy, knownHostsPath } = this.#config.ssh;
      let result;
      try {
        result = verifyHostKey({
          policy,
          host: this.#config.ssh.host,
          port: this.#config.ssh.port,
          key,
          knownHostsPath,
        });
      } catch (error) {
        this.#fail(`ssh-bridge: host key verification failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }

      if (!result.allowed) {
        this.#hostKeyReason = result.reason;
        this.#fail(`ssh-bridge: ${result.reason}`);
        return false;
      }

      if (result.firstUse) {
        try {
          appendKnownHost(result.knownHostsPath, this.#config.ssh.host, this.#config.ssh.port, key);
          this.#logger('info', `ssh-bridge: ${result.reason} (${result.knownHostsPath})`);
        } catch (error) {
          this.#logger('warn', `ssh-bridge: could not record host key: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (policy === 'insecure' && !this.#pinnedWarningLogged) {
        this.#pinnedWarningLogged = true;
        this.#logger('warn', `ssh-bridge: ${result.reason}`);
      }

      return true;
    };
  }

  /**
   * Request the remote forward once the DSH listener is known.
   * @param {import('ssh2').Client} client - The ready client.
   */
  async #establishForward(client) {
    const target = await this.#waitForTarget();
    if (target === undefined) {
      if (this.#client === client && !this.#stopped) {
        this.#fail('ssh-bridge: the DSH web listener never reported a port; is the web profile active?');
        this.#state = 'failed';
        this.#teardown('failed');
        this.#scheduleReconnect();
      }
      return;
    }
    if (this.#client !== client || this.#stopped) return;

    this.#target = target;
    const { bindAddress, port } = this.#config.forward;

    client.forwardIn(bindAddress, port, (error, boundPort) => {
      if (this.#client !== client) return;
      if (error) {
        this.#state = 'failed';
        this.#fail(`ssh-bridge: remote forward ${bindAddress}:${port} was refused: ${error.message}`);
        this.#teardown('failed');
        this.#scheduleReconnect();
        return;
      }
      this.#remotePort = boundPort;
      this.#forwardedAt = Date.now();
      this.#state = 'forwarding';
      this.#logger('info', `ssh-bridge: forwarding ${bindAddress}:${boundPort} on the SSH server to ${target.host}:${target.port}`);
      this.emit('forwarding', { bindAddress, remotePort: boundPort, target });
    });
  }

  /**
   * Poll for the DSH listener port, which binds slightly after plugin activation.
   * @returns {Promise<{ host: string, port: number } | undefined>} The target, or undefined after the deadline.
   */
  async #waitForTarget() {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (this.#stopped) return undefined;
      const target = this.#resolveTarget();
      if (target !== undefined) return target;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return undefined;
  }

  /**
   * Bridge one remote-forward connection to the local DSH listener.
   * @param {{ destPort: number }} info - Channel destination.
   * @param {() => import('stream').Duplex} accept - Accepts the channel.
   * @param {() => void} reject - Refuses the channel.
   */
  #handleChannel(info, accept, reject) {
    const target = this.#target;
    if (target === undefined || info.destPort !== this.#remotePort) {
      reject();
      return;
    }

    const socket = net.connect({ host: target.host, port: target.port });
    let channel;

    const close = () => {
      channel?.destroy();
      socket.destroy();
    };

    socket.once('connect', () => {
      try {
        channel = accept();
      } catch {
        socket.destroy();
        return;
      }
      this.#channels.add(channel);
      this.#stats.totalChannels += 1;

      channel.on('close', () => {
        this.#channels.delete(channel);
        this.#stats.bytesUp += channel.bytesWritten ?? 0;
        this.#stats.bytesDown += channel.bytesRead ?? 0;
        socket.destroy();
      });
      channel.on('error', close);
      socket.on('error', close);
      socket.on('close', () => channel?.destroy());

      channel.pipe(socket);
      socket.pipe(channel);
    });

    socket.on('error', () => {
      reject();
    });
  }

  /** Schedule the next attempt with exponential backoff and jitter. */
  #scheduleReconnect() {
    if (this.#stopped || this.#timer !== undefined) return;
    const { enabled, minDelayMs, maxDelayMs, factor } = this.#config.reconnect;
    if (!enabled) {
      this.#state = 'failed';
      return;
    }

    const exponential = Math.min(maxDelayMs, minDelayMs * factor ** this.#attempt);
    const delay = Math.round(exponential * (0.5 + Math.random() * 0.5));
    this.#attempt += 1;
    this.#state = 'retrying';
    this.#logger('info', `ssh-bridge: reconnecting in ${delay}ms (attempt ${this.#attempt})`);

    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#connect();
    }, delay);
    this.#timer.unref?.();
  }

  /** Handle the end of one connection attempt. */
  #onDisconnected() {
    if (this.#stopped) return;
    this.#state = 'disconnected';
    this.emit('disconnected');
    this.#scheduleReconnect();
  }
}

export { READY_TIMEOUT_MIN_MS };
