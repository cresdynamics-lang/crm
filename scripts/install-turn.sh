#!/usr/bin/env bash
# Install the TURN relay (coturn) for CRES OS meetings on the live droplet.
#
# Why: meetings are peer-to-peer over the internet (WebRTC). When two people's
# networks can't reach each other directly (mobile data / CGNAT, office or hotel
# Wi-Fi), the call has no path and nobody hears anyone. TURN relays the audio
# and video through this server, so anyone who is online can talk.
#
# Run ON THE SERVER as a sudo user:
#   sudo bash scripts/install-turn.sh
#
# What it changes (all reversible - see "Undo" at the bottom):
#   - installs the coturn package
#   - writes /etc/turnserver.conf (secret-based, short-lived logins; never relays
#     into this server or private networks, so Redis/Postgres/other sites stay safe)
#   - copies the cresos.cresdynamics.com certificate for TLS, plus a certbot hook
#     that re-copies it on renewal
#   - opens firewall ports 3478 udp/tcp, 5349 udp/tcp, 49160-49400 udp
#   - adds MEETING_TURN_URLS and MEETING_TURN_SECRET to the CRES OS .env
set -euo pipefail

DOMAIN=cresos.cresdynamics.com
PUBLIC_IP=$(ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1 | grep -v '^10\.' | head -1)
APP_ENV=/var/www/sites/crm.cresdynamics.com/.env
MIN_PORT=49160
MAX_PORT=49400

[[ $EUID -eq 0 ]] || { echo "Run with sudo"; exit 1; }
[[ -n "$PUBLIC_IP" ]] || { echo "Could not find the public IP"; exit 1; }
[[ -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem ]] || { echo "No certificate for $DOMAIN"; exit 1; }

echo "[turn] installing coturn"
DEBIAN_FRONTEND=noninteractive apt-get install -y -q coturn >/dev/null

SECRET=$(grep -E '^static-auth-secret=' /etc/turnserver.conf 2>/dev/null | cut -d= -f2 || true)
[[ -n "$SECRET" ]] || SECRET=$(openssl rand -hex 32)

echo "[turn] certificate"
mkdir -p /etc/coturn/certs
install -m 640 -o root -g turnserver "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" /etc/coturn/certs/fullchain.pem
install -m 640 -o root -g turnserver "/etc/letsencrypt/live/$DOMAIN/privkey.pem" /etc/coturn/certs/privkey.pem

cat > /etc/letsencrypt/renewal-hooks/deploy/coturn-cres.sh <<'HOOK'
#!/bin/sh
# Re-copy the renewed cresos certificate for the meetings TURN relay.
case "$RENEWED_LINEAGE" in */cresos.cresdynamics.com)
  install -m 640 -o root -g turnserver "$RENEWED_LINEAGE/fullchain.pem" /etc/coturn/certs/fullchain.pem
  install -m 640 -o root -g turnserver "$RENEWED_LINEAGE/privkey.pem" /etc/coturn/certs/privkey.pem
  systemctl restart coturn ;;
esac
HOOK
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/coturn-cres.sh

echo "[turn] config"
[[ -f /etc/turnserver.conf && ! -f /etc/turnserver.conf.dist ]] && cp /etc/turnserver.conf /etc/turnserver.conf.dist
cat > /etc/turnserver.conf <<CONF
# CRES OS meetings relay (coturn). Written by scripts/install-turn.sh
listening-port=3478
tls-listening-port=5349
listening-ip=${PUBLIC_IP}
relay-ip=${PUBLIC_IP}
external-ip=${PUBLIC_IP}
min-port=${MIN_PORT}
max-port=${MAX_PORT}
realm=${DOMAIN}
server-name=${DOMAIN}
fingerprint
use-auth-secret
static-auth-secret=${SECRET}
cert=/etc/coturn/certs/fullchain.pem
pkey=/etc/coturn/certs/privkey.pem
no-tlsv1
no-tlsv1_1
total-quota=60
user-quota=12
stale-nonce=600
max-bps=3000000
no-cli
no-multicast-peers
no-loopback-peers
# Never relay into this server or private networks
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=224.0.0.0-255.255.255.255
denied-peer-ip=${PUBLIC_IP}
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
syslog
simple-log
CONF
chown root:turnserver /etc/turnserver.conf
chmod 640 /etc/turnserver.conf
[[ -f /etc/default/coturn ]] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn

echo "[turn] firewall"
ufw allow 3478/udp comment 'coturn' >/dev/null
ufw allow 3478/tcp comment 'coturn' >/dev/null
ufw allow 5349/tcp comment 'coturn tls' >/dev/null
ufw allow 5349/udp comment 'coturn tls' >/dev/null
ufw allow ${MIN_PORT}:${MAX_PORT}/udp comment 'coturn relay' >/dev/null

echo "[turn] app settings"
sed -i '/^MEETING_TURN_/d;/^# Meetings TURN relay/d' "$APP_ENV"
{
  echo "# Meetings TURN relay (coturn on this server)"
  echo "MEETING_TURN_URLS=turn:${DOMAIN}:3478?transport=udp,turn:${DOMAIN}:3478?transport=tcp,turns:${DOMAIN}:5349?transport=tcp"
  echo "MEETING_TURN_SECRET=${SECRET}"
} >> "$APP_ENV"

systemctl enable coturn >/dev/null 2>&1
systemctl restart coturn
sleep 2
systemctl is-active --quiet coturn && echo "[turn] coturn is running" || { journalctl -u coturn -n 30 --no-pager; exit 1; }
ss -lntup | grep -E ':(3478|5349)\b' || true
echo "[turn] done. Restart CRES OS so it picks up the new settings:"
echo "  sudo -u site_crm pm2 restart cres-crm cres-crm-worker --update-env"

# Undo:
#   systemctl disable --now coturn && apt-get remove -y coturn
#   ufw delete allow 3478/udp; ufw delete allow 3478/tcp; ufw delete allow 5349/tcp
#   ufw delete allow 5349/udp; ufw delete allow 49160:49400/udp
#   sed -i '/^MEETING_TURN_/d' /var/www/sites/crm.cresdynamics.com/.env
#   rm /etc/letsencrypt/renewal-hooks/deploy/coturn-cres.sh
