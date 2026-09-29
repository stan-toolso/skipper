# Mise en production — skipper.toolso.io

Skipper tourne sur **le même serveur que Curso** (EC2 `13.36.242.35`, Ubuntu 24.04 arm64,
2 vCPU / 1,8 Go + 2 Go de swap), mais sous un **utilisateur Linux dédié `skipper`**. Il n'y a
pas de CI/CD : le déploiement est manuel (tirer `main`, builder, redémarrer).

## Accès

- **SSH** : `ssh skipper@skipper.toolso.io` (clé `~/.ssh/id_rsa` du poste, ou la clé EC2
  `app-paris.pem`). `skipper` est sudoer sans mot de passe.
- **Web** : https://skipper.toolso.io. Connexion des utilisateurs par **Google OAuth** (voir
  « Connexion des utilisateurs ») ; en plus, une **authentification HTTP basic** nginx
  (`/etc/nginx/.htpasswd-skipper`, identifiants dans `/home/skipper/.skipper-credentials`) qui peut
  être conservée en défense supplémentaire ou retirée (commenter les deux lignes `auth_basic` du
  site nginx) maintenant que l'application authentifie elle-même. Ajouter un utilisateur basic :
  `sudo htpasswd /etc/nginx/.htpasswd-skipper <nom>`.
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
`SHELL=/bin/bash` (les terminaux web utilisent zsh par défaut, absent du serveur),
`VITE_GRAPHQL_URL=https://skipper.toolso.io/graphql` (lu par Vite au build),
`APP_URL=https://skipper.toolso.io`, `API_URL=https://skipper.toolso.io` et les identifiants Google.

## Connexion des utilisateurs

Les utilisateurs se connectent avec Google. La configuration existe dans la console Google Cloud,
projet **Skipper** (`skipper-510112`, organisation toolso.io, compte de facturation Toolso) :

- **Google Auth Platform → Audience** : « Interne », donc seuls les comptes toolso.io peuvent se
  connecter, sans validation Google. Passer en « Externe » (avec liste d'utilisateurs test puis
  vérification) pour inviter des comptes hors organisation.
- **Google Auth Platform → Clients** : client « Skipper web » (application Web) avec les URI de
  redirection `https://skipper.toolso.io/auth/google/callback` et
  `http://localhost:4000/auth/google/callback` (développement).
- Le secret du client n'est visible qu'à sa création : il est dans le `.env` du poste de
  développement (jamais versionné). Le reporter dans `~/skipper/.env` sur le serveur
  (`GOOGLE_CLIENT_ID=...`, `GOOGLE_CLIENT_SECRET=...`), puis `pm2 restart skipper --update-env`.
  S'il est perdu : dans le client, « Add secret » en génère un nouveau.

Seules les adresses invitées sur un projet peuvent se connecter. La migration `011_users.sql` crée
`stan@toolso.io` administrateur de l'application et de tous les projets existants ; les autres
utilisateurs sont invités depuis la page d'un projet (bloc « Membres »). Le site nginx doit
proxifier `/auth/` vers le backend (bloc présent dans `deploy/nginx-skipper.conf`).

## Authentification Claude

Le plus simple : dans l'application, **Paramètres → Compte du serveur → Se connecter avec
Claude** (compte claude.ai avec abonnement). Le backend pilote `claude auth login` avec le CLI
installé pour l'utilisateur `skipper` (`~/.local/bin/claude`) ; les identifiants sont rangés par
le CLI dans `/home/skipper/.claude/` et se renouvellent seuls. Équivalent en SSH :
`ssh skipper@skipper.toolso.io` puis `claude auth login`. Alternatives dans la même page : un jeton
OAuth d'un an (`claude setup-token`, chiffré en base avec la clé
`/home/skipper/skipper-workspaces/.secret-key`, à sauvegarder avec la base) ou une clé API. Le
mode « compte du serveur » accepte aussi `ANTHROPIC_API_KEY=...` dans `~/skipper/.env` suivi d'un
`pm2 restart skipper --update-env`.

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
