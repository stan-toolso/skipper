# Mise en production — skipper.toolso.io

Skipper tourne sur **le même serveur que Curso** (EC2 `13.36.242.35`, `t4g.medium`, Ubuntu 24.04
arm64, 2 vCPU / 3,7 Go + 2 Go de swap), mais sous un **utilisateur Linux dédié `skipper`**. Il n'y a
pas de CD : la CI GitHub Actions (`.github/workflows/ci.yml`) vérifie typecheck, build et tests
à chaque push et pull request, mais le déploiement reste manuel (tirer `main`, builder, redémarrer).

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

- **Google Auth Platform → Audience** : « Externe », statut « En production », depuis le 2026-09-29
  (auparavant « Interne », ce qui bloquait le rattachement de comptes gmail.com à un projet, erreur
  `org_internal`). L'application n'est pas validée par Google : l'écran de consentement affiche un
  avertissement « Google n'a pas validé cette application », à passer par « Paramètres avancés » puis
  « Accéder à Skipper » ; les jetons n'expirent pas et la limite est de 100 utilisateurs ayant accordé
  des portées sensibles (compteur sur la page Audience). Ne pas revenir en « Test » : dans ce mode les
  jetons de rafraîchissement expirent au bout de 7 jours. La connexion à Skipper reste réservée aux
  adresses invitées sur un projet, quelle que soit l'audience Google.
- **Google Auth Platform → Branding** : page d'accueil `https://skipper.toolso.io` et politique de
  confidentialité `https://skipper.toolso.io/privacy.html` (`frontend/public/privacy.html`, servie sans
  authentification et exclue du repli du service worker), exigées pour le statut « En production ».
- **Google Auth Platform → Clients** : client « Skipper web » (application Web) avec les URI de
  redirection `https://skipper.toolso.io/auth/google/callback` et
  `http://localhost:4000/auth/google/callback` (développement). Le même client et le même callback
  servent à relier un compte Google à un projet (Gmail, Drive) : pour cela, activer les API **Gmail
  API** et **Google Drive API** dans « API et services » du projet Google Cloud (fait le 2026-09-29).
- Le secret du client n'est visible qu'à sa création : il est dans le `.env` du poste de
  développement (jamais versionné). Le reporter dans `~/skipper/.env` sur le serveur
  (`GOOGLE_CLIENT_ID=...`, `GOOGLE_CLIENT_SECRET=...`), puis `pm2 restart skipper --update-env`.
  S'il est perdu : dans le client, « Add secret » en génère un nouveau.

Seules les adresses invitées sur un projet peuvent se connecter. La migration `011_users.sql` crée
`stan@toolso.io` administrateur de l'application et de tous les projets existants ; les autres
utilisateurs sont invités depuis la page d'un projet (bloc « Membres »). Le site nginx doit
proxifier `/auth/` vers le backend (bloc présent dans `deploy/nginx-skipper.conf`).

## Authentification Claude

Chaque personne connecte **son** abonnement ou sa clé API : Paramètres → Claude → **Se connecter
avec Claude** (le backend pilote `claude setup-token` avec le CLI installé pour l'utilisateur
`skipper`, `~/.local/bin/claude` ; le jeton obtenu est rangé dans le coffre personnel de la personne
comme jeton applicatif, chiffré avec la clé `/home/skipper/skipper-workspaces/.secret-key`, à
sauvegarder avec la base), ou une clé API Anthropic déposée dans son coffre et choisie dans la même
page. Il n'y a plus de compte du serveur partagé : une session n'utilise que les identifiants de son
propriétaire, et les identifiants du compte `skipper` (`/home/skipper/.claude/`) ne sont plus montés
dans les conteneurs. Les réglages Claude et GitHub de l'ancienne version sont repris au premier
démarrage dans le coffre et les réglages du premier administrateur.

## Dépôts git privés des projets

Deux possibilités.

**Connexion GitHub depuis l'interface (recommandé)** : Paramètres → GitHub, **par personne**, un ou
plusieurs comptes. Le plus simple est la **connexion par code** (device flow ; par défaut avec
l'identifiant public du CLI GitHub, ou avec une OAuth App à vous — Settings → Developer settings →
OAuth Apps, « Enable Device Flow » coché — dont le client id va dans `GITHUB_CLIENT_ID` du `.env` ;
`GITHUB_CLIENT_ID=none` désactive ce mode). Sinon, un **jeton d'accès personnel** déposé dans le coffre
(élément « jeton applicatif », service GitHub ; Settings → Developer settings → Personal access tokens ;
« fine-grained » limité aux dépôts voulus avec *Contents : Read and write* et, pour les pull requests
du panneau git, *Pull requests : Read and write* plus *Commit statuses* et *Checks* en lecture ; ou
« classic » avec la portée `repo`) puis choisi dans la page. Le jeton est chiffré dans le coffre (même
clé que les autres secrets) et injecté dans les commandes git de la personne et de ses sessions pour
les URL https de github.com ; pour chaque dépôt, le compte retenu est celui qui le possède (identifiant
ou organisation), sinon le compte par défaut. Les projets utilisent alors l'URL https du dépôt, et le
formulaire de projet propose la liste des dépôts des comptes connectés.

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
dossier ou création du dossier d'une session.

## Conteneurs des projets (Docker obligatoire)

Tout projet tourne dans son conteneur Docker : sessions, terminaux et commandes n'ont aucun mode
d'exécution directe sur le serveur. Docker et l'image de base sont donc indispensables (installés
depuis le 29/09/2026 ; l'image pèse ~1 Go plus les caches des projets). Mise en place :

```bash
# Sur le serveur, en tant que skipper (sudoer)
sudo apt-get update && sudo apt-get install -y docker.io
sudo usermod -aG docker skipper        # puis se reconnecter
cd ~/skipper && docker build -t skipper-runner:latest deploy/runner
```

Les limites par défaut (`SKIPPER_RUNNER_MEMORY`, 768m en production ; `SKIPPER_RUNNER_CPUS`, vide :
aucun plafond CPU, voir plus bas) se règlent dans le `.env`, et par projet dans son formulaire
(« Mémoire », « CPU »), appliqués à la création du conteneur et à chaud au conteneur existant. **Un conteneur est partagé par toutes les sessions du projet** : chaque CLI
Claude Code prend ≈ 250 Mo, et les agents y lancent aussi `npm ci` (≈ 400 Mo), `tsc`, `vite build`.
Au-delà de la limite, le noyau tue des processus du conteneur : commandes interrompues et sessions
en erreur ; Skipper l’explique alors dans le transcript (« le conteneur du projet a dépassé sa limite
mémoire »). Réglages en place depuis le 30/09/2026 :
Skipper 2g (plusieurs agents buildent en parallèle, chacun dans son dossier), SUF 1500m (navigateur),
Curso 768m (défaut). Pour vérifier et ajuster sans couper les sessions :

```bash
docker stats --no-stream                                  # mémoire utilisée / limite par conteneur
sudo journalctl -k -b | grep "Killed process"              # processus tués faute de mémoire
docker update --memory 2g --memory-swap 4g skipper-<slug>  # limite relevée à chaud, sans redémarrage
```

Modifier les limites depuis la page du projet (carte « Environnement d'exécution », « Modifier ») ou
son formulaire les enregistre **et** les applique à chaud (`docker update`, swap = 2 × mémoire). Un
`docker update` lancé à la main ne vaut que pour le conteneur en cours : reporter la même valeur dans
le projet, sinon elle est perdue à la prochaine recréation. La même carte montre la mémoire et le CPU
du conteneur, les processus `claude` par session et le nombre de processus tués faute de mémoire ;
une notification avertit quand un conteneur reste au-dessus de 90 % de sa limite plus d'une minute.

**Dimensionner la limite d'un projet** : c'est le nombre de sessions ouvertes, plus que les builds,
qui remplit le conteneur (constat du 01/10/2026 : 5 processus `claude` de 225 à 293 Mo, dont 3 de
sessions inactives). Compter :

- ≈ 250 Mo par session Claude ouverte (même inactive), plus 300 à 500 Mo avec le navigateur headless ;
- ≈ 400 Mo pour un `npm ci`, 400 à 900 Mo pour un `tsc`, ≈ 900 Mo pour un `vite build` ;
- une marge de 20 %.

Exemples : 2 sessions sans build → 768m ; 4 sessions dont une qui builde → 2g ; projet avec
navigateur et 3 sessions → 1500m à 2g. Terminer les sessions inutiles libère plus vite qu'un
relèvement de limite (la somme des limites peut dépasser la RAM du serveur).
Reconstruire l'image met à jour le CLI Claude Code des conteneurs ; « Recréer » sur la page du
projet applique la nouvelle image : les sessions en cours du projet sont interrompues (pas en erreur) puis
reprises d'elles-mêmes dès que le nouveau conteneur tourne, les terminaux ouverts sont fermés.

**CPU** : par défaut un conteneur n'a **pas de plafond CPU** : les cœurs du serveur sont partagés
équitablement (ordonnanceur CFS) entre les conteneurs et le backend, et un projet seul actif dispose
de toute la machine. Jusqu'au 24/10/2026 le défaut était `--cpus 1` : les cinq sessions du projet
Skipper et leurs `npm ci`, `tsc` et `vite build` se partageaient un seul cœur sur les deux du
serveur, bridé 94 % du temps pendant ces commandes, d'où des sessions très lentes. Un plafond (champ
« CPU » du projet, ex. `1` ou `0.5`) reste possible pour un projet qui ne doit pas gêner les autres ;
le changer s'applique à chaud (`docker update`) et marque le conteneur « à recréer » (fait dès que le
projet est inactif). Les conteneurs créés avec l'ancien défaut sont ainsi recréés sans plafond au
premier déploiement, dès qu'ils sont inactifs. La carte « Environnement d'exécution » montre la
pression CPU du conteneur (PSI `cpu.pressure` : part du temps où un processus attendait le
processeur, bridé ou en concurrence) et avertit au-delà de 25 % ; une notification
`container.cpu_saturated` part quand elle dépasse 50 % pendant plus de cinq minutes. Le vrai plafond
est alors la machine (t4g.medium : 2 vCPU, 3,7 Go) : si plusieurs sessions en parallèle sont l'usage
courant, c'est l'instance qu'il faut agrandir. Pour mesurer sur le serveur :

```bash
CG=/sys/fs/cgroup/system.slice/docker-$(docker inspect skipper-<slug> --format '{{.Id}}').scope
cat $CG/cpu.pressure                                   # some avg60 = pression CPU affichée par la carte
grep -E 'nr_periods|nr_throttled' $CG/cpu.stat         # périodes bridées par un plafond --cpus (0 sans plafond)
cat /proc/pressure/cpu                                 # pression CPU de toute la machine
```

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
pm2 restart skipper --update-env               # seulement si le backend a changé (voir ci-dessous)
```

Les migrations SQL sont appliquées automatiquement au démarrage du backend.

**Redémarrer le backend interrompt toutes les sessions en cours** : les processus Claude Code sont des
enfants du backend. Elles passent à « Interrompue » (pas en erreur) et un message relance la
conversation. Au démarrage, celles qui étaient au milieu d'un tour (trois au plus, dont l'agent qui a
lancé le redémarrage) sont relancées automatiquement (réglage **Paramètres → Serveur**, activé par défaut). Avant `pm2 restart`, activer **Paramètres → Serveur → mode maintenance** : aucune
nouvelle session ne démarre, et la page indique combien d'agents travaillent encore. Redémarrer quand
ce nombre est à zéro si possible, en pensant à l'agent qui déploie depuis Skipper. Le redémarrage
lève la maintenance. Si seul `frontend/` a changé (`git diff --stat HEAD@{1} HEAD`), le `cp`
suffit : pas de redémarrage.

`npm run build` et `npm run typecheck` valident le schéma GraphQL du backend et toutes les requêtes du
front contre ce schéma (`frontend/scripts/check-graphql.mjs`) : tsc ne voit pas l'intérieur des gabarits
`gql`, et une erreur de fusion y donnait une page blanche en production (30/09/2026).

## Fichiers joints aux instructions

Les fichiers joints par les utilisateurs sont écrits dans `/home/skipper/skipper-workspaces/<slug>.attachments/`
(à sauvegarder avec les workspaces si l'on tient aux pièces jointes ; supprimés avec la session). Le
transcript les charge par `GET /api/attachments/<session>/<id>` : le site nginx doit proxifier `/api/`
vers le backend (bloc présent dans `deploy/nginx-skipper.conf`, à reporter dans
`/etc/nginx/sites-available/skipper` puis `sudo nginx -t && sudo systemctl reload nginx`). Les conteneurs
docker créés avant cette version n'ont pas le dossier monté : « Recréer » sur la page du projet.

## Application installable

Le service worker (`/sw.js`) et le manifeste sont servis avec `Cache-Control: no-cache` par nginx
(`map $uri $skipper_cache_control` du site nginx) pour que chaque déploiement soit pris en compte à la
prochaine ouverture. L'installation exige HTTPS : c'est le cas.

## Compression et HTTP/2

Le `gzip on` global de `/etc/nginx/nginx.conf` (Ubuntu) ne compresse que `text/html` tant que `gzip_types` y
reste commenté : le bundle (2,4 Mo brut, 0,7 Mo gzippé), le CSS et toutes les réponses GraphQL (JSON, dont les
pages d'événements d'une session) partaient bruts. Le site nginx (`deploy/nginx-skipper.conf`,
`deploy/cellule/templates/nginx-site.conf`) porte désormais ses propres directives `gzip_*` (sans
`text/event-stream` : les subscriptions SSE restent sans tampon). HTTP/2 se déclare sur les écoutes TLS que
certbot ajoute (`listen 443 ssl http2;`, nginx 1.24 n'a pas `http2 on`) : `bootstrap.sh` le fait après certbot ;
sur une cellule déjà installée, reporter les directives `gzip_*` et ajouter `http2` aux deux lignes
`listen … 443 ssl` de `/etc/nginx/sites-available/skipper`, puis `sudo nginx -t && sudo systemctl reload nginx`.
Vérification : `curl -sI --http2 -H 'Accept-Encoding: gzip' https://skipper.toolso.io/assets/<index>.js` doit
répondre `HTTP/2 200` avec `content-encoding: gzip`.

## En-têtes de sécurité

Le site nginx (`deploy/cellule/templates/nginx-site.conf`, `deploy/nginx-skipper.conf`) masque sa version
(`server_tokens off`) et pose, au niveau `server`, HSTS, `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, `Permissions-Policy` et une `Content-Security-Policy` (`default-src 'self'`, aucun script en
ligne, `frame-ancestors 'none'` contre le clickjacking). La CSP et le `Cache-Control` dépendent du chemin par deux
`map` en tête de fichier : les réponses du backend (`/graphql`, `/api/`, `/auth/`, WebSockets) n'en reçoivent pas de
nginx (les pages partagées et aperçus de fichiers ont leur propre CSP `sandbox` et chargent des CDN).
**Piège** : un `add_header` dans une `location` annule tous ceux du bloc `server` ; n'en ajouter aucun dans une
location, passer par les `map`. Sur une cellule déjà installée, reporter les deux `map`, les lignes
`server_tokens`/`add_header` et le retrait des `add_header`/`expires` des locations dans
`/etc/nginx/sites-available/skipper` (sans toucher aux blocs certbot), puis `sudo nginx -t && sudo systemctl reload nginx`.
Vérification : `curl -sI https://skipper.toolso.io/` montre `content-security-policy` et `strict-transport-security`,
et `curl -sI https://skipper.toolso.io/assets/<index>.js` `cache-control: public, max-age=31536000, immutable`.
Déployer le front (`theme-init.js`) avant ou en même temps que la CSP : l'ancien `index.html` a un script en ligne
(sans effet grave s'il est bloqué : thème sombre par défaut au premier affichage).

## Image du runner Docker

Après une modification de `deploy/runner/Dockerfile` (CLI Claude Code, CLI OpenCode pour les
sessions OpenCode, Playwright/Chromium pour l'option « navigateur headless », CLI AWS et CLI Scaleway pour les
comptes AWS et Scaleway du coffre) : `docker build -t skipper-runner deploy/runner` sur le serveur
(≈ 1 Go, l'ARM64 télécharge son propre Chromium), puis « Recréer » le conteneur sur la page de
chaque projet concerné. Une session avec navigateur prend 300 à 500 Mo de plus : prévoir au moins
1,5 Go pour le conteneur du projet. Les comptes AWS du coffre (outil `aws_run`) exigent une image
reconstruite avec le CLI AWS v2 (≈ 250 Mo de plus) : sans lui, l'outil répond « “aws” est absent de l'image » ;
chaque commande tourne dans un conteneur jetable `skipper-run-*` (512 Mo au plus, supprimé à la fin), hors du
conteneur du projet, qui n'a donc pas besoin d'être recréé. Même chose pour les comptes Scaleway (outil `scw_run`) :
l'image doit contenir le CLI `scw` (binaire de 60 Mo environ, version fixée par l'argument `SCW_CLI_VERSION` du
Dockerfile) ; l'outil `scw_api` et le test de l'élément passent par l'API HTTP et n'en ont pas besoin.

La vue en direct du navigateur passe par le WebSocket `/browsers/<session>` : reporter le bloc
`location /browsers/` de `deploy/nginx-skipper.conf` dans `/etc/nginx/sites-available/skipper`, puis
`sudo nginx -t && sudo systemctl reload nginx`. Les conteneurs sont désormais créés avec `--init`
(récolte des processus de Chromium arrêtés) : « Recréer » le conteneur des projets qui utilisent le
navigateur pour en bénéficier. Les sessions OpenCode exigent une image reconstruite (CLI `opencode`)
et des conteneurs recréés (`--add-host host.docker.internal`, `~/.claude` propre au projet dans
`.runners/<slug>/claude-home` à la place du dossier de l'hôte) : « Recréer » sur la page de chaque projet
après la mise à jour. Les conversations Claude Code d'avant cette version sont dans `~/.claude/projects`
de l'hôte : les copier dans le dossier du projet (`projects/-<chemin encodé>*`) pour pouvoir les reprendre.

## Vérifications

```bash
pm2 list                                     # skipper « online », uptime remis à zéro
pm2 logs skipper --nostream --lines 20       # « [http] GraphQL prêt sur http://localhost:4100/graphql »
curl -s -X POST https://skipper.toolso.io/graphql \
  -H 'content-type: application/json' -d '{"query":"{ providers { type label } }"}'
curl -s https://skipper.toolso.io/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

## Journaux

Le backend écrit une ligne par message : niveau (`DEBUG`, `INFO`, `WARN`, `ERROR`) puis le message avec
son préfixe de module (`[sessions]`, `[graphql]`…). Tout passe par `backend/src/log.ts` (`log` ou
`createLogger('module')`) : pas de `console.*` dans le backend, sinon la ligne sort sans niveau.
`info` et `debug` vont sur la sortie standard (`~/.pm2/logs/skipper-out.log`), `warn` et `error` sur
la sortie d'erreur (`~/.pm2/logs/skipper-error.log`). Le niveau minimal se règle avec `LOG_LEVEL` dans le
`.env` (défaut `info` ; `pm2 restart skipper --update-env` après modification).

**Une seule date par ligne** : pm2 date déjà chaque ligne (`2026-10-12T20:52:38: `, réglage
`log_date_format` du processus), journald aussi (cellule skipper-1, service systemd, voir
`deploy/cellule/README.md`). Le logger n'ajoute donc son horodatage ISO que hors de ces deux cas :
`LOG_TIMESTAMP=auto` (défaut) l'omet quand `pm_id` est défini (pm2) ou quand la sortie d'erreur est
raccordée à journald (`JOURNAL_STREAM`, vérifiée contre le descripteur, car la variable est héritée par
les terminaux et sessions lancés depuis le service). On a gardé la date du gestionnaire plutôt que de
relancer pm2 sans `log_date_format` : elle reste présente même pour ce qui n'est pas écrit par le
logger (sortie d'un processus enfant, plantage de Node). `LOG_TIMESTAMP=on` ou `off` force le choix.
Vers journald, chaque ligne porte aussi la priorité syslog, que journald enregistre :
`journalctl -u skipper -p warning` ne montre que les `WARN` et `ERROR`.

Une erreur métier renvoyée au client (`AppError` : refus, ressource introuvable, dépôt sans branche de
base…) tient sur une ligne `WARN [graphql] <opération> · <champ> · <utilisateur> : <message>`. Seules les
erreurs inattendues sortent en `ERROR` avec leur trace : le journal d'erreurs ne devrait contenir que de
vraies anomalies. Les avertissements de Node attendus par conception (le SDK Claude signalant que
`canUseTool` n'est pas consulté pour les serveurs MCP internes, code `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`)
sont journalisés une seule fois, en `INFO`.

**Rotation** : pm2 ne fait pas tourner ses fichiers de journal (le journal d'erreurs dépassait
10 000 lignes en octobre 2026). Installer une fois le module `pm2-logrotate` :

```bash
export NVM_DIR=$HOME/.nvm; . $NVM_DIR/nvm.sh
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M          # rotation dès qu'un fichier dépasse 10 Mo
pm2 set pm2-logrotate:retain 14             # 14 fichiers tournés conservés par journal
pm2 set pm2-logrotate:compress true         # fichiers tournés compressés en gzip
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'   # et une rotation quotidienne à minuit
pm2 set pm2-logrotate:workerInterval 60     # vérification de la taille toutes les 60 s
pm2 conf pm2-logrotate                      # relire les réglages
pm2 flush skipper                           # (optionnel) vider les journaux courants, une fois
```

Le module est lui-même un processus pm2 (`pm2 list` l'affiche), sauvegardé avec `pm2 save` et relancé
au démarrage par le service systemd.

## Bon à savoir

- **Mémoire** : 3,7 Go de RAM pour tout le serveur, partagés avec l'API et le job Curso (≈ 400 Mo),
  le backend Skipper (≈ 200 Mo) et les conteneurs des projets. Les limites des conteneurs peuvent
  dépasser à elles toutes la mémoire du serveur (elles ne sont pas réservées) : surveiller `free -h` et
  `docker stats`. Un swap de 2 Go (`/swapfile`) amortit les pics.
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
