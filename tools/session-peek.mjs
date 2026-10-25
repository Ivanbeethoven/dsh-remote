/**
 * Decompress a DSH session log and report its shape, without dumping the whole thing.
 *
 * Usage: node tools/session-peek.mjs <sessionFile.zstd>
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

const [file] = process.argv.slice(2);
if (file === undefined) {
  console.error('usage: node tools/session-peek.mjs <sessionFile.zstd>');
  process.exit(2);
}

const raw = fs.readFileSync(file);
const text = zlib.zstdDecompressSync(raw).toString('utf8');
console.log(`compressed : ${(raw.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`decompressed: ${(text.length / 1024 / 1024).toFixed(2)} MB`);

const lines = text.split('\n').filter((line) => line.trim() !== '');
console.log(`records    : ${lines.length}`);

const kinds = new Map();
const roles = new Map();
for (const line of lines) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    continue;
  }
  const kind = record.type ?? record.kind ?? 'unknown';
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  const role = record.role ?? record.message?.role;
  if (role !== undefined) roles.set(role, (roles.get(role) ?? 0) + 1);
}

console.log('\nkinds:');
for (const [kind, count] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(5)}  ${kind}`);
}
console.log('\nroles:');
for (const [role, count] of [...roles.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(5)}  ${role}`);
}

console.log('\nfirst record keys:', Object.keys(JSON.parse(lines[0])).join(', '));
for (const [index, line] of [lines[0], lines[1], lines[2]].entries()) {
  console.log(`\n--- record ${index} (first 400 chars) ---`);
  console.log(line.slice(0, 400));
}
