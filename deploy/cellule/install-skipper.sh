#!/usr/bin/env bash
# Installe (ou réinstalle) Skipper dans une cellule préparée par bootstrap.sh. À lancer en tant que skipper :
#   ./install-skipper.sh --domain skipper2.toolso.io --google-client-id ... --google-client-secret ... [--github-client-id ...] [--branch main]
# Clone le dépôt dans ~/skipper, écrit ~/.env s'il n'existe pas, installe les dépendances, construit, publie le front,
# construit l'image du runner, puis démarre le service (instance skipper@blue/green via deploy.sh si la cellule est en bleu/vert). Idempotent : relançable ; un .env existant n'est jamais écrasé.
set -euo pipefail
[ "$(id -un)" = skipper ] || { echo "à lancer en tant que skipper (sudo -iu skipper)" >&2; exit 2; }
DOMAIN=""; REPO="https://github.com/stan-toolso/skipper.git"; BRANCH="main"
GOOGLE_ID=""; GOOGLE_SECRET=""; GITHUB_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --google-client-id) GOOGLE_ID="$2"; shift 2 ;;
    --google-client-secret) GOOGLE_SECRET="$2"; shift 2 ;;
    --github-client-id) GITHUB_ID="$2"; shift 2 ;;
    *) echo "argument inconnu : $1" >&2; exit 2 ;;
  esac
done
step() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
APP=/home/skipper/skipper

step "Dépôt ($REPO, branche $BRANCH)"
if [ ! -d "$APP/.git" ]; then
  git clone --branch "$BRANCH" "$REPO" "$APP"
else
  git -C "$APP" fetch -q origin && git -C "$APP" checkout -q "$BRANCH" && git -C "$APP" pull -q --ff-only
fi
git -C "$APP" log --oneline -1

step "Configuration (.env)"
if [ ! -f "$APP/.env" ]; then
  [ -n "$DOMAIN" ] || { echo "--domain est obligatoire pour créer le .env" >&2; exit 2; }
  [ -r /etc/skipper/db.env ] || { echo "/etc/skipper/db.env absent : lancer d'abord sudo ./postgres.sh" >&2; exit 2; }
  . /etc/skipper/db.env
  umask 077
  sed -e "s|__DATABASE_URL__|$DATABASE_URL|" -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__GOOGLE_CLIENT_ID__|$GOOGLE_ID|" \
      -e "s|__GOOGLE_CLIENT_SECRET__|$GOOGLE_SECRET|" -e "s|__GITHUB_CLIENT_ID__|$GITHUB_ID|" "$APP/deploy/cellule/templates/env.example" > "$APP/.env"
  umask 022
  echo ".env créé"
else
  echo ".env existant conservé"
fi
if grep -q '^GOOGLE_CLIENT_ID=$' "$APP/.env" || grep -q '^GOOGLE_CLIENT_SECRET=$' "$APP/.env"; then
  echo "ATTENTION : GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET vides dans $APP/.env : la connexion des utilisateurs ne fonctionnera pas tant qu'ils ne sont pas renseignés (puis redéployer : deploy.sh --force)." >&2
fi

if [ -f /etc/nginx/skipper-upstream.conf ]; then
  # Cellule bleu/vert (bootstrap.sh récent) : deploy.sh construit dans le dossier d'une couleur, publie le front,
  # construit l'image du runner, démarre l'instance et y bascule nginx.
  step "Build, front, image du runner et démarrage (deploy.sh --force)"
  "$APP/deploy/cellule/deploy.sh" --force --ref HEAD
else
  step "Dépendances et build"
  cd "$APP"
  npm ci --no-audit --no-fund
  NODE_OPTIONS=--max-old-space-size=2048 npm run build

  step "Front publié dans /var/www/skipper"
  rsync -a --delete frontend/dist/ /var/www/skipper/

  step "Image Docker du runner (skipper-runner:latest)"
  docker build -q -t skipper-runner:latest deploy/runner

  step "Service (ancien mode, port 4100)"
  sudo systemctl restart skipper
  for i in $(seq 1 30); do
    if curl -fsS -o /dev/null "http://127.0.0.1:4100/graphql?query=%7B__typename%7D"; then echo "backend prêt"; break; fi
    sleep 1
    [ "$i" = 30 ] && { echo "le backend ne répond pas : sudo journalctl -u skipper -n 50" >&2; exit 1; }
  done
fi
echo
echo "Skipper installé. Le premier compte administrateur est créé par la migration 011 (stan@toolso.io) ; pour une migration de données, lancer migrate-from-ec2.sh."
