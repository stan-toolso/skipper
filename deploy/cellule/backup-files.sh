#!/usr/bin/env bash
# Sauvegarde restic des fichiers de la cellule (workspaces, clé maîtresse .secret-key, pièces jointes, .env) vers le
# même bucket Object Storage que pgBackRest. Installé en cron par ce script lui-même (--install) :
#   sudo ./backup-files.sh --install --s3-bucket <bucket> --s3-key <clé> --s3-secret <secret> [--s3-region fr-par]
#   sudo ./backup-files.sh            (une sauvegarde maintenant, avec la configuration de /etc/skipper/restic.env)
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "à lancer en root (sudo)" >&2; exit 2; }
# Paramètres S3 : arguments, sinon /etc/skipper/s3.env (S3_BUCKET, S3_KEY, S3_SECRET, S3_REGION), déposé par l'administrateur.
INSTALL=0; S3_REGION="fr-par"
[ -r /etc/skipper/s3.env ] && . /etc/skipper/s3.env
S3_BUCKET="${S3_BUCKET:-}"; S3_KEY="${S3_KEY:-}"; S3_SECRET="${S3_SECRET:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --install) INSTALL=1; shift ;;
    --s3-bucket) S3_BUCKET="$2"; shift 2 ;;
    --s3-key) S3_KEY="$2"; shift 2 ;;
    --s3-secret) S3_SECRET="$2"; shift 2 ;;
    --s3-region) S3_REGION="$2"; shift 2 ;;
    *) echo "argument inconnu : $1" >&2; exit 2 ;;
  esac
done
ENV=/etc/skipper/restic.env
if [ "$INSTALL" = 1 ]; then
  [ -n "$S3_BUCKET" ] && [ -n "$S3_KEY" ] && [ -n "$S3_SECRET" ] || { echo "--s3-bucket, --s3-key, --s3-secret obligatoires" >&2; exit 2; }
  PASS_FILE=/etc/skipper/restic-password
  [ -f "$PASS_FILE" ] || { umask 077; openssl rand -base64 48 > "$PASS_FILE"; umask 022; echo "ATTENTION : mot de passe du dépôt restic dans $PASS_FILE, à copier hors de la machine."; }
  umask 077
  cat > "$ENV" <<CONF
export RESTIC_REPOSITORY=s3:https://s3.${S3_REGION}.scw.cloud/${S3_BUCKET}/$(hostname)/files
export RESTIC_PASSWORD_FILE=$PASS_FILE
export AWS_ACCESS_KEY_ID=$S3_KEY
export AWS_SECRET_ACCESS_KEY=$S3_SECRET
CONF
  umask 022
  . "$ENV"
  restic snapshots >/dev/null 2>&1 || restic init
  cat > /etc/cron.d/restic-skipper <<CRON
30 3 * * * root $(readlink -f "$0") >> /var/log/restic-skipper.log 2>&1
CRON
  echo "restic configuré ($RESTIC_REPOSITORY), sauvegarde quotidienne à 3 h 30."
fi
[ -r "$ENV" ] || { echo "$ENV absent : lancer avec --install" >&2; exit 2; }
. "$ENV"
restic backup --quiet --exclude='**/node_modules' --exclude='**/.runners/*/claude-home/cache' \
  /home/skipper/skipper-workspaces /home/skipper/skipper/.env /etc/skipper /etc/pgbackrest/pgbackrest.conf
restic forget --quiet --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
restic snapshots --latest 1
