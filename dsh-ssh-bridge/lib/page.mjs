/**
 * A small self-contained status page for `/ssh-bridge`, aimed at the owner's browser
 * (desktop, or an already-paired phone) rather than at the phone's first visit.
 *
 * It renders for both transports: an SSH-forward pairing, or a relay URL that needs
 * nothing but a browser.
 *
 * @module dsh-ssh-bridge/page
 */

/**
 * Escape text for HTML text and attribute contexts.
 * @param {unknown} value - Value to escape.
 * @returns {string} Escaped text.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Map a transport state to a badge colour.
 * @param {string} state - Transport state.
 * @returns {string} CSS colour.
 */
function stateColour(state) {
  if (state === 'forwarding' || state === 'ready') return '#16a34a';
  if (state === 'connected' || state === 'connecting' || state === 'retrying') return '#d97706';
  if (state === 'failed') return '#dc2626';
  return '#6b7280';
}

/**
 * Render a copyable block with a copy button.
 * @param {string} id - Element id for the copy target.
 * @param {string} label - Section label.
 * @param {string} value - Text to copy.
 * @param {string} [note] - Optional explanation under the block.
 * @returns {string} HTML fragment.
 */
function copyBlock(id, label, value, note) {
  return `<section>
  <div class="row"><h2>${escapeHtml(label)}</h2><button data-copy="${id}">copy</button></div>
  <pre id="${id}">${escapeHtml(value)}</pre>
  ${note === undefined ? '' : `<p class="muted">${note}</p>`}
</section>`;
}

/**
 * Render a definition list from label/value pairs.
 * @param {[string, string][]} rows - Rows to render.
 * @returns {string} HTML fragment.
 */
function definitionList(rows) {
  const body = rows
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join('');
  return `<dl>${body}</dl>`;
}

/**
 * Pairing section for a relay-backed bridge: a plain HTTPS URL, no client needed.
 * @param {object} pairing - Relay pairing material.
 * @returns {string} HTML fragment.
 */
function relayPairing(pairing) {
  return `${copyBlock(
    'pair-url',
    'Open this on the phone',
    pairing.tokenUrl ?? pairing.url,
    'First visit only: this link trades the relay access key and the DSH launch token for cookies. '
    + `Afterwards just open <code>${escapeHtml(pairing.url)}</code>. No app and no SSH client are involved.`,
  )}
${pairing.qrDataUrl === undefined ? '' : `<section><h2>Scan</h2><img class="qr" src="${pairing.qrDataUrl}" alt="pairing QR code"></section>`}`;
}

/**
 * Pairing section for an SSH-forwarded bridge: a command, a config block, and a URL.
 * @param {object} pairing - SSH pairing material.
 * @returns {string} HTML fragment.
 */
function sshPairing(pairing) {
  return `${copyBlock('ssh-command', 'Run this on the phone', pairing.sshCommand)}
${copyBlock('ssh-config', 'Or paste into ~/.ssh/config', pairing.sshConfig)}
<section>
  <div class="row"><h2>Open on the phone</h2><button data-copy="pair-url">copy</button></div>
  <pre id="pair-url">${escapeHtml(pairing.tokenUrl ?? pairing.url)}</pre>
  <p class="muted">First visit only: this URL carries the launch token and sets the browser cookie.
  Afterwards open <code>${escapeHtml(pairing.url)}</code>.</p>
  ${pairing.qrDataUrl === undefined ? '' : `<img class="qr" src="${pairing.qrDataUrl}" alt="pairing QR code">`}
</section>`;
}

/**
 * Transport-specific detail rows.
 * @param {object} status - Transport snapshot.
 * @returns {[string, string][]} Rows.
 */
function connectionRows(status) {
  if (status.mode === 'relay') {
    const target = status.relay.publicUrl ?? '';
    return [
      ['Mode', 'relay (HTTPS, no SSH)'],
      ['Relay', `${status.relay.host}:${status.relay.port}`],
      ['Public URL', target],
      ['Idle connections', `${status.idle} / ${status.poolSize}`],
      ['Certificate', status.relay.pinned === true ? 'pinned by fingerprint' : 'verified by trust store'],
      ['Served', String(status.stats.served)],
      ['Last error', status.lastError ?? 'none'],
    ];
  }

  const target = status.forward.target === null
    ? 'unknown'
    : `${status.forward.target.host}:${status.forward.target.port}`;
  return [
    ['Mode', 'ssh (remote forward)'],
    ['SSH server', `${status.ssh.username}@${status.ssh.host}:${status.ssh.port}`],
    ['Published at', `${status.forward.bindAddress}:${status.forward.remotePort}`],
    ['Forwarded to', target],
    ['Auth', status.authMethod ?? 'not connected'],
    ['Attempts', String(status.attempt)],
    ['Channels', `${status.stats.openChannels} open / ${status.stats.totalChannels} total`],
    ['Last error', status.lastError ?? 'none'],
  ];
}

/**
 * Render the whole status page.
 * @param {object} options - Page inputs.
 * @param {object} options.status - Transport snapshot.
 * @param {object | undefined} options.pairing - Pairing material, when available.
 * @param {string} [options.hint] - Extra guidance for a non-ready state.
 * @returns {string} Complete HTML document.
 */
export function renderStatusPage({ status, pairing, hint }) {
  const colour = stateColour(status.state);

  const body = pairing === undefined
    ? `<section><p class="muted">Nothing to pair yet.</p>${hint === undefined ? '' : `<p class="muted">${escapeHtml(hint)}</p>`}</section>`
    : (pairing.mode === 'relay' ? relayPairing(pairing) : sshPairing(pairing));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>DSH bridge</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 0 auto; max-width: 42rem; padding: 1.25rem 1rem 3rem; }
  h1 { font-size: 1.15rem; margin: 0 0 .25rem; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; margin: 0; opacity: .72; }
  section { border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
            border-radius: .7rem; padding: .8rem .9rem; margin: 0 0 .8rem; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: .75rem; margin-bottom: .5rem; }
  .badge { display: inline-block; padding: .15rem .55rem; border-radius: 999px;
           color: #fff; background: ${colour}; font-size: .8rem; font-weight: 600; }
  .muted { opacity: .7; font-size: .86rem; margin: .5rem 0 0; }
  pre { margin: 0; padding: .6rem; overflow-x: auto; white-space: pre-wrap; word-break: break-all;
        background: color-mix(in srgb, currentColor 7%, transparent); border-radius: .5rem;
        font: .82rem/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  code { font: .86em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  button { font: inherit; font-size: .78rem; padding: .2rem .6rem; border-radius: .45rem; cursor: pointer;
           border: 1px solid color-mix(in srgb, currentColor 25%, transparent); background: transparent; color: inherit; }
  .qr { display: block; width: 100%; max-width: 17rem; margin: .8rem auto 0; image-rendering: pixelated;
        background: #fff; padding: .4rem; border-radius: .5rem; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: .3rem .9rem; margin: 0; font-size: .88rem; }
  dt { opacity: .68; }
  dd { margin: 0; overflow-wrap: anywhere; }
</style>
</head>
<body>
<h1>DSH bridge <span class="badge">${escapeHtml(status.state)}</span></h1>
<p class="muted">${status.mode === 'relay'
    ? 'The DSH host keeps idle TLS connections to the relay; the phone only needs a browser.'
    : 'An outbound SSH connection publishes this DSH on the SSH server’s loopback; the phone opens a local forward to the same port.'}</p>
${body}
<section>
  <h2>Connection</h2>
  ${definitionList(connectionRows(status))}
</section>
<script>
for (const button of document.querySelectorAll('button[data-copy]')) {
  button.addEventListener('click', async () => {
    const element = document.getElementById(button.dataset.copy);
    if (element === null) return;
    try {
      await navigator.clipboard.writeText(element.textContent ?? '');
      button.textContent = 'copied';
      setTimeout(() => { button.textContent = 'copy'; }, 1200);
    } catch { button.textContent = 'select it'; }
  });
}
</script>
</body>
</html>`;
}
