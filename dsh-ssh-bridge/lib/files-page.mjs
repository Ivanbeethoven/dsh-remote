/**
 * A small file browser the plugin serves itself, so any device that can reach the relay can
 * fetch a file the DSH host produced. The chat's file cards are rendered by the desktop client
 * and only offer "open with <local program>", which is meaningless from another machine.
 *
 * Every path is resolved inside one root and refused when it escapes, so a URL cannot walk out
 * of the workspace.
 *
 * @module dsh-ssh-bridge/files-page
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve a user-supplied relative path inside a root, refusing escapes.
 * @param {string} root - Absolute directory that bounds the browse.
 * @param {string} requested - Relative path from the URL.
 * @returns {string | undefined} Absolute path, or undefined when it escapes or is not a directory.
 */
export function resolveWithin(root, requested) {
  const base = path.resolve(root);
  const raw = requested ?? '';
  /* An absolute path is accepted only when it already sits inside the root: the client knows
     the host path of a file and should not have to translate it into a relative one. */
  const cleaned = path.isAbsolute(raw) ? raw : raw.replace(/^\/+/, '');
  const target = path.resolve(base, cleaned);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) return undefined;
  return target;
}

/**
 * Format a byte count for display.
 * @param {number} bytes - Size in bytes.
 * @returns {string} Human-readable size.
 */
export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

/**
 * List one directory, newest first, directories before files.
 * @param {string} directory - Absolute directory.
 * @returns {{ name: string, dir: boolean, size: number, mtime: number }[]} Entries.
 */
export function listDirectory(directory) {
  const entries = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;
    let stat;
    try {
      stat = fs.statSync(path.join(directory, entry.name));
    } catch {
      continue;
    }
    entries.push({
      name: entry.name,
      dir: entry.isDirectory(),
      size: entry.isDirectory() ? 0 : stat.size,
      mtime: stat.mtimeMs,
    });
  }
  return entries.sort((a, b) => (a.dir === b.dir ? b.mtime - a.mtime : a.dir ? -1 : 1));
}

/**
 * Escape text for HTML.
 * @param {unknown} value - Text to escape.
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
 * Render the file browser.
 * @param {object} options - Page inputs.
 * @param {string} options.relative - Current directory relative to the root, `''` at the top.
 * @param {{ name: string, dir: boolean, size: number, mtime: number }[]} options.entries - Directory listing.
 * @param {string} options.key - Access key, carried through links.
 * @returns {string} HTML document.
 */
export function renderFilesPage({ relative, entries, key }) {
  const parent = relative === '' ? undefined : (path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative));
  const query = (extra) => `?${new URLSearchParams({ ...(key === '' ? {} : { rk: key }), ...extra })}`;

  const up = parent === undefined
    ? ''
    : `  <a class="row up" href="/ssh-bridge/files${query(parent === '' ? {} : { d: parent })}">
    <span class="name">.. 上一级</span>
  </a>`;

  const rows = entries.map((entry) => {
    const href = entry.dir
      ? `/ssh-bridge/files${query({ d: relative === '' ? entry.name : `${relative}/${entry.name}` })}`
      : `/ssh-bridge/file${query({ p: relative === '' ? entry.name : `${relative}/${entry.name}` })}`;
    const meta = entry.dir ? '文件夹' : `${humanSize(entry.size)} · ${new Date(entry.mtime).toLocaleString()}`;
    return `  <a class="row" href="${escape(href)}">
    <span class="icon">${entry.dir ? '📁' : '📄'}</span>
    <span class="body"><span class="name">${escape(entry.name)}</span><span class="meta">${escape(meta)}</span></span>
  </a>`;
  }).join('\n');

  const empty = entries.length === 0 ? '  <p class="empty">这个目录是空的。</p>' : '';

  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>文件 · ${escape(relative === '' ? '工作区' : relative)}</title>
<style>
 :root{color-scheme:light dark}
 body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;
      padding:1rem 1rem 3rem;max-width:34rem;margin-inline:auto}
 h1{font-size:1rem;margin:.2rem 0 1rem;opacity:.75;font-weight:600;word-break:break-all}
 .row{display:flex;gap:.75rem;align-items:center;padding:.8rem .9rem;margin-bottom:.5rem;
      border-radius:.8rem;border:1px solid rgba(128,128,128,.28);text-decoration:none;color:inherit}
 .row:active{border-color:#2563eb}
 .icon{font-size:1.15rem;line-height:1}
 .body{display:flex;flex-direction:column;min-width:0}
 .name{font-weight:600;word-break:break-all}
 .meta{font-size:.78rem;opacity:.6;margin-top:.15rem}
 .up{border-style:dashed;opacity:.75}
 .empty{opacity:.6;font-size:.9rem}
 footer{margin-top:1.2rem;font-size:.78rem;opacity:.45;line-height:1.7}
</style></head><body>
<h1>${escape(relative === '' ? '工作区' : relative)}</h1>
${up}
${rows}
${empty}
<footer>点击文件名直接下载到当前设备。<br>只能浏览工作区内的文件。</footer>
</body></html>`;
}
