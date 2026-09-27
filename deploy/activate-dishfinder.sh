#!/usr/bin/env bash
set -euo pipefail

domain=dishfinder.ru
ip=89.223.123.75
config=/root/dishfinder-https.conf

# Wait for delegation and both public addresses before asking Let's Encrypt.
if ! dig +short @1.1.1.1 "$domain" NS | grep -qi '^ns1\.beget\.com\.$'; then
  echo "Waiting for .ru delegation"
  exit 0
fi
for name in "$domain" "www.$domain"; do
  if [[ "$(dig +short @1.1.1.1 "$name" A | sort -u)" != "$ip" ]]; then
    echo "Waiting for public DNS: $name"
    exit 0
  fi
done

test -f "$config"
certbot certonly --webroot -w /var/www/html --cert-name dishfinder \
  -d "$domain" -d "www.$domain" --non-interactive --agree-tos
install -m 0644 "$config" /etc/nginx/sites-available/dishfinder.ru
nginx -t
systemctl reload nginx
curl --fail --silent --show-error --max-time 15 \
  --resolve "$domain:443:$ip" "https://$domain/healthz" | grep -q '"ok":true'
curl --fail --silent --show-error --max-time 15 --location \
  --resolve "www.$domain:443:$ip" --resolve "$domain:443:$ip" \
  "https://www.$domain/healthz" | grep -q '"ok":true'
echo "HTTPS active for $domain"
systemctl disable --now dishfinder-activate.timer
