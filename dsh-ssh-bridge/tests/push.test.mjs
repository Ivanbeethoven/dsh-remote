/**
 * Push tests: the local half of the feature — argument validation, destination resolution,
 * and what actually goes over the wire — with the SSH transport replaced by a recorder.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MAX_PUSH_BYTES, pushFile, shellQuote } from '../lib/push.mjs';

/**
 * Write a temp file with known contents.
 * @param {string} name - File name.
 * @param {string|Buffer} content - Contents.
 * @returns {string} Absolute path.
 */
function tempFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-push-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

const TARGET = { host: 'example.test', port: 22, username: 'root', dir: '/srv/incoming' };

test('a push sends base64 of the file to the target directory', async () => {
  const file = tempFile('artifact.bin', 'hello relay');
  let seen;

  const result = await pushFile({
    target: TARGET,
    localPath: file,
    run: async (input) => {
      seen = input;
      return { code: 0, stdout: '11\n', stderr: '' };
    },
  });

  assert.equal(result.bytes, 11);
  assert.equal(result.remotePath, '/srv/incoming/artifact.bin');
  assert.equal(result.verified, 11);
  assert.match(seen.command, /^mkdir -p '\/srv\/incoming' && base64 -d > '\/srv\/incoming\/artifact\.bin'/);
  assert.equal(seen.stdin, `${Buffer.from('hello relay').toString('base64')}\n`);
  assert.equal(seen.target, TARGET);
});

test('an explicit remote directory overrides the target default', async () => {
  const file = tempFile('report.md', '# hi');
  let seen;

  const result = await pushFile({
    target: TARGET,
    localPath: file,
    remotePath: '/opt/other/report.md',
    run: async (input) => {
      seen = input;
      return { code: 0, stdout: '4\n', stderr: '' };
    },
  });

  assert.equal(result.remotePath, '/opt/other/report.md');
  assert.match(seen.command, /'\/opt\/other\/report\.md'/);
});

test('a missing local file is refused before any connection', async () => {
  await assert.rejects(
    pushFile({ target: TARGET, localPath: path.join(os.tmpdir(), 'definitely-absent-xyz'), run: async () => {
      throw new Error('transport should not run');
    } }),
    /no such file/,
  );
});

test('a directory is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-push-dir-'));
  await assert.rejects(
    pushFile({ target: TARGET, localPath: dir, run: async () => {
      throw new Error('transport should not run');
    } }),
    /not a regular file/,
  );
});

test('a failing remote command surfaces its stderr', async () => {
  const file = tempFile('x.txt', 'x');
  await assert.rejects(
    pushFile({
      target: TARGET,
      localPath: file,
      run: async () => ({ code: 127, stdout: '', stderr: 'base64: not found' }),
    }),
    /exit 127.*base64: not found/,
  );
});

test('shell quoting survives a quote in the path', () => {
  assert.equal(shellQuote("/tmp/it's"), `'/tmp/it'\\''s'`);
});
