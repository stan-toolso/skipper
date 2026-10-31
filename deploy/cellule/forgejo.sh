#!/usr/bin/env bash
# Forgejo, la forge des dépôts hébergés par Skipper, sur une cellule. En root ; idempotent (relancer = mise à jour de
# l'image). Forgejo tourne en conteneur Docker (image rootless, réseau de l'hôte, écoute sur 127.0.0.1 seulement) avec
# sa base dans le PostgreSQL local, et se sert derrière nginx sous <URL>/forge/ (bloc nginx : templates/nginx-site.conf).
#
#   ./forgejo.sh --url https://skipper.toolso.io/forge [--version 17] [--port 3000]
#
# Première installation : rôle et base PostgreSQL `forgejo` (mot de passe dans /etc/skipper/forgejo.env), configuration
# /var/lib/forgejo/conf/app.ini (depuis templates/forgejo-app.ini), compte administrateur `skipper-admin` et son jeton,
# puis les variables FORGEJO_* ajoutées au .env de Skipper (jamais affichées). Ensuite : `systemctl restart skipper`
# (ou deploy.sh), puis le bloc nginx.
set -euo pipefail

URL=""
VERSION="17"
PORT="3000"
SKIPPER_ENV="/home/skipper/skipper/.env"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="${2%/}"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --skipper-env) SKIPPER_ENV="$2"; shift 2 ;;
    *) echo "Option inconnue : $1" >&2; exit 2 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "À lancer en root" >&2; exit 1; }
[[ -n "$URL" ]] || { echo "--url est obligatoire (ex. https://skipper.toolso.io/forge)" >&2; exit 2; }

HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="codeberg.org/forgejo/forgejo:${VERSION}-rootless"
DATA=/var/lib/forgejo
NAME=forgejo
UIDGID=1000:1000
# L'image rootless lit sa configuration dans /var/lib/gitea/custom/conf/app.ini par défaut : sans cette variable, Forgejo
# démarrerait sans la nôtre, en mode installation et à l'écoute sur 0.0.0.0 (constat du 31/10/2026).
APP_INI_ENV="GITEA_APP_INI=/etc/gitea/app.ini"
DOMAIN="$(echo "$URL" | sed -E 's#^https?://([^/:]+).*#\1#')"
log() { echo "[forgejo] $*"; }

# 1. Base PostgreSQL ------------------------------------------------------------
install -d -m 750 /etc/skipper
if [[ ! -f /etc/skipper/forgejo.env ]]; then
  umask 077
  printf 'FORGEJO_DB_PASSWORD=%s\n' "$(openssl rand -hex 24)" > /etc/skipper/forgejo.env
fi
# shellcheck disable=SC1091
. /etc/skipper/forgejo.env
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'forgejo'" | grep -q 1; then
  sudo -u postgres psql -q -c "CREATE ROLE forgejo LOGIN PASSWORD '${FORGEJO_DB_PASSWORD}'"
  log "rôle PostgreSQL forgejo créé"
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'forgejo'" | grep -q 1; then
  sudo -u postgres psql -q -c "CREATE DATABASE forgejo OWNER forgejo ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8' TEMPLATE template0"
  log "base PostgreSQL forgejo créée"
fi

# 2. Image et configuration ------------------------------------------------------
docker pull -q "$IMAGE" > /dev/null
install -d -o 1000 -g 1000 -m 750 "$DATA" "$DATA/data" "$DATA/conf"
if [[ ! -f "$DATA/conf/app.ini" ]]; then
  gen() { docker run --rm --user "$UIDGID" "$IMAGE" forgejo generate secret "$1"; }
  sed -e "s#__ROOT_URL__#${URL}#" -e "s#__DOMAIN__#${DOMAIN}#" -e "s#__PORT__#${PORT}#" \
      -e "s#__DB_PASSWORD__#${FORGEJO_DB_PASSWORD}#" \
      -e "s#__SECRET_KEY__#$(gen SECRET_KEY)#" -e "s#__INTERNAL_TOKEN__#$(gen INTERNAL_TOKEN)#" \
      -e "s#__LFS_JWT_SECRET__#$(gen LFS_JWT_SECRET)#" -e "s#__JWT_SECRET__#$(gen JWT_SECRET)#" \
      "$HERE/templates/forgejo-app.ini" > "$DATA/conf/app.ini"
  chown 1000:1000 "$DATA/conf/app.ini"
  chmod 600 "$DATA/conf/app.ini"
  log "configuration écrite dans $DATA/conf/app.ini"
fi

# 3. Conteneur ---------------------------------------------------------------------
if docker inspect "$NAME" > /dev/null 2>&1; then
  if [[ "$(docker inspect -f '{{.Config.Image}}' "$NAME")" == "$IMAGE" && "$(docker inspect -f '{{.Image}}' "$NAME")" == "$(docker image inspect -f '{{.Id}}' "$IMAGE")" ]] \
     && docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$NAME" | grep -qx "$APP_INI_ENV"; then
    docker start "$NAME" > /dev/null
  else
    log "nouvelle image ou réglages changés : recréation du conteneur"
    docker rm -f "$NAME" > /dev/null
  fi
fi
if ! docker inspect "$NAME" > /dev/null 2>&1; then
  docker run -d --name "$NAME" --restart unless-stopped --network host --user "$UIDGID" -e "$APP_INI_ENV" \
    -v "$DATA/data:/var/lib/gitea" -v "$DATA/conf:/etc/gitea" "$IMAGE" > /dev/null
fi
# Garde-fou : la configuration doit avoir été lue (écoute locale, installation verrouillée).
check_config() {
  if ss -ltn | grep -qE '(0\.0\.0\.0|\*|\[::\]):'"$PORT"' '; then
    docker stop "$NAME" > /dev/null; echo "Forgejo écoute sur toutes les interfaces : configuration non lue, conteneur arrêté" >&2; exit 1
  fi
}
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:${PORT}/api/healthz" > /dev/null && break
  sleep 2
done
curl -sf "http://127.0.0.1:${PORT}/api/healthz" > /dev/null || { echo "Forgejo ne répond pas : docker logs $NAME" >&2; exit 1; }
check_config
curl -s "http://127.0.0.1:${PORT}/api/v1/version" | grep -q '"version"\|signed in' || { docker stop "$NAME" > /dev/null; echo "Forgejo en mode installation : configuration non lue, conteneur arrêté" >&2; exit 1; }
log "Forgejo $(curl -s "http://127.0.0.1:${PORT}/api/v1/version" | sed -E 's/.*"version":"([^"]+)".*/\1/') en marche sur 127.0.0.1:${PORT}"

# 4. Compte administrateur et variables de Skipper ----------------------------------
fj() { docker exec "$NAME" forgejo "$@"; }
if ! fj admin user list --admin 2>/dev/null | awk '{print $2}' | grep -qx skipper-admin; then
  fj admin user create --admin --username skipper-admin --email skipper-admin@localhost --random-password --must-change-password=false > /dev/null
  log "compte administrateur skipper-admin créé"
fi
if [[ -f "$SKIPPER_ENV" ]] && ! grep -q '^FORGEJO_TOKEN=' "$SKIPPER_ENV"; then
  TOKEN="$(fj admin user generate-access-token --username skipper-admin --token-name "skipper-$(date +%Y%m%d%H%M)" --scopes all --raw | tail -1)"
  [[ "$TOKEN" =~ ^[0-9a-f]{40}$ ]] || { echo "Jeton administrateur inattendu" >&2; exit 1; }
  {
    echo ""
    echo "# Forgejo (deploy/cellule/forgejo.sh)"
    echo "FORGEJO_URL=${URL}"
    echo "FORGEJO_INTERNAL_URL=http://127.0.0.1:${PORT}"
    echo "FORGEJO_TOKEN=${TOKEN}"
    echo "FORGEJO_WEBHOOK_SECRET=$(openssl rand -hex 32)"
    echo "FORGEJO_CLI=docker exec ${NAME} forgejo"
  } >> "$SKIPPER_ENV"
  log "variables FORGEJO_* ajoutées à $SKIPPER_ENV : redémarrer Skipper pour les prendre en compte"
fi
log "terminé. Restent : bloc nginx « /forge/ » (templates/nginx-site.conf), puis nginx -t && systemctl reload nginx"
