# Mise en production — skipper.toolso.io

Skipper tourne sur **le même serveur que Curso** (EC2 `13.36.242.35`, Ubuntu 24.04 arm64,
2 vCPU / 1,8 Go + 2 Go de swap), mais sous un **utilisateur Linux dédié `skipper`**. Il n'y a
pas de CI/CD : le déploiement est manuel (tirer `main`, builder, redémarrer).

## Accès

- **SSH** : `ssh skipper@skipper.toolso.io` (clé `~/.ssh/id_rsa` du poste, ou la clé EC2
  `app-paris.pem`). `skipper` est sudoer sans mot de passe.
- **Web** : https://skipper.toolso.io, protégé par une **authentification HTTP basic** nginx
  (`/etc/nginx/.htpasswd-skipper`, identifiants dans `/home/skipper/.skipper-credentials`).
  Cette protection est indispensable : l'application ouvre des terminaux sur le serveur.
  Ajouter un utilisateur : `sudo htpasswd /etc/nginx/.htpasswd-skipper <nom>`.
- **Base** : PostgreSQL 14 sur l'instance RDS `toolso-campaign-manager` (compte AWS Toolso
  Emailing, `eu-west-1`), base `skipper`, rôle `skipper`. Connexion en TLS vérifié
  (`sslmode=verify-full`, bundle CA `~/rds-eu-west-1-bundle.pem`). Le mot de passe est dans
  `~/skipper/.env` et nulle part ailleurs.
- **DNS** : enregistrement A `skipper.toolso.io` dans la zone Route 53 de toolso.io (profil
  AWS local `claude-toolso`).

## Disposition sur le serveur

| Élément            | Emplacement                                                     |
| ------------------ | --------------------------------------------------------------- |
| Clone du dépôt     | `/home/skipper/skipper` (branche `main`, alias ssh `github-skipper`, clé de déploiement lecture seule `~/.ssh/skipper-deploy`) |
| Configuration      | `/home/skipper/skipper/.env` (jamais versionné)                 |
| Workspaces projets | `/home/skipper/skipper-workspaces`                              |
| Front publié       | `/var/www/skipper` (copie de `frontend/dist/`)                  |
| Backend            | processus pm2 `skipper` (`node --env-file=../.env dist/index.js` depuis `backend/`), port **4100** |
| Redémarrage au boot| service systemd `pm2-skipper`                                   |
| nginx              | `/etc/nginx/sites-available/skipper` (copie : `deploy/nginx-skipper.conf`), TLS Let's Encrypt via certbot (renouvellement automatique) |
| Node               | nvm de l'utilisateur `skipper` (Node 22), pm2 global            |
| Claude Code CLI    | `~/.local/bin/claude` (pour se connecter : `claude` puis `/login`) |

Le port 4000 est celui de l'API Curso : Skipper est sur 4100. Le `.env` fixe aussi
`SHELL=/bin/bash` (les terminaux web utilisent zsh par défaut, absent du serveur) et
`VITE_GRAPHQL_URL=https://skipper.toolso.io/graphql` (lu par Vite au build).

## Authentification Claude

Le backend lance Claude Code via le Claude Agent SDK, avec les identifiants de l'utilisateur
`skipper` : soit une connexion Claude Code (`ssh skipper@skipper.toolso.io`, puis `claude` et
`/login`, une seule fois), soit `ANTHROPIC_API_KEY=...` dans `~/skipper/.env` suivi d'un
`pm2 restart skipper --update-env`. Sans l'un des deux, les sessions d'agents échouent.

## Procédure de déploiement

```bash
# 1. Depuis le poste
git push origin main

# 2. Sur le serveur
ssh skipper@skipper.toolso.io
export NVM_DIR=$HOME/.nvm; . $NVM_DIR/nvm.sh   # node/pm2 ne sont pas dans le PATH d'un ssh non interactif
cd ~/skipper && git pull --ff-only
npm ci --no-audit --no-fund                    # seulement si package-lock.json a changé
npm run build                                  # backend (dist/ + schema + migrations SQL) et frontend
cp -rf frontend/dist/. /var/www/skipper/
pm2 restart skipper --update-env
```

Les migrations SQL sont appliquées automatiquement au démarrage du backend.

## Vérifications

```bash
pm2 list                                     # skipper « online », uptime remis à zéro
pm2 logs skipper --nostream --lines 20       # « [http] GraphQL prêt sur http://localhost:4100/graphql »
curl -s -u stan -X POST https://skipper.toolso.io/graphql \
  -H 'content-type: application/json' -d '{"query":"{ providers { type label } }"}'
curl -s -u stan https://skipper.toolso.io/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

## Bon à savoir

- **Mémoire** : le serveur n'a que 1,8 Go de RAM, partagés avec l'API et le job Curso. Chaque
  session Claude lance un processus Claude Code (quelques centaines de Mo) : limiter le nombre de
  sessions simultanées, et surveiller `free -h` / `pm2 list`. Un swap de 2 Go (`/swapfile`)
  amortit les pics.
- **Ne jamais lire ni copier le `.env` du serveur** dans une conversation ou un dépôt.
- **Retirer l'accès** : `sudo deluser skipper` ne suffit pas, penser au rôle RDS, à la clé de
  déploiement GitHub et au fichier `.htpasswd-skipper`.
