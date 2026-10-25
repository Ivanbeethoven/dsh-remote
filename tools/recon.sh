#!/bin/bash
# Read-only reconnaissance of the relay host.
echo "=== os ==="
cat /etc/os-release 2>/dev/null | head -3
echo "arch: $(uname -m)  kernel: $(uname -r)"

echo "=== node / npm ==="
command -v node >/dev/null && echo "node: $(node -v)" || echo "node: NOT INSTALLED"
command -v npm >/dev/null && echo "npm: $(npm -v)" || echo "npm: NOT INSTALLED"

echo "=== openssl ==="
command -v openssl >/dev/null && openssl version || echo "openssl: NOT INSTALLED"

echo "=== memory / disk ==="
free -m | head -2
df -h / | tail -1

echo "=== listening ==="
(ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null) | head -15

echo "=== running services (top 15) ==="
systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | awk '{print $1}' | head -15

echo "=== firewall ==="
echo "firewalld: $(systemctl is-active firewalld 2>/dev/null)"
if command -v firewall-cmd >/dev/null; then firewall-cmd --state 2>/dev/null; fi
echo "iptables rules: $(iptables -S 2>/dev/null | wc -l)"

echo "=== existing /opt ==="
ls -la /opt 2>/dev/null | head -10

echo "=== self check: 8443 free? ==="
(ss -lnt 2>/dev/null | grep -q ':8443 ' && echo "8443: IN USE") || echo "8443: free"
echo "=== can reach npm registry? ==="
timeout 8 curl -sS -o /dev/null -w "registry.npmjs.org -> %{http_code}\n" https://registry.npmjs.org/ 2>&1 | tail -1
timeout 8 curl -sS -o /dev/null -w "npmmirror -> %{http_code}\n" https://registry.npmmirror.com/ 2>&1 | tail -1
