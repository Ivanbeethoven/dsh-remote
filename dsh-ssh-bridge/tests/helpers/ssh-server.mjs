/**
 * A minimal in-process SSH server for the bridge's tests.
 *
 * It implements the one server behaviour the bridge depends on: accepting a
 * `tcpip-forward` global request by listening on the requested loopback port and
 * opening a `forwarded-tcpip` channel for every connection it receives. That is what
 * an OpenSSH server does for `-R`, so the test exercises the real protocol path.
 *
 * @module tests/helpers/ssh-server
 */

import net from 'node:net';
import ssh2 from 'ssh2';

const { Server } = ssh2;

/**
 * Generate an ed25519 host key pair for a test server.
 * @returns {{ private: string, public: string }} PEM/OpenSSH key pair.
 */
export function testHostKey() {
  return ssh2.utils.generateKeyPairSync('ed25519');
}

/**
 * Wait until `predicate` returns true.
 * @param {() => boolean} predicate - Condition to poll.
 * @param {object} [options] - Polling options.
 * @param {number} [options.timeoutMs] - Deadline, default 10s.
 * @param {number} [options.intervalMs] - Poll interval, default 25ms.
 * @returns {Promise<void>} Resolves once the condition holds.
 */
export async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor: condition was not met before the deadline');
}

/**
 * Start a test SSH server.
 *
 * @param {object} [options] - Server options.
 * @param {string} [options.hostKey] - Host key; a fresh ed25519 key when omitted.
 * @param {number} [options.port] - Listen port; 0 or omitted picks a free one.
 * @param {string} [options.hostname] - Listen address, default loopback.
 * @returns {Promise<object>} Handle with the bound port and a `close()` method.
 */
export async function startSshServer({ hostKey, port = 0, hostname = '127.0.0.1' } = {}) {
  const key = hostKey ?? testHostKey();
  const privateKey = typeof key === 'string' ? key : key.private;
  /** @type {{ bindAddr: string, bindPort: number, server: net.Server, connections: number }[]} */
  const forwards = [];
  const clients = new Set();
  let authCount = 0;

  const server = new Server({ hostKeys: [{ key: privateKey }] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});

    client.on('authentication', (ctx) => {
      authCount += 1;
      if (ctx.method === 'publickey') {
        ctx.accept();
        return;
      }
      if (ctx.method === 'password') {
        ctx.accept();
        return;
      }
      ctx.reject(['publickey', 'password']);
    });

    client.on('ready', () => {
      client.on('request', (accept, reject, name, info) => {
        if (name !== 'tcpip-forward') {
          reject?.();
          return;
        }

        const bindAddr = info.bindAddr === '0.0.0.0' ? '127.0.0.1' : info.bindAddr;
        const record = { bindAddr: info.bindAddr, bindPort: info.bindPort, server: undefined, connections: 0 };

        const listener = net.createServer((socket) => {
          record.connections += 1;

          client.forwardOut(
            info.bindAddr,
            record.bindPort,
            socket.remoteAddress ?? '127.0.0.1',
            socket.remotePort ?? 0,
            (error, stream) => {
              if (error) {
                socket.destroy();
                return;
              }
              stream.on('error', () => socket.destroy());
              socket.on('error', () => stream.destroy());
              stream.pipe(socket).pipe(stream);
            },
          );
        });

        listener.on('error', () => reject?.());
        listener.listen(info.bindPort, bindAddr, () => {
          record.bindPort = listener.address().port;
          record.server = listener;
          forwards.push(record);
          accept(record.bindPort);
        });
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, resolve);
  });

  return {
    port: server.address().port,
    hostKey: key,
    forwards,
    get authCount() {
      return authCount;
    },
    close: async () => {
      for (const entry of forwards) await new Promise((resolve) => entry.server.close(resolve));
      for (const client of clients) client.end();
      clients.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
