# Mise en production — skipper.toolso.io

Skipper tourne sur **le même serveur que Curso** (EC2 `13.36.242.35`, Ubuntu 24.04 arm64,
2 vCPU / 1,8 Go + 2 Go de swap), mais sous un **utilisateur Linux dédié `skipper`**. Il n'y a
pas de CI/CD : le déploiement est manuel (tirer `main`, builder, redémarrer).

## Accès

- **SSH** : `ssh skipper@skipper.toolso.io` (clé `~/.ssh/id_rsa` du poste, ou la clé EC2
  `app-paris.pem`). `skipper` est sudoer sans mot de passe.
- **Web** : https://skipper.toolso.io. Connexion des utilisateurs par **Google OAuth** (voir
  « Connexion des utilisateurs »). L'ancienne **authentification HTTP basic** nginx est désactivée
  (lignes `auth_basic` commentées dans le site nginx) ; le fichier `/etc/nginx/.htpasswd-skipper` et
  les identifiants dans `/home/skipper/.skipper-credentials` existent toujours pour la réactiver en
  cas de besoin.
- **Base** : PostgreSQL 14 sur l'instance RDS `toolso-campaign-manager` (compte AWS Toolso
  Emailing, `eu-west-1`), base `skipper`, rôle `skipper`. Connexion en TLS vérifié
  (`sslmode=verify-full`, bundle CA `~/rds-eu-west-1-bundle.pem`). Le mot de passe est dans
  `~/skipper/.env` et nulle part ailleurs.
- **DNS** : enregistrement A `skipper.toolso.io` dans la zone Route 53 de toolso.io (profil
  AWS local `claude-toolso`).

## Disposition sur le serveur

| Élément            | Emplacement                                                     |
| ------------------ | --------------------------------------------------------------- |
| Clone du dépôt     | `/home/skipper/skipper` (branche `main`, remote HTTPS public `https://github.com/stan-toolso/skipper.git` ; l'alias ssh `github-skipper` et la clé `~/.ssh/skipper-deploy` restent disponibles si le dépôt devient privé) |
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
  `http://localhost:4000/auth/google/callback` (développement). Le même client et le même callback
  servent à relier un compte Google à un projet (Gmail, Drive) : pour cela, activer les API **Gmail
  API** et **Google Drive API** dans « API et services » du projet Google Cloud. En audience
  « Interne », les portées Gmail et Drive (dites sensibles) n'exigent aucune validation Google.
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

## Dépôts git privés des projets

Deux possibilités.

**Connexion GitHub depuis l'interface (recommandé)** : Paramètres → GitHub. Le plus simple est de
coller un **jeton d'accès personnel** (Settings → Developer settings → Personal access tokens ;
« fine-grained » limité aux dépôts voulus avec *Contents : Read and write*, ou « classic » avec la
portée `repo`). Alternative sans jeton à copier : une OAuth App GitHub (Settings → Developer
settings → OAuth Apps, « Enable Device Flow » coché) dont le client id se saisit dans la page ou dans
`GITHUB_CLIENT_ID` du `.env`, puis connexion par device flow. Dans les deux cas le jeton est chiffré
en base (même clé que les secrets Claude) et injecté dans les commandes git pour les URL https de
github.com. Les projets utilisent alors l'URL
https du dépôt, et le formulaire de projet propose la liste des dépôts du compte.

Les agents reçoivent ce jeton via un credential helper git (variables `GIT_CONFIG_*`) ainsi qu'une
identité de commit (config git globale de l'utilisateur `skipper`, sinon le compte GitHub connecté) :
ils peuvent donc commiter et pousser en https, y compris dans un conteneur. **Curso est passé en
https** (`https://github.com/stan-toolso/Curso.git`) ; la deploy key ci-dessous reste installée mais
n'est plus utilisée.

**Clé de déploiement par dépôt (repli)** : pour un dépôt hors du compte connecté ou sans OAuth App.
Il faut une **clé de déploiement en lecture seule** dédiée, avec un alias SSH. Attention : un projet
en **conteneur Docker** n'a pas accès aux clés SSH de l'hôte ; utiliser l'https avec le jeton. Exemple pour Curso (déjà en place : clé `~/.ssh/curso-deploy`, alias
`github-curso`) :

```bash
# Sur le serveur
ssh-keygen -t ed25519 -N "" -C "skipper-server-<projet>-deploy" -f ~/.ssh/<projet>-deploy
printf "\nHost github-<projet>\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/<projet>-deploy\n  IdentitiesOnly yes\n" >> ~/.ssh/config
cat ~/.ssh/<projet>-deploy.pub
# Depuis le poste (droits admin sur le dépôt)
gh repo deploy-key add <clé>.pub --repo <org>/<repo> --title "Skipper (skipper.toolso.io, lecture seule)"
```

Dans Skipper, l'URL git du projet doit alors être `git@github-<projet>:<org>/<repo>.git` (pas
l'URL https). Un dossier principal vide est cloné automatiquement à la prochaine préparation du
dossier ou création de worktree.

## Environnements isolés (runner docker)

Un projet en mode « Conteneur Docker » a besoin de Docker sur le serveur et de l'image de base.
**Non installé à ce jour** (et le disque de l'instance est presque plein : à agrandir ou nettoyer
avant, l'image pèse ~600 Mo plus les caches des projets). Mise en place :

```bash
# Sur le serveur, en tant que skipper (sudoer)
sudo apt-get update && sudo apt-get install -y docker.io
sudo usermod -aG docker skipper        # puis se reconnecter
cd ~/skipper && docker build -t skipper-runner:latest deploy/runner
```

Les limites par défaut (`SKIPPER_RUNNER_MEMORY`, `SKIPPER_RUNNER_CPUS`) se règlent dans le `.env` ;
sur cette instance de 1,8 Go, viser 512m à 768m par conteneur et peu de projets isolés en parallèle.
Reconstruire l'image met à jour le CLI Claude Code des conteneurs ; « Recréer » sur la page du
projet applique la nouvelle image.

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

## Application installable

Le service worker (`/sw.js`) et le manifeste sont servis avec `Cache-Control: no-cache` par nginx
(bloc dédié dans `deploy/nginx-skipper.conf`) pour que chaque déploiement soit pris en compte à la
prochaine ouverture. L'installation exige HTTPS : c'est le cas.

## Image du runner Docker

Après une modification de `deploy/runner/Dockerfile` (CLI Claude Code, Playwright/Chromium pour
l'option « navigateur headless ») : `docker build -t skipper-runner deploy/runner` sur le serveur
(≈ 1 Go, l'ARM64 télécharge son propre Chromium), puis « Recréer » le conteneur sur la page de
chaque projet concerné. Le serveur n'a que 1,8 Go de RAM : une session avec navigateur prend 300 à
500 Mo de plus, donc une seule à la fois et une limite mémoire du conteneur à 1,5 Go.

## Vérifications

```bash
pm2 list                                     # skipper « online », uptime remis à zéro
pm2 logs skipper --nostream --lines 20       # « [http] GraphQL prêt sur http://localhost:4100/graphql »
curl -s -X POST https://skipper.toolso.io/graphql \
  -H 'content-type: application/json' -d '{"query":"{ providers { type label } }"}'
curl -s https://skipper.toolso.io/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

## Bon à savoir

- **Mémoire** : le serveur n'a que 1,8 Go de RAM, partagés avec l'API et le job Curso. Chaque
  session Claude lance un processus Claude Code (quelques centaines de Mo) : limiter le nombre de
  sessions simultanées, et surveiller `free -h` / `pm2 list`. Un swap de 2 Go (`/swapfile`)
  amortit les pics.
- **Ne jamais lire ni copier le `.env` du serveur** dans une conversation ou un dépôt.
- **Retirer l'accès** : `sudo deluser skipper` ne suffit pas, penser au rôle RDS, à la clé de
  déploiement GitHub et au fichier `.htpasswd-skipper`.
- **Connexions des projets (SSH, PostgreSQL)** : le mode « outils » n'a besoin de rien de plus (client
  SSH et pg intégrés au backend). Le mode « shell de la session » utilise `ssh`, `ssh-agent`, `ssh-add`
  (paquet `openssh-client`, déjà présent) et, pour les bases, `psql` (`sudo apt install postgresql-client`).
  Les fichiers éphémères de session vont dans `/tmp/skipper-session-<id>` et sont supprimés à la fin de
  la session ou balayés au redémarrage du backend. Les identifiants sont chiffrés avec la même clé que les
  jetons des Paramètres (`SKIPPER_SECRET_KEY` ou `WORKSPACES_ROOT/.secret-key`) : sauvegarder cette clé
  avec la base, sinon les secrets deviennent illisibles.
