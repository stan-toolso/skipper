#!/usr/bin/env bash
# Mise à jour « gracieuse » de Skipper dans une cellule. À lancer en tant que skipper :
#   ~/skipper/deploy/cellule/deploy.sh [--ref origin/main] [--max-wait 900] [--force]
# 1. récupère la référence et construit (le backend en cours n'est pas touché pendant le build) ;
# 2. si seul le front a changé : copie, aucun redémarrage ;
# 3. sinon : attend que plus aucun agent ne soit au travail (sessions busy = 0, délai --max-wait), redémarre le
#    service (quelques secondes), vérifie la santé, puis publie le front ; les sessions interrompues en plein tour
#    sont relancées automatiquement par le nouveau backend.
# Le vrai bleu/vert sans aucune interruption est suivi par la tâche e1803f30 (registre d'instances, drainage).
set -euo pipefail
[ "$(id -un)" = skipper ] || { echo "à lancer en tant que skipper" >&2; exit 2; }
REF="origin/main"; MAX_WAIT=900; FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --max-wait) MAX_WAIT="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "argument inconnu : $1" >&2; exit 2 ;;
  esac
done
step() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
APP=/home/skipper/skipper
cd "$APP"
. /etc/skipper/db.env

step "Récupération ($REF)"
git fetch -q origin
OLD="$(git rev-parse HEAD)"
NEW="$(git rev-parse "$REF")"
if [ "$OLD" = "$NEW" ] && [ "$FORCE" = 0 ]; then echo "déjà à jour ($OLD)"; exit 0; fi
git merge --ff-only -q "$NEW"
echo "$OLD → $NEW"
git --no-pager log --oneline "$OLD..$NEW" | head -20
CHANGED="$(git diff --name-only "$OLD" "$NEW")"
if [ "$FORCE" = 1 ]; then CHANGED=$'backend/\nfrontend/\npackage-lock.json'; fi
backend_changed=0; runner_changed=0
echo "$CHANGED" | grep -qE '^(backend/|package\.json|package-lock\.json|deploy/cellule/templates/env)' && backend_changed=1
echo "$CHANGED" | grep -q '^deploy/runner/' && runner_changed=1

step "Build"
echo "$CHANGED" | grep -q 'package-lock.json' && npm ci --no-audit --no-fund
NODE_OPTIONS=--max-old-space-size=2048 npm run build
[ "$runner_changed" = 1 ] && { echo "image du runner"; docker build -q -t skipper-runner:latest deploy/runner; }

if [ "$backend_changed" = 0 ]; then
  step "Front seulement : publication sans redémarrage"
  rsync -a --delete frontend/dist/ /var/www/skipper/
  echo "déployé $NEW (front)"; exit 0
fi

step "Attente de la fin des tours d'agents (au plus ${MAX_WAIT}s)"
busy() { psql "$DATABASE_URL" -tAc "SELECT count(*) FROM sessions WHERE status::text IN ('running','queued') AND activity::text = 'busy'"; }
waited=0
while [ "$(busy)" != "0" ] && [ "$waited" -lt "$MAX_WAIT" ]; do
  [ $((waited % 60)) = 0 ] && echo "$(busy) agent(s) au travail, attente… (${waited}s)"
  sleep 10; waited=$((waited + 10))
done
[ "$(busy)" = "0" ] || echo "délai dépassé : $(busy) agent(s) seront interrompus puis relancés automatiquement"

step "Redémarrage du backend"
sudo systemctl restart skipper
for i in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:4100/graphql?query=%7B__typename%7D"; then echo "backend prêt en ${i}s"; break; fi
  sleep 1
  if [ "$i" = 60 ]; then echo "le backend ne répond pas : sudo journalctl -u skipper -n 50" >&2; sudo journalctl -u skipper -n 30 --no-pager; exit 1; fi
done

step "Publication du front"
rsync -a --delete frontend/dist/ /var/www/skipper/
sudo journalctl -u skipper -n 20 --no-pager | grep -E 'migrations|GraphQL prêt|relancée' || true
echo "déployé $NEW"
