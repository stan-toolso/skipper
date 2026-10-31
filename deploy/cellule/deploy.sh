#!/usr/bin/env bash
# Mise à jour de Skipper dans une cellule, sans interruption (bleu/vert). À lancer en tant que skipper :
#   ~/skipper/deploy/cellule/deploy.sh [--ref origin/main] [--max-wait 900] [--force]
# Deux instances du backend, skipper@blue (port 4101) et skipper@green (4102), chacune dans son dossier
# /home/skipper/skipper-<couleur> (worktree du clone ~/skipper). nginx envoie le trafic à l'instance active
# (/etc/nginx/skipper-upstream.conf). Une mise à jour :
# 1. récupère la référence, la construit dans le dossier de l'autre couleur (l'instance active n'est pas touchée) ;
# 2. si seul le front a changé : le publie, rien d'autre ;
# 3. sinon : démarre la nouvelle instance, vérifie sa santé (échec : elle est arrêtée, rien n'a changé pour les
#    utilisateurs), bascule nginx dessus, publie le front, puis envoie SIGUSR2 à l'ancienne : elle finit les tours en
#    cours, gare les sessions (reprises par la nouvelle à leur prochaine instruction), cède les planificateurs et sort
#    d'elle-même. Les instructions, interruptions et réponses aux demandes de ses sessions lui sont transmises par la
#    nouvelle ; l'interface voit ce qu'elle fait (bus PostgreSQL). Voir la tâche e1803f30 et backend/src/instances/.
# Cellule pas encore préparée (pas de /etc/nginx/skipper-upstream.conf : lancer bluegreen-setup.sh en root) : ancien
# mode, attente de la fin des tours puis redémarrage du service `skipper` (quelques secondes d'interruption).
# Transition depuis l'ancien service (upstream sur 4100) : même attente, arrêt de `skipper`, puis démarrage de blue.
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
UPSTREAM=/etc/nginx/skipper-upstream.conf
cd "$APP"
. /etc/skipper/db.env

busy() { psql "$DATABASE_URL" -tAc "SELECT count(*) FROM sessions WHERE status::text IN ('running','queued') AND activity::text = 'busy'"; }
wait_idle() {
  local waited=0
  while [ "$(busy)" != "0" ] && [ "$waited" -lt "$MAX_WAIT" ]; do
    [ $((waited % 60)) = 0 ] && echo "$(busy) agent(s) au travail, attente… (${waited}s)"
    sleep 10; waited=$((waited + 10))
  done
  [ "$(busy)" = "0" ] || echo "délai dépassé : $(busy) agent(s) seront interrompus puis relancés automatiquement"
}
healthy() { curl -fsS -o /dev/null "http://127.0.0.1:$1/graphql?query=%7B__typename%7D"; }
wait_healthy() {
  local port="$1" unit="$2"
  for i in $(seq 1 90); do
    if healthy "$port"; then echo "backend prêt sur $port en ${i}s"; return 0; fi
    sleep 1
  done
  echo "le backend ne répond pas sur $port : sudo journalctl -u $unit -n 50" >&2
  sudo journalctl -u "$unit" -n 30 --no-pager || true
  return 1
}
# Fichiers changés entre deux révisions → ce qu'il faut refaire.
classify() {
  backend_changed=0; runner_changed=0; deps_changed=0
  if [ "$FORCE" = 1 ] || [ -z "$1" ]; then backend_changed=1; deps_changed=1; runner_changed=$([ "$FORCE" = 1 ] && echo 1 || echo 0); return; fi
  local changed; changed="$(git -C "$APP" diff --name-only "$1" "$2")"
  echo "$changed" | grep -qE '^(backend/|package\.json|package-lock\.json|deploy/cellule/templates/env)' && backend_changed=1
  echo "$changed" | grep -qE '^(package\.json|package-lock\.json|backend/package\.json|frontend/package\.json)' && deps_changed=1
  echo "$changed" | grep -q '^deploy/runner/' && runner_changed=1
  return 0
}

step "Récupération ($REF)"
git fetch -q origin
NEW="$(git rev-parse "$REF")"

# ---------------------------------------------------------------------------------------------------------------------
# Ancien mode : une seule instance (service `skipper`, port 4100), redémarrée après la fin des tours.
# ---------------------------------------------------------------------------------------------------------------------
if [ ! -f "$UPSTREAM" ]; then
  OLD="$(git rev-parse HEAD)"
  if [ "$OLD" = "$NEW" ] && [ "$FORCE" = 0 ]; then echo "déjà à jour ($OLD)"; exit 0; fi
  git merge --ff-only -q "$NEW"
  echo "$OLD → $NEW"
  git --no-pager log --oneline "$OLD..$NEW" | head -20
  classify "$OLD" "$NEW"
  step "Build"
  [ "$deps_changed" = 1 ] && npm ci --no-audit --no-fund
  NODE_OPTIONS=--max-old-space-size=2048 npm run build
  [ "$runner_changed" = 1 ] && { echo "image du runner"; docker build -q -t skipper-runner:latest deploy/runner; }
  if [ "$backend_changed" = 0 ]; then
    step "Front seulement : publication sans redémarrage"
    rsync -a --delete frontend/dist/ /var/www/skipper/
    echo "déployé $NEW (front)"; exit 0
  fi
  step "Attente de la fin des tours d'agents (au plus ${MAX_WAIT}s)"
  wait_idle
  step "Redémarrage du backend"
  sudo systemctl restart skipper
  wait_healthy 4100 skipper || exit 1
  step "Publication du front"
  rsync -a --delete frontend/dist/ /var/www/skipper/
  echo "déployé $NEW (ancien mode : lancer bluegreen-setup.sh en root pour les mises à jour sans interruption)"
  exit 0
fi

# ---------------------------------------------------------------------------------------------------------------------
# Bleu/vert
# ---------------------------------------------------------------------------------------------------------------------
port_of() { case "$1" in blue) echo 4101 ;; green) echo 4102 ;; legacy) echo 4100 ;; esac; }
ACTIVE_PORT="$(grep -oE '127\.0\.0\.1:[0-9]+' "$UPSTREAM" | head -1 | cut -d: -f2)"
case "$ACTIVE_PORT" in
  4101) ACTIVE=blue; TARGET=green ;;
  4102) ACTIVE=green; TARGET=blue ;;
  *) ACTIVE=legacy; TARGET=blue ;;
esac
TPORT="$(port_of "$TARGET")"
TDIR="/home/skipper/skipper-$TARGET"
ADIR="/home/skipper/skipper-$ACTIVE"
if [ "$ACTIVE" = legacy ]; then ACTIVE_REV="$(git rev-parse HEAD)"; else ACTIVE_REV="$(git -C "$ADIR" rev-parse HEAD 2>/dev/null || true)"; fi
echo "instance active : $ACTIVE (port $ACTIVE_PORT, $(git rev-parse --short "${ACTIVE_REV:-HEAD}"))  →  nouvelle : $TARGET (port $TPORT, $(git rev-parse --short "$NEW"))"
if [ "$ACTIVE_REV" = "$NEW" ] && [ "$FORCE" = 0 ]; then echo "déjà à jour ($NEW)"; exit 0; fi
[ -n "$ACTIVE_REV" ] && git --no-pager log --oneline "$ACTIVE_REV..$NEW" | head -20
# Le clone suit la référence déployée (scripts, lecture du code) ; il ne fait plus tourner de backend (l'ancien service,
# jusqu'à la transition, tourne sur son dist/, que seul un build dans le clone toucherait).
git merge --ff-only -q "$NEW" 2>/dev/null || git checkout -q --detach "$NEW"

# L'autre couleur peut encore se vider après la mise à jour précédente : son dossier ne se remplace qu'une fois sortie.
if systemctl is-active -q "skipper@$TARGET"; then
  step "skipper@$TARGET se vide encore après la mise à jour précédente (au plus ${MAX_WAIT}s)"
  waited=0
  while systemctl is-active -q "skipper@$TARGET" && [ "$waited" -lt "$MAX_WAIT" ]; do
    [ $((waited % 60)) = 0 ] && echo "attente de la sortie de skipper@$TARGET… (${waited}s)"
    sleep 5; waited=$((waited + 5))
  done
  if systemctl is-active -q "skipper@$TARGET"; then
    [ "$FORCE" = 1 ] || { echo "skipper@$TARGET tourne toujours : relancer plus tard, ou avec --force (ses sessions au travail seront interrompues puis relancées)" >&2; exit 1; }
    sudo systemctl stop "skipper@$TARGET"
  fi
fi

step "Dossier $TDIR ($NEW)"
PREV_TREV=""
if [ -d "$TDIR/.git" ] || [ -f "$TDIR/.git" ]; then
  PREV_TREV="$(git -C "$TDIR" rev-parse HEAD)"
  git -C "$TDIR" checkout -q -f --detach "$NEW"
else
  git worktree add -q --detach "$TDIR" "$NEW"
fi
ln -sfn "$APP/.env" "$TDIR/.env"   # lu par Vite (VITE_GRAPHQL_URL) ; le backend lit le .env du clone (unité systemd)
classify "$ACTIVE_REV" "$NEW"
# Dépendances du dossier : installées s'il n'en a pas, ou si le lockfile a changé depuis sa dernière installation.
deps_changed=$FORCE
if [ ! -d "$TDIR/node_modules" ] || [ -z "$PREV_TREV" ] || ! git -C "$APP" diff --quiet "$PREV_TREV" "$NEW" -- package-lock.json; then deps_changed=1; fi

step "Build ($TARGET)"
cd "$TDIR"
[ "$deps_changed" = 1 ] && npm ci --no-audit --no-fund
NODE_OPTIONS=--max-old-space-size=2048 npm run build
[ "$runner_changed" = 1 ] && { echo "image du runner"; docker build -q -t skipper-runner:latest deploy/runner; }

if [ "$backend_changed" = 0 ] && [ "$ACTIVE" != legacy ]; then
  step "Front seulement : publication, l'instance $ACTIVE reste en place"
  rsync -a --delete frontend/dist/ /var/www/skipper/
  # Le dossier actif passe à la nouvelle révision (rien n'est rechargé) : la prochaine comparaison part d'ici.
  git -C "$ADIR" checkout -q -f --detach "$NEW"
  echo "déployé $NEW (front)"; exit 0
fi

if [ "$ACTIVE" = legacy ]; then
  # Transition depuis l'ancien service, qui ne sait pas se vider : la nouvelle instance prendrait ses sessions pour
  # orphelines. Dernier redémarrage avec interruption : attente des agents, arrêt de `skipper`, démarrage de blue.
  step "Transition depuis l'ancien service skipper : attente de la fin des tours (au plus ${MAX_WAIT}s)"
  wait_idle
  sudo systemctl stop skipper
  sudo systemctl disable skipper
fi

step "Démarrage de skipper@$TARGET (port $TPORT)"
sudo systemctl start "skipper@$TARGET"
if ! wait_healthy "$TPORT" "skipper@$TARGET"; then
  sudo systemctl stop "skipper@$TARGET"
  if [ "$ACTIVE" = legacy ]; then sudo systemctl start skipper; echo "ancien service relancé" >&2; fi
  echo "échec : nginx n'a pas été basculé, l'instance $ACTIVE sert toujours" >&2
  exit 1
fi

step "Bascule de nginx vers $TARGET"
printf '# Instance active du backend, réécrit par deploy/cellule/deploy.sh (4101 : blue, 4102 : green).\nserver 127.0.0.1:%s;\n' "$TPORT" > "$UPSTREAM.new"
cp "$UPSTREAM" "$UPSTREAM.prev"
cat "$UPSTREAM.new" > "$UPSTREAM" && rm -f "$UPSTREAM.new"
if ! sudo nginx -t 2>/dev/null; then
  cat "$UPSTREAM.prev" > "$UPSTREAM"
  sudo systemctl stop "skipper@$TARGET"
  echo "configuration nginx invalide : bascule annulée" >&2; exit 1
fi
sudo systemctl reload nginx
sudo systemctl enable "skipper@$TARGET" 2>/dev/null

step "Publication du front"
rsync -a --delete frontend/dist/ /var/www/skipper/

if [ "$ACTIVE" != legacy ] && systemctl is-active -q "skipper@$ACTIVE"; then
  step "Drainage de skipper@$ACTIVE"
  sudo systemctl disable "skipper@$ACTIVE" 2>/dev/null
  kill -USR2 "$(systemctl show -p MainPID --value "skipper@$ACTIVE")"
  echo "SIGUSR2 envoyé : skipper@$ACTIVE finit ses tours et sort d'elle-même (suivi : sudo journalctl -u skipper@$ACTIVE -f)"
fi
sudo journalctl -u "skipper@$TARGET" -n 30 --no-pager | grep -E 'migrations|GraphQL prêt|instances|relancée' || true
echo "déployé $NEW sur $TARGET"
