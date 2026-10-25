---
name: dsh-remote
description: Install and configure dsh-remote so a user can reach their DeepSeek Harness from a phone — an outbound-only relay or SSH tunnel plus an optional Android app. Use when the user wants remote/mobile access to their DSH, or needs an existing dsh-remote deployment diagnosed.
---

# dsh-remote

Gives a user access to one DSH instance from a phone without exposing any inbound port on the
DSH host. The host dials out; the phone dials in; they meet at a server the user controls.

Two transports, same plugin:

- **relay** (recommended for phones) — the plugin keeps idle TLS connections to a relay on a
  public server; the phone opens one HTTPS URL in a browser. No app, no SSH client.
- **ssh** — the plugin opens a remote forward on an existing sshd; the phone uses any SSH
  client with `-L`. Nothing to install on the server.

Before starting, establish which transport the user wants and whether they already have a
server with a public IP. Both layouts are in `README.md`; read it before improvising.

## Step 1 — install the plugin into a profile

The profile's `cordis.patch.yml` is the only place to edit.

```yaml
- insert:
    - id: ssh-bridge
      name: dsh-ssh-bridge
      config:
        transport: relay
        relay:
          host: relay.example.com
          port: 8443
          publicHost: relay.example.com
          token: 'REPLACE_WITH_YOUR_HOST_TOKEN'
          accessToken: 'REPLACE_WITH_YOUR_ACCESS_KEY'
          fingerprint: 'REPLACE_WITH_RELAY_CERT_SHA256'
          poolSize: 32
          refreshMs: 300
```

The package must be resolvable from the profile. For a checkout, a directory junction into
`<profile>/node_modules/dsh-ssh-bridge` is enough on Windows; `pnpm add file:<path>` works too.
Editing the patch file reloads the plugin without restarting DSH.

**Relay mode also needs the phone's authority trusted**, because it is no longer loopback:

```yaml
- id: connection
  config:
    trustedHosts: !!js "[...(ctx.webStartup?.trustedHosts ?? []), 'relay.example.com:8443']"
```

The `!!js` value must be a **quoted string**, or the YAML parser treats it as a flow sequence.
Skipping this yields a page shell whose every `/api` call is `403` — it looks like a blank app.

## Step 2 — run the relay (relay mode only)

Needs Node 22 on the server. No npm dependencies: certificate generation falls back to
`openssl` when the optional `selfsigned` package is absent.

```bash
scp -r dsh-ssh-bridge user@server:/opt/
cd /opt/dsh-ssh-bridge && node bin/dsh-relay.mjs --port 8443 --host <public-address> --pool 64
```

It prints the host token, access key, certificate fingerprint, and a ready-to-paste plugin
config. Keep those three values; only the certificate changes if it is regenerated.

Open the port in the cloud firewall **and** the host firewall. Run it under systemd with
`Restart=always` so a dropped connection is not permanent.

## Step 3 — pair the phone

Tell the user to open `http://127.0.0.1:<dshPort>/ssh-bridge?rk=<accessToken>` on the desktop
or read the QR from it. That page always renders the *current* pairing link.

The launch token rotates on every DSH restart, so never hand a user a stored link; send them
to that page. The fixed local pairing page (`pairing.localPort`, default 9300) is bookmarkable
and survives restarts — prefer it when the user will pair more than once.

## Step 4 — the Android app (optional)

`android-app/` builds a WebView shell that holds only the relay URL and access key, and fetches
the rotating token itself on each launch:

```
/ssh-bridge?rk=<key>&go=1  -> 302 to the current pairing link -> both cookies -> DSH UI
```

`go=1` makes the plugin answer with a redirect instead of the status page. The app trusts the
relay certificate as a bundled anchor (`res/raw/relay_cert.pem`); the committed one is a sample.

## Diagnosing a blank screen

Work outside-in before changing app code:

1. `curl -sk https://<relay>/__relay/health` — `idle` must exceed the browser's per-host
   connection count (it opens 6–12 at once). A small `poolSize` makes the relay answer `503`
   for some assets; the HTML still renders 200, so there is no error page — just white.
2. `node tools/check-app-flow.mjs <relayBase> <accessKey>` — walks the redirect chain and
   prints each hop plus the cookies collected. Both `dsh_relay` and `dsh-auth-*` must appear.
3. `node tools/check-assets.mjs <relayBase> <accessKey>` — fetches every asset the index
   references and attempts the `/api/remote.mux` upgrade.
4. `node tools/probe-browser.mjs <pairingLink>` — loads the page in real Chromium and reports
   `#root` child count, uncaught errors, and failed requests. `#root` empty with no failed
   requests points at a script that never ran.

## Rules

- Never write a real access token, host token, certificate fingerprint, keystore, or built APK
  into a repository. An APK contains the access key; publishing it hands out access.
- `poolSize` must exceed the browser's concurrent connection count; keep it at 32 or above and
  the relay's `--pool` at 64.
- Rotating the relay certificate requires replacing `res/raw/relay_cert.pem`, the pinned
  fingerprint in both the plugin and the app, and rebuilding the app.
- Revoking access means changing `ACCESS_TOKEN` in the relay's `secrets.env` and restarting it;
  existing phone cookies stop working.
