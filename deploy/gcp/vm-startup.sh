#!/bin/bash
# Runs on the myCALL VM at every boot (and on each update). Idempotent.
# Mounts the data disk, installs Docker, pulls the app image, reads secrets
# from Secret Manager and starts the app behind Caddy (automatic HTTPS).
set -euo pipefail

MD=http://metadata.google.internal/computeMetadata/v1
md() { curl -fsS -H "Metadata-Flavor: Google" "$MD/$1"; }
IMAGE=$(md instance/attributes/mycall-image)
DOMAIN=$(md instance/attributes/mycall-domain 2>/dev/null || true)
PROJECT=$(md project/project-id)
IP=$(md instance/network-interfaces/0/access-configs/0/external-ip)
DOMAIN=${DOMAIN:-${IP//./-}.sslip.io}
TOKEN=$(md instance/service-accounts/default/token | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')

# ---- Data disk (recordings + database live here, survive VM rebuilds) ----
DEV=/dev/disk/by-id/google-mycall-data
mkdir -p /mnt/mycall
blkid "$DEV" >/dev/null 2>&1 || mkfs.ext4 -q -F "$DEV"
grep -q " /mnt/mycall " /etc/fstab || echo "$DEV /mnt/mycall ext4 defaults,nofail 0 2" >> /etc/fstab
mountpoint -q /mnt/mycall || mount /mnt/mycall
mkdir -p /mnt/mycall/data /mnt/mycall/caddy
chown 1000:1000 /mnt/mycall/data   # the app runs as the image's "node" user (uid 1000)

# ---- Docker ----
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
REGISTRY=${IMAGE%%/*}
echo "$TOKEN" | docker login -u oauth2accesstoken --password-stdin "https://$REGISTRY" >/dev/null

# ---- Secrets -> env file readable by root only ----
secret() {
  curl -fsS -H "Authorization: Bearer $TOKEN" \
    "https://secretmanager.googleapis.com/v1/projects/$PROJECT/secrets/$1/versions/latest:access" |
    python3 -c 'import base64,json,sys; print(base64.b64decode(json.load(sys.stdin)["payload"]["data"]).decode(), end="")'
}
install -d -m 700 /etc/mycall
# Read both secrets first; never write (or start with) an empty password.
DG_KEY=$(secret mycall-deepgram-key)
API_TOKEN=$(secret mycall-api-token)
if [ -z "$DG_KEY" ] || [ -z "$API_TOKEN" ]; then
  echo "Could not read secrets from Secret Manager; not starting myCALL." >&2
  exit 1
fi
umask 077
printf 'DEEPGRAM_API_KEY=%s\nMYCALL_API_TOKEN=%s\nMYCALL_REQUIRE_TOKEN=true\n' "$DG_KEY" "$API_TOKEN" > /etc/mycall/mycall.env.new
mv /etc/mycall/mycall.env.new /etc/mycall/mycall.env
umask 022

cat > /etc/mycall/Caddyfile <<CADDY
$DOMAIN {
	encode gzip
	request_body {
		max_size 250MB
	}
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy app:8787
}
CADDY

cat > /etc/mycall/compose.yml <<COMPOSE
services:
  app:
    image: $IMAGE
    restart: unless-stopped
    env_file: /etc/mycall/mycall.env
    volumes: ["/mnt/mycall/data:/data"]
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes: ["/etc/mycall/Caddyfile:/etc/caddy/Caddyfile:ro", "/mnt/mycall/caddy:/data"]
    depends_on: [app]
COMPOSE

docker compose -f /etc/mycall/compose.yml pull -q
docker compose -f /etc/mycall/compose.yml up -d --remove-orphans
# Caddy doesn't watch its config file; reload so a changed DOMAIN takes effect.
docker compose -f /etc/mycall/compose.yml exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
docker image prune -f >/dev/null
echo "myCALL is running at https://$DOMAIN"
