#!/usr/bin/env bash
# Prépare une machine neuve (Ubuntu 24.04, Elastic Metal Scaleway) pour une cellule Skipper. À lancer en root, une fois :
#   sudo ./bootstrap.sh --domain skipper2.toolso.io [--hostname skipper-1] [--skip-certbot]
# Idempotent : relançable sans dégât. Installe Node 22, Docker, PostgreSQL 17 + pgBackRest, nginx + certbot, pare-feu,
# fail2ban, mises à jour automatiques, l'utilisateur `skipper`, le service systemd et le site nginx.
# Ne touche pas aux données : la base est créée par postgres.sh, Skipper par install-skipper.sh (en tant que skipper).
set -euo pipefail

DOMAIN=""
HOSTNAME_WANTED=""
SKIP_CERTBOT=0
CERTBOT_EMAIL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --hostname) HOSTNAME_WANTED="$2"; shift 2 ;;
    --certbot-email) CERTBOT_EMAIL="$2"; shift 2 ;;
    --skip-certbot) SKIP_CERTBOT=1; shift ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "argument inconnu : $1" >&2; exit 2 ;;
  esac
done
[ -n "$DOMAIN" ] || { echo "--domain est obligatoire (ex. skipper2.toolso.io)" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "à lancer en root (sudo)" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$HERE/templates"
export DEBIAN_FRONTEND=noninteractive

step() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }

step "Système : nom, fuseau, paquets de base"
[ -z "$HOSTNAME_WANTED" ] || hostnamectl set-hostname "$HOSTNAME_WANTED"
timedatectl set-timezone Europe/Paris || true
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git jq rsync htop ncdu ufw fail2ban unattended-upgrades apt-listchanges \
  build-essential python3 make g++ restic age mdadm smartmontools

step "Mises à jour de sécurité automatiques (sans redémarrage automatique)"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
sed -i 's|^//\?Unattended-Upgrade::Automatic-Reboot .*|Unattended-Upgrade::Automatic-Reboot "false";|' /etc/apt/apt.conf.d/50unattended-upgrades

step "Noyau : inotify (watchers de Vite et tsc), swappiness"
cat > /etc/sysctl.d/90-skipper.conf <<'CONF'
fs.inotify.max_user_watches = 1048576
fs.inotify.max_user_instances = 1024
vm.swappiness = 10
net.core.somaxconn = 1024
CONF
sysctl -q --system

step "Swap de secours (4 Go) si absent"
if ! swapon --show | grep -q .; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

step "Node.js 22 (NodeSource)"
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
node -v

step "Docker (dépôt officiel) et durcissement du démon"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
install -m 0644 "$T/docker-daemon.json" /etc/docker/daemon.json
systemctl enable --now docker
systemctl restart docker

step "PostgreSQL 17 et pgBackRest (dépôt PGDG)"
if ! command -v psql >/dev/null || ! psql --version | grep -q ' 17\.'; then
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -q
  apt-get install -y -q postgresql-17 postgresql-client-17 pgbackrest
fi
systemctl enable --now postgresql

step "nginx et certbot"
apt-get install -y -q nginx certbot python3-certbot-nginx
install -m 0644 "$T/nginx-upgrade.conf" /etc/nginx/conf.d/upgrade.conf
sed "s/__DOMAIN__/$DOMAIN/g" "$T/nginx-site.conf" > /etc/nginx/sites-available/skipper
ln -sf /etc/nginx/sites-available/skipper /etc/nginx/sites-enabled/skipper
rm -f /etc/nginx/sites-enabled/default
mkdir -p /var/www/skipper
nginx -t && systemctl enable --now nginx && systemctl reload nginx

step "Utilisateur skipper (docker, sudo restreint) et dossiers"
id skipper >/dev/null 2>&1 || adduser --disabled-password --gecos "Skipper" skipper
usermod -aG docker skipper
mkdir -p /home/skipper/.ssh && chmod 700 /home/skipper/.ssh
# Les clés installées par Scaleway (sur root, ou sur l'utilisateur `ubuntu` des images Ubuntu) ouvrent aussi le compte skipper.
touch /home/skipper/.ssh/authorized_keys
for src in /root/.ssh/authorized_keys /home/ubuntu/.ssh/authorized_keys; do
  [ -f "$src" ] || continue
  while read -r k; do [ -n "$k" ] && ! grep -qxF "$k" /home/skipper/.ssh/authorized_keys && echo "$k" >> /home/skipper/.ssh/authorized_keys; done < "$src"
done
chmod 600 /home/skipper/.ssh/authorized_keys
mkdir -p /home/skipper/skipper-workspaces /etc/skipper
chown -R skipper:skipper /home/skipper /var/www/skipper
chmod 750 /home/skipper
cat > /etc/sudoers.d/skipper <<'SUDO'
# Ce dont deploy.sh a besoin, et rien d'autre.
skipper ALL=(root) NOPASSWD: /usr/bin/systemctl restart skipper, /usr/bin/systemctl start skipper, /usr/bin/systemctl stop skipper, /usr/bin/systemctl status skipper, /usr/bin/systemctl reload nginx, /usr/sbin/nginx -t, /usr/bin/journalctl -u skipper *
SUDO
chmod 440 /etc/sudoers.d/skipper && visudo -cf /etc/sudoers.d/skipper

step "Service systemd skipper (activé, démarré par install-skipper.sh)"
install -m 0644 "$T/skipper.service" /etc/systemd/system/skipper.service
systemctl daemon-reload
systemctl enable skipper

step "SSH : clés seulement, pas de root par mot de passe"
cat > /etc/ssh/sshd_config.d/90-skipper.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
X11Forwarding no
CONF
sshd -t && systemctl reload ssh

step "Pare-feu (22, 80, 443) et fail2ban"
ufw --force default deny incoming
ufw --force default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
cat > /etc/fail2ban/jail.d/skipper.local <<'CONF'
[sshd]
enabled = true
maxretry = 5
bantime = 1h
CONF
systemctl enable --now fail2ban && systemctl restart fail2ban

if [ "$SKIP_CERTBOT" = 0 ]; then
  step "Certificat TLS Let's Encrypt pour $DOMAIN"
  if [ -n "$CERTBOT_EMAIL" ]; then CERTBOT_ARGS=(-m "$CERTBOT_EMAIL"); else CERTBOT_ARGS=(--register-unsafely-without-email); fi
  if certbot --nginx -n --agree-tos --redirect "${CERTBOT_ARGS[@]}" -d "$DOMAIN"; then
    systemctl reload nginx
  else
    echo "certbot a échoué (le DNS de $DOMAIN pointe-t-il déjà ici ?) : relancer plus tard « certbot --nginx -d $DOMAIN »" >&2
  fi
fi

step "Terminé"
cat <<MSG
Machine prête. Étapes suivantes :
  1. sudo ./postgres.sh --s3-bucket <bucket> --s3-key <clé> --s3-secret <secret>   (base, rôle, sauvegardes)
  2. sudo -iu skipper, puis ~/skipper/deploy/cellule/install-skipper.sh --domain $DOMAIN ...   (clone, .env, build, image du runner, démarrage)
  3. Pour une migration : ~/skipper/deploy/cellule/migrate-from-ec2.sh (voir README.md)
MSG
