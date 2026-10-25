/**
 * A throwaway SSH server for testing the bridge without a real server.
 *
 * It accepts any public key or password, listens on the requested port, and logs every
 * remote forward it publishes. Point `ssh.host` at 127.0.0.1 and `ssh.port` at the port
 * printed below to try the whole phone path on one machine.
 *
 * The host key is persisted so a restarted server keeps the same identity — otherwise
 * `accept-new` would (correctly) refuse it as a changed key.
 *
 * Usage: node scripts/dev-ssh-server.mjs [port] [keyFile]
 */

import fs from 'node:fs';
import path from 'node:path';

import { startSshServer, testHostKey } from '../tests/helpers/ssh-server.mjs';

const port = Number(process.argv[2] ?? 2022);
const keyFile = path.resolve(process.argv[3] ?? '.dev-ssh-host-key');

/**
 * Load the persisted host key, creating it on first use.
 * @returns {{ private: string, public: string }} Host key pair.
 */
function loadHostKey() {
  if (fs.existsSync(keyFile)) {
    const privateKey = fs.readFileSync(keyFile, 'utf8');
    const publicPath = `${keyFile}.pub`;
    return {
      private: privateKey,
      public: fs.existsSync(publicPath) ? fs.readFileSync(publicPath, 'utf8').trim() : '(persisted)',
    };
  }
  const pair = testHostKey();
  fs.writeFileSync(keyFile, pair.private, { mode: 0o600 });
  fs.writeFileSync(`${keyFile}.pub`, `${pair.public}\n`);
  return pair;
}

const hostKey = loadHostKey();
const server = await startSshServer({ hostKey: hostKey.private, port });

console.log(`[dev-ssh] listening on 127.0.0.1:${server.port}`);
console.log(`[dev-ssh] host key file: ${keyFile}`);
console.log('[dev-ssh] auth: any public key or password is accepted');

const timer = setInterval(() => {
  for (const forward of server.forwards) {
    if (forward.reported === true) continue;
    forward.reported = true;
    console.log(`[dev-ssh] forward ${forward.bindAddr}:${forward.bindPort}`);
  }
}, 200);

const shutdown = async () => {
  clearInterval(timer);
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
console.log('[dev-ssh] ready');
