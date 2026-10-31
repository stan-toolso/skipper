#!/usr/bin/env bash
# Prépare une cellule au déploiement bleu/vert (mises à jour sans interruption). À lancer en root ; idempotent.
# Appelé par bootstrap.sh ; à lancer une fois à la main sur une cellule installée avant (skipper-1) :
#   sudo /root/skipper-install/deploy/cellule/bluegreen-setup.sh
# Installe l'unité systemd skipper@.service (instances blue : 4101, green : 4102), le fichier d'upstream nginx commuté
# par deploy.sh (/etc/nginx/skipper-upstream.conf, modifiable par skipper), l'inclut dans le site nginx et donne à
# skipper les droits sudo dont deploy.sh a besoin. Ne démarre ni n'arrête rien : sur une cellule qui tourne encore avec
# l'ancien service `skipper` (port 4100), l'upstream reste sur 4100 et le prochain deploy.sh fait la transition.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "à lancer en root (sudo)" >&2; exit 2; }
T="$(cd "$(dirname "$0")" && pwd)/templates"
step() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }

step "Unité systemd skipper@ (blue 4101, green 4102)"
install -m 0644 "$T/skipper@.service" /etc/systemd/system/skipper@.service
mkdir -p /etc/skipper
printf 'PORT=4101\n' > /etc/skipper/instance-blue.env
printf 'PORT=4102\n' > /etc/skipper/instance-green.env
chmod 644 /etc/skipper/instance-blue.env /etc/skipper/instance-green.env
systemctl daemon-reload

step "Upstream nginx commuté par deploy.sh"
UP=/etc/nginx/skipper-upstream.conf
if [ ! -f "$UP" ]; then
  # Cellule existante : le trafic reste sur l'ancien service tant que deploy.sh n'a pas fait la transition.
  if systemctl is-active -q skipper 2>/dev/null; then port=4100; else port=4101; fi
  printf '# Instance active du backend, réécrit par deploy/cellule/deploy.sh (4101 : blue, 4102 : green).\nserver 127.0.0.1:%s;\n' "$port" > "$UP"
fi
id skipper >/dev/null 2>&1 && chown skipper:skipper "$UP"
chmod 644 "$UP"
SITE=/etc/nginx/sites-available/skipper
if [ -f "$SITE" ] && ! grep -q skipper-upstream.conf "$SITE"; then
  cp "$SITE" "$SITE.bak-$(date +%Y%m%d%H%M%S)"
  perl -0pi -e 's~upstream skipper_backend \{.*?\}~upstream skipper_backend {\n    include /etc/nginx/skipper-upstream.conf;\n    keepalive 32;\n}~s' "$SITE"
  echo "site nginx : bloc upstream remplacé par l'include (copie de l'ancien à côté)"
fi
nginx -t && systemctl reload nginx

step "sudo restreint pour deploy.sh"
cat > /etc/sudoers.d/skipper <<'SUDO'
# Ce dont deploy.sh a besoin, et rien d'autre (instances skipper@blue et skipper@green, ancien service skipper).
Cmnd_Alias SKIPPER_UNITS = /usr/bin/systemctl start skipper@blue, /usr/bin/systemctl start skipper@green, \
  /usr/bin/systemctl stop skipper@blue, /usr/bin/systemctl stop skipper@green, \
  /usr/bin/systemctl restart skipper@blue, /usr/bin/systemctl restart skipper@green, \
  /usr/bin/systemctl enable skipper@blue, /usr/bin/systemctl enable skipper@green, \
  /usr/bin/systemctl disable skipper@blue, /usr/bin/systemctl disable skipper@green, \
  /usr/bin/systemctl status skipper@blue, /usr/bin/systemctl status skipper@green, \
  /usr/bin/journalctl -u skipper@blue *, /usr/bin/journalctl -u skipper@green *
Cmnd_Alias SKIPPER_LEGACY = /usr/bin/systemctl restart skipper, /usr/bin/systemctl start skipper, /usr/bin/systemctl stop skipper, \
  /usr/bin/systemctl disable skipper, /usr/bin/systemctl status skipper, /usr/bin/journalctl -u skipper *
skipper ALL=(root) NOPASSWD: SKIPPER_UNITS, SKIPPER_LEGACY, /usr/bin/systemctl reload nginx, /usr/sbin/nginx -t
SUDO
chmod 440 /etc/sudoers.d/skipper && visudo -cf /etc/sudoers.d/skipper
echo "prêt : le prochain « deploy.sh » (en skipper) bascule en bleu/vert"
