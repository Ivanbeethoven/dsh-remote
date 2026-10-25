/**
 * Standalone transport probe, useful when the bridge will not come up inside DSH.
 *
 * It runs the tunnel against a local throwaway SSH server and a local HTTP target, so
 * authentication, host-key policy, forwarding, and reconnect can be checked without
 * involving DSH at all.
 *
 * Usage:
 *   node scripts/probe.mjs                      # happy path against a local server
 *   node scripts/probe.mjs --strict             # strict host key with no known_hosts
 *   node scripts/probe.mjs --real ssh://user@host:22   # against a real server
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { startSshServer, testHostKey } from '../tests/helpers/ssh-server.mjs';
import { SshTunnel } from '../lib/tunnel.mjs';
import { resolveConfig } from '../lib/index.mjs';

const args = process.argv.slice(2);
const strict = args.includes('--strict');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-bridge-probe-'));
const knownHostsPath = path.join(dir, 'known_hosts');

const target = http.createServer((request, response) => response.end(`ok:${request.url}`));
await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
const targetPort = target.address().port;

const { private: privateKey } = await import('ssh2').then((module) => module.default.utils.generateKeyPairSync('ed25519'));
const keyPath = path.join(dir, 'id_ed25519');
fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });

const ssh = await startSshServer({ hostKey: testHostKey().private });
console.log(`[probe] test ssh server 127.0.0.1:${ssh.port}, target 127.0.0.1:${targetPort}`);

const config = resolveConfig({
  enabled: true,
  ssh: {
    host: '127.0.0.1',
    port: ssh.port,
    username: 'dsh',
    authMethod: 'privateKey',
    privateKeyPath: keyPath,
    knownHostsPath,
    hostKeyPolicy: strict ? 'strict' : 'accept-new',
  },
  forward: { bindAddress: '127.0.0.1', port: 0 },
  reconnect: { enabled: false },
});
console.log(`[probe] hostKeyPolicy=${config.ssh.hostKeyPolicy}`);

const tunnel = new SshTunnel({
  config,
  resolveTarget: () => ({ host: '127.0.0.1', port: targetPort }),
  log: (level, message) => console.log(`[${level}] ${message}`),
});

let last = '';
const watcher = setInterval(() => {
  if (tunnel.state !== last) {
    last = tunnel.state;
    console.log(`[state] ${last}`);
  }
}, 40);

tunnel.start();
await new Promise((resolve) => setTimeout(resolve, 5000));

const status = tunnel.status();
console.log('[status]', JSON.stringify({ state: status.state, target: status.forward.target, port: status.forward.remotePort, error: status.lastError }));

if (status.state === 'forwarding') {
  const response = await fetch(`http://127.0.0.1:${status.forward.remotePort}/probe`);
  console.log('[http]', response.status, await response.text());
}

console.log('[known_hosts]', fs.existsSync(knownHostsPath) ? fs.readFileSync(knownHostsPath, 'utf8').trim() : '(none)');

clearInterval(watcher);
tunnel.stop();
await target.close();
await ssh.close();
process.exit(strict ? (status.state === 'failed' ? 0 : 1) : (status.state === 'forwarding' ? 0 : 1));
