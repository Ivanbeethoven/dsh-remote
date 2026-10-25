#!/bin/bash
# Configure and start the DSH relay as a systemd service.
set -e

APP=/opt/dsh-relay/app
DATA=/opt/dsh-relay/data
mkdir -p "$DATA"

# Reuse existing tokens on re-run so the plugin config stays valid.
if [ -f "$DATA/secrets.env" ]; then
  # shellcheck disable=SC1091
  . "$DATA/secrets.env"
else
  HOST_TOKEN=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40)
  ACCESS_TOKEN=$(openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c 28)
  cat > "$DATA/secrets.env" <<EOF
HOST_TOKEN=$HOST_TOKEN
ACCESS_TOKEN=$ACCESS_TOKEN
EOF
  chmod 600 "$DATA/secrets.env"
fi

cat > "$APP/start.sh" <<EOF
#!/bin/bash
exec /opt/dsh-relay/node/bin/node /opt/dsh-relay/app/bin/dsh-relay.mjs \\
  --port 8443 \\
  --host relay.example.com \\
  --cert /opt/dsh-relay/data/cert.pem \\
  --key /opt/dsh-relay/data/key.pem \\
  --host-token '$HOST_TOKEN' \\
  --access-token '$ACCESS_TOKEN'
EOF
chmod 700 "$APP/start.sh"

cat > /etc/systemd/system/dsh-relay.service <<'EOF'
[Unit]
Description=DSH relay (dsh-ssh-bridge)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/opt/dsh-relay/app/start.sh
Restart=always
RestartSec=3
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable dsh-relay >/dev/null 2>&1 || true
systemctl restart dsh-relay
sleep 4

echo "=== service ==="
systemctl is-active dsh-relay
systemctl is-enabled dsh-relay

echo "=== listening ==="
ss -lntp 2>/dev/null | grep ':8443' || echo "NOT LISTENING"

echo "=== local health check ==="
curl -sk --max-time 8 https://127.0.0.1:8443/__relay/health || echo "(health check failed)"

echo ""
echo "=== certificate ==="
openssl x509 -in "$DATA/cert.pem" -noout -subject -dates 2>/dev/null
openssl x509 -in "$DATA/cert.pem" -noout -fingerprint -sha256 2>/dev/null

echo ""
echo "=== tokens ==="
grep . "$DATA/secrets.env"

echo ""
echo "=== firewalld ==="
firewall-cmd --permanent --add-port=8443/tcp >/dev/null 2>&1 || true
firewall-cmd --reload >/dev/null 2>&1 || true
firewall-cmd --list-ports 2>/dev/null

echo ""
echo "=== last log lines ==="
journalctl -u dsh-relay -n 12 --no-pager 2>/dev/null | tail -12
