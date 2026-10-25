#!/bin/bash
# Raise the relay's idle-pool ceiling to match the plugin's poolSize (32).
# A browser opens several connections at once for one page, so the cap must clear that.
set -e

DATA=/opt/dsh-relay/data
. "$DATA/secrets.env"

cat > /opt/dsh-relay/app/start.sh <<EOF
#!/bin/bash
exec /opt/dsh-relay/node/bin/node /opt/dsh-relay/app/bin/dsh-relay.mjs \\
  --port 8443 --host relay.example.com \\
  --cert /opt/dsh-relay/data/cert.pem --key /opt/dsh-relay/data/key.pem \\
  --host-token '$HOST_TOKEN' --access-token '$ACCESS_TOKEN' \\
  --pool 64
EOF
chmod 700 /opt/dsh-relay/app/start.sh

systemctl restart dsh-relay
sleep 6
echo "service: $(systemctl is-active dsh-relay)"
cat /opt/dsh-relay/app/start.sh | tail -3
curl -sk --max-time 8 https://127.0.0.1:8443/__relay/health
