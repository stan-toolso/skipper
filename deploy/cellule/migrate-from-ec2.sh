#!/usr/bin/env bash
# Migre les données de l'ancienne installation (EC2 + RDS) vers cette cellule. À lancer en tant que skipper, sur la
# nouvelle machine, avec un accès SSH à l'ancienne (clé ou agent transmis) :
#   ~/skipper/deploy/cellule/migrate-from-ec2.sh --old skipper@skipper.toolso.io [--freeze] [--skip-db] [--skip-files]
# --freeze arrête le backend de l'ancienne machine avant la copie (pm2 stop skipper) pour une migration définitive ;
# sans lui, c'est une répétition : les données copiées sont celles de l'instant, l'ancienne continue de tourner.
# Copie : la base (pg_dump sur l'ancienne, pg_restore ici, la base locale est remplacée), les workspaces (dont
# .secret-key, les pièces jointes, les conversations des conteneurs), et les secrets Google/GitHub du .env.
set -euo pipefail
[ "$(id -un)" = skipper ] || { echo "à lancer en tant que skipper" >&2; exit 2; }
OLD=""; FREEZE=0; SKIP_DB=0; SKIP_FILES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --old) OLD="$2"; shift 2 ;;
    --freeze) FREEZE=1; shift ;;
    --skip-db) SKIP_DB=1; shift ;;
    --skip-files) SKIP_FILES=1; shift ;;
    *) echo "argument inconnu : $1" >&2; exit 2 ;;
  esac
done
[ -n "$OLD" ] || { echo "--old utilisateur@hôte est obligatoire" >&2; exit 2; }
step() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
APP=/home/skipper/skipper
. /etc/skipper/db.env
OLD_NVM='export NVM_DIR=$HOME/.nvm; . $NVM_DIR/nvm.sh >/dev/null 2>&1 || true'

step "Vérification de l'accès à $OLD"
ssh -o BatchMode=yes "$OLD" 'hostname && test -f ~/skipper/.env && echo ".env présent"'

if [ "$FREEZE" = 1 ]; then
  step "Arrêt du backend de l'ancienne machine (gel des données)"
  ssh "$OLD" "$OLD_NVM; pm2 stop skipper" || true
fi

step "Arrêt du backend local pendant la restauration"
sudo systemctl stop skipper

if [ "$SKIP_DB" = 0 ]; then
  step "Base : pg_dump sur l'ancienne machine → pg_restore ici"
  ssh "$OLD" 'command -v pg_dump >/dev/null || { echo "pg_dump absent sur l ancienne machine : sudo apt-get install -y postgresql-client" >&2; exit 1; }'
  DUMP=/tmp/skipper-migration.dump
  # Le mot de passe RDS ne quitte pas l'ancienne machine : pg_dump y lit DATABASE_URL depuis le .env.
  ssh "$OLD" 'set -o pipefail; URL=$(grep -E "^DATABASE_URL=" ~/skipper/.env | cut -d= -f2-); pg_dump --no-owner --no-acl -Fc "$URL"' > "$DUMP"
  ls -la "$DUMP"
  psql "$DATABASE_URL" -qc "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
  pg_restore --no-owner --no-acl --role=skipper -d "$DATABASE_URL" "$DUMP"
  rm -f "$DUMP"
  psql "$DATABASE_URL" -tAc "SELECT count(*) || ' sessions, ' || (SELECT count(*) FROM projects) || ' projets, ' || (SELECT count(*) FROM users) || ' utilisateurs' FROM sessions"
fi

if [ "$SKIP_FILES" = 0 ]; then
  step "Workspaces, clé maîtresse, pièces jointes (rsync)"
  rsync -aHAX --delete --stats --exclude='*/node_modules' --exclude='*.worktrees/*/node_modules' \
    "$OLD:/home/skipper/skipper-workspaces/" /home/skipper/skipper-workspaces/
  [ -f /home/skipper/skipper-workspaces/.secret-key ] && echo "clé maîtresse copiée" || echo "ATTENTION : .secret-key absente (SKIPPER_SECRET_KEY dans l'ancien .env ?)" >&2
  # Les node_modules des workspaces se réinstallent ; les conteneurs sont recréés au premier usage (chemins identiques).
fi

step "Secrets de l'ancien .env (Google, GitHub, clé maîtresse éventuelle)"
ssh "$OLD" 'grep -E "^(GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|GITHUB_CLIENT_ID|SKIPPER_SECRET_KEY|SKIPPER_SECRET_KEY_PREVIOUS)=" ~/skipper/.env' > /tmp/old-env.$$ || true
while IFS= read -r line; do
  key="${line%%=*}"
  if grep -q "^${key}=" "$APP/.env"; then
    sed -i "s|^${key}=.*|${line//|/\\|}|" "$APP/.env"
  else
    echo "$line" >> "$APP/.env"
  fi
done < /tmp/old-env.$$
rm -f /tmp/old-env.$$
chmod 600 "$APP/.env"

step "Redémarrage du backend local"
sudo systemctl start skipper
for i in $(seq 1 60); do curl -fsS -o /dev/null "http://127.0.0.1:4100/graphql?query=%7B__typename%7D" && { echo "backend prêt"; break; }; sleep 1; done
sudo journalctl -u skipper -n 20 --no-pager | grep -E 'migrations|GraphQL prêt|secret' || true
cat <<MSG

Migration terminée. Ensuite :
  - vérifier la connexion Google sur le nouveau domaine (URI de redirection à ajouter dans la console Google Cloud) ;
  - « Recréer » les conteneurs des projets si besoin (page du projet) ;
  - basculer le DNS de skipper.toolso.io, puis mettre APP_URL/API_URL/VITE_GRAPHQL_URL à jour dans .env et relancer deploy.sh --force.
MSG
