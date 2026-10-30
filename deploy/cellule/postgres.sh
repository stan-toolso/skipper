#!/usr/bin/env bash
# Base PostgreSQL de la cellule : rôle et base `skipper`, réglages, sauvegardes pgBackRest vers un bucket Object Storage.
#   sudo ./postgres.sh [--s3-bucket skipper-sauvegardes --s3-key SCW... --s3-secret ... --s3-region fr-par]
# Les paramètres S3 peuvent aussi venir de /etc/skipper/s3.env (S3_BUCKET=… S3_KEY=… S3_SECRET=…, mode 600), ce qui évite
# de les passer sur une ligne de commande. Sans eux, la base est créée mais l'archivage WAL reste désactivé.
# Écrit DATABASE_URL dans /etc/skipper/db.env (lisible par skipper seulement) pour install-skipper.sh.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "à lancer en root (sudo)" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$HERE/templates"
# Paramètres S3 : arguments, sinon /etc/skipper/s3.env (S3_BUCKET, S3_KEY, S3_SECRET, S3_REGION), déposé par l'administrateur.
S3_REGION="fr-par"
[ -r /etc/skipper/s3.env ] && . /etc/skipper/s3.env
S3_BUCKET="${S3_BUCKET:-}"; S3_KEY="${S3_KEY:-}"; S3_SECRET="${S3_SECRET:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --s3-bucket) S3_BUCKET="$2"; shift 2 ;;
    --s3-key) S3_KEY="$2"; shift 2 ;;
    --s3-secret) S3_SECRET="$2"; shift 2 ;;
    --s3-region) S3_REGION="$2"; shift 2 ;;
    *) echo "argument inconnu : $1" >&2; exit 2 ;;
  esac
done
step() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
PGCONF_DIR=/etc/postgresql/17/main/conf.d
mkdir -p /etc/skipper

step "Rôle et base skipper"
if [ -f /etc/skipper/db.env ]; then
  . /etc/skipper/db.env
  PASSWORD="$(printf '%s' "$DATABASE_URL" | sed -E 's|^postgres://[^:]+:([^@]+)@.*$|\1|')"
  echo "mot de passe existant conservé (/etc/skipper/db.env)"
else
  PASSWORD="$(openssl rand -base64 36 | tr -d '/+=' | cut -c1-32)"
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='skipper'" | grep -q 1; then
  sudo -u postgres psql -qc "CREATE ROLE skipper LOGIN PASSWORD '$PASSWORD';"
else
  sudo -u postgres psql -qc "ALTER ROLE skipper WITH PASSWORD '$PASSWORD';"
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='skipper'" | grep -q 1; then
  sudo -u postgres createdb -O skipper --encoding=UTF8 --locale=C.UTF-8 --template=template0 skipper
fi
umask 077
echo "DATABASE_URL=postgres://skipper:${PASSWORD}@127.0.0.1:5432/skipper" > /etc/skipper/db.env
chown skipper:skipper /etc/skipper/db.env
umask 022

step "Réglages PostgreSQL"
mkdir -p "$PGCONF_DIR"
if [ -n "$S3_BUCKET" ]; then
  ARCHIVE=$'wal_level = replica\narchive_mode = on\narchive_command = \'pgbackrest --stanza=skipper archive-push %p\'\narchive_timeout = 300'
else
  ARCHIVE="# archive_mode = off (pgBackRest non configuré : relancer postgres.sh avec --s3-bucket …)"
fi
awk -v archive="$ARCHIVE" '{ if ($0 == "__ARCHIVE__") print archive; else print }' "$T/postgresql-skipper.conf" > "$PGCONF_DIR/skipper.conf"
chown postgres:postgres "$PGCONF_DIR/skipper.conf"

if [ -n "$S3_BUCKET" ]; then
  step "pgBackRest vers s3://$S3_BUCKET ($S3_REGION)"
  [ -n "$S3_KEY" ] && [ -n "$S3_SECRET" ] || { echo "--s3-key et --s3-secret sont obligatoires avec --s3-bucket" >&2; exit 2; }
  CIPHER_FILE=/etc/skipper/pgbackrest-cipher
  if [ ! -f "$CIPHER_FILE" ]; then
    umask 077; openssl rand -base64 48 > "$CIPHER_FILE"; umask 022
    echo "ATTENTION : la phrase de chiffrement des sauvegardes est dans $CIPHER_FILE. La copier hors de la machine (gestionnaire de mots de passe) : sans elle, les sauvegardes sont illisibles."
  fi
  CIPHER="$(cat "$CIPHER_FILE")"
  umask 077
  sed -e "s|__S3_REGION__|$S3_REGION|g" -e "s|__S3_BUCKET__|$S3_BUCKET|g" -e "s|__S3_KEY__|$S3_KEY|g" -e "s|__S3_SECRET__|$S3_SECRET|g" \
      -e "s|__HOSTNAME__|$(hostname)|g" -e "s|__CIPHER_PASS__|$CIPHER|g" "$T/pgbackrest.conf" > /etc/pgbackrest/pgbackrest.conf
  umask 022
  chown postgres:postgres /etc/pgbackrest/pgbackrest.conf && chmod 600 /etc/pgbackrest/pgbackrest.conf
  mkdir -p /var/log/pgbackrest && chown postgres:postgres /var/log/pgbackrest
  systemctl restart postgresql
  sudo -u postgres pgbackrest --stanza=skipper stanza-create
  sudo -u postgres pgbackrest --stanza=skipper check
  # Complète le dimanche à 3 h, différentielle les autres jours ; expiration selon la rétention du fichier de configuration.
  cat > /etc/cron.d/pgbackrest-skipper <<'CRON'
0 3 * * 0 postgres pgbackrest --stanza=skipper --type=full backup >> /var/log/pgbackrest/cron.log 2>&1
0 3 * * 1-6 postgres pgbackrest --stanza=skipper --type=diff backup >> /var/log/pgbackrest/cron.log 2>&1
CRON
  sudo -u postgres pgbackrest --stanza=skipper --type=full backup
  sudo -u postgres pgbackrest info
else
  systemctl restart postgresql
fi

step "Terminé"
sudo -u postgres psql -tAc "SELECT version()"
echo "DATABASE_URL écrite dans /etc/skipper/db.env (pour install-skipper.sh)."
