#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# For hosts that can't give the browser an internal-only network (Harbor): the container firewalls
# itself so its only way out is the egress proxy, then drops root and every capability before
# starting the browser host. Fails closed: if the rules can't be installed, nothing starts.
set -eu
PROXY_HOST="${CROSSBAR_PROXY_HOST:-proxy}"
PROXY_PORT="${CROSSBAR_PROXY_PORT:-3128}"

ips=""
for i in $(seq 1 30); do
  ips=$(getent ahosts "$PROXY_HOST" | awk '{print $1}' | sort -u || true)
  [ -n "$ips" ] && break
  sleep 1
done
[ -n "$ips" ] || { echo "egress-firewall: can't resolve $PROXY_HOST" >&2; exit 1; }

iptables -F OUTPUT
iptables -P OUTPUT DROP
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

if ip6tables -F OUTPUT 2>/dev/null; then
  ip6tables -P OUTPUT DROP
  ip6tables -A OUTPUT -o lo -j ACCEPT
  ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
elif grep -qv ' lo$' /proc/net/if_inet6 2>/dev/null; then
  echo "egress-firewall: IPv6 is up but ip6tables isn't usable; refusing to start" >&2
  exit 1
fi

for ip in $ips; do
  case "$ip" in
    *:*) ip6tables -A OUTPUT -d "$ip" -p tcp --dport "$PROXY_PORT" -j ACCEPT ;;
    *) iptables -A OUTPUT -d "$ip" -p tcp --dport "$PROXY_PORT" -j ACCEPT ;;
  esac
done
echo "egress-firewall: only $PROXY_HOST ($ips) port $PROXY_PORT is reachable"

# Check it: a direct connection to the internet must fail.
if node -e "require('net').connect({host:'1.1.1.1',port:443,timeout:2000}).on('connect',()=>process.exit(0)).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))" 2>/dev/null; then
  echo "egress-firewall: direct egress still works; refusing to start" >&2
  exit 1
fi

# Switching to a non-root user clears every capability; no-new-privs stops setuid binaries regaining any.
exec setpriv --reuid=crossbar --regid=crossbar --init-groups --inh-caps=-all --no-new-privs \
  xvfb-run -a --server-args="-screen 0 1280x1024x24 -nolisten tcp" node browser/src/host.ts
