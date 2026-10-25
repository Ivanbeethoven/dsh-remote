#!/bin/bash
# Install a self-contained Node 22 into /opt/dsh-relay/node.
# No package manager, no system-wide change: everything lives under /opt/dsh-relay.
set -e

mkdir -p /opt/dsh-relay/node
cd /tmp

FILE=""
BASE=""
for base in https://npmmirror.com/mirrors/node https://nodejs.org/dist; do
  if FILE=$(curl -fsSL --max-time 25 "$base/latest-v22.x/SHASUMS256.txt" | grep -o 'node-v22[0-9.]*-linux-x64\.tar\.xz' | head -1) && [ -n "$FILE" ]; then
    BASE="$base"
    break
  fi
done

if [ -z "$FILE" ]; then
  echo "could not resolve a Node 22 release from the mirrors"
  exit 1
fi

echo "downloading $BASE/latest-v22.x/$FILE"
curl -fsSL --max-time 240 "$BASE/latest-v22.x/$FILE" -o /tmp/node.tar.xz
echo "downloaded $(du -h /tmp/node.tar.xz | cut -f1)"

tar xf /tmp/node.tar.xz -C /opt/dsh-relay/node --strip-components=1
rm -f /tmp/node.tar.xz

echo "node: $(/opt/dsh-relay/node/bin/node -v)"
echo "npm:  $(/opt/dsh-relay/node/bin/npm -v 2>/dev/null || echo '(none)')"
echo "openssl: $(openssl version)"
echo "--- disk ---"
du -sh /opt/dsh-relay
