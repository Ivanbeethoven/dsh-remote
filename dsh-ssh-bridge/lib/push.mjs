/**
 * Send a file from this machine to another host over SSH.
 *
 * The relay is a byte pipe to one DSH, so it cannot move files between machines; this runs on
 * the DSH side, where the plugin already depends on `ssh2`. Authentication reuses the same
 * key/password options as the SSH transport, so a host the bridge already reaches is one config
 * entry away from being a push target.
 *
 * The upload is `base64` over a shell rather than SFTP: it needs only a login shell, works on
 * every sshd, and keeps a binary-safe path without negotiating a subsystem.
 *
 * @module dsh-ssh-bridge/push
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Client } from 'ssh2';

/** Largest file the push endpoint will send, in bytes. */
export const MAX_PUSH_BYTES = 32 * 1024 * 1024;

/**
 * Quote one shell word for a POSIX shell.
 * @param {string} value - Word to quote.
 * @returns {string} Quoted word.
 */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * Open one SSH connection, run a command, feed stdin, and wait for the exit status.
 * @param {object} options - Connection inputs.
 * @param {object} options.target - Target configuration.
 * @param {string} options.command - Shell command to run.
 * @param {string} [options.stdin] - Bytes to write to stdin.
 * @param {number} [options.timeoutMs] - Overall timeout.
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>} Exit status and output.
 */
export function runOverSsh({ target, command, stdin, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end();
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(
      () => finish(new Error(`push: ${target.host} did not finish within ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();

    client.on('error', (error) => finish(error));
    client.on('ready', () => {
      client.exec(command, (error, stream) => {
        if (error) {
          finish(error);
          return;
        }
        let stdout = '';
        let stderr = '';
        stream.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
        stream.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
        stream.on('close', (code) => finish(undefined, { code: code ?? 0, stdout, stderr }));
        if (stdin !== undefined) stream.end(stdin);
        else stream.end();
      });
    });

    const options = {
      host: target.host,
      port: target.port ?? 22,
      username: target.username,
      readyTimeout: timeoutMs,
    };
    if (typeof target.privateKeyPath === 'string' && target.privateKeyPath !== '') {
      options.privateKey = fs.readFileSync(target.privateKeyPath);
      if (typeof target.privateKeyPassphrase === 'string') options.passphrase = target.privateKeyPassphrase;
    }
    if (typeof target.password === 'string') options.password = target.password;
    if (typeof target.hostKeyFingerprint === 'string' && target.hostKeyFingerprint !== '') {
      /* Pin when a fingerprint is configured; accept on first use otherwise. */
      options.hostVerifier = (key) => {
        const digest = crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
        return `SHA256:${digest}` === target.hostKeyFingerprint;
      };
    }

    try {
      client.connect(options);
    } catch (error) {
      finish(error);
    }
  });
}

/**
 * Push one local file to one configured target.
 *
 * @param {object} options - Push inputs.
 * @param {object} options.target - Target configuration (`host`, `dir`, credentials).
 * @param {string} options.localPath - Absolute path of the file to send.
 * @param {string} [options.remotePath] - Explicit destination; defaults to `target.dir/<basename>`.
 * @param {(input: object) => Promise<object>} [options.run] - Transport override, for tests.
 * @returns {Promise<{ bytes: number, remotePath: string }>} What was sent, and where.
 */
export async function pushFile({ target, localPath, remotePath, run = runOverSsh }) {
  if (target === undefined) throw new Error('push: unknown target');
  if (typeof localPath !== 'string' || localPath === '') throw new Error('push: a local path is required');

  const absolute = path.resolve(localPath);
  const stat = await fs.promises.stat(absolute).catch(() => undefined);
  if (stat === undefined) throw new Error(`push: no such file: ${localPath}`);
  if (!stat.isFile()) throw new Error(`push: not a regular file: ${localPath}`);
  if (stat.size > MAX_PUSH_BYTES) {
    throw new Error(`push: ${localPath} is ${stat.size} bytes, over the ${MAX_PUSH_BYTES} byte limit`);
  }

  const directory = target.dir === undefined || target.dir === '' ? '.' : target.dir;
  const destination = remotePath !== undefined && remotePath !== ''
    ? remotePath
    : path.posix.join(directory, path.basename(absolute));

  const content = await fs.promises.readFile(absolute);
  const command = `mkdir -p ${shellQuote(path.posix.dirname(destination))} && base64 -d > ${shellQuote(destination)} && stat -c %s ${shellQuote(destination)}`;

  const result = await run({ target, command, stdin: `${content.toString('base64')}\n` });
  if (result.code !== 0) {
    throw new Error(`push: remote command failed (exit ${result.code}): ${result.stderr.trim() || 'no stderr'}`);
  }
  const written = Number.parseInt(result.stdout.trim(), 10);
  return {
    bytes: stat.size,
    remotePath: destination,
    /* `stat` runs in the same shell, so its answer is the real size on the far side. */
    verified: Number.isFinite(written) ? written : undefined,
  };
}
