# Cellule Skipper : installation et exploitation d'une machine dédiée

Une **cellule** est une machine qui porte un Skipper complet : backend, PostgreSQL, conteneurs des projets, nginx,
sauvegardes. Une cellule par client ; la première est celle de Toolso (`skipper-1`, Elastic Metal EM-A116X-SSD,
Scaleway fr-par-2, Ubuntu 24.04). Ces scripts sont idempotents : relançables sans dégât.

| Script | Qui | Rôle |
| --- | --- | --- |
| `bootstrap.sh --domain …` | root, une fois | Paquets, Node 22, Docker durci, PostgreSQL 17 + pgBackRest, nginx + certbot, utilisateur `skipper`, services systemd (via `bluegreen-setup.sh`), pare-feu, fail2ban, mises à jour automatiques |
| `bluegreen-setup.sh` | root | Bleu/vert : unité `skipper@.service` (blue 4101, green 4102), upstream nginx commuté `/etc/nginx/skipper-upstream.conf`, sudo restreint de `deploy.sh`. Appelé par `bootstrap.sh` ; une fois à la main sur une cellule installée avant |
| `postgres.sh [--s3-…]` | root | Rôle et base `skipper`, réglages, sauvegardes pgBackRest chiffrées vers un bucket Object Storage ; écrit `/etc/skipper/db.env` |
| `backup-files.sh --install --s3-…` | root | Sauvegarde restic quotidienne des workspaces, de la clé maîtresse, des pièces jointes et du `.env` |
| `install-skipper.sh --domain …` | skipper | Clone, `.env`, dépendances, build, front, image du runner, démarrage |
| `deploy.sh` | skipper | **Mise à jour sans interruption** : build dans le dossier de l'autre couleur, démarrage et vérification de la nouvelle instance, bascule de nginx, drainage de l'ancienne (front seul : publication sans rien redémarrer) |
| `migrate-from-ec2.sh --old …` | skipper | Reprise des données de l'ancienne installation (base RDS, workspaces, secrets du `.env`) |

## Installation d'une cellule

```bash
# 0. Commander le serveur (API ou CLI Scaleway du coffre), enregistrer les clés SSH dans IAM, installer Ubuntu 24.04
#    avec ces clés (RAID 1 par défaut), créer l'enregistrement DNS du domaine vers l'adresse du serveur.
# 1. En root, sur la machine :
git clone https://github.com/stan-toolso/skipper.git /root/skipper-install
cd /root/skipper-install/deploy/cellule
./bootstrap.sh --domain skipper2.toolso.io --hostname skipper-1 --certbot-email ops@toolso.io   # long : nohup … > /var/log/skipper-bootstrap.log &
#    Clé d'API Object Storage (application IAM « sauvegardes », permission ObjectStorageFullAccess), déposée une fois :
install -m 600 /dev/null /etc/skipper/s3.env && printf 'S3_BUCKET=skipper-sauvegardes\nS3_KEY=SCW...\nS3_SECRET=...\nS3_REGION=fr-par\n' > /etc/skipper/s3.env
./postgres.sh                 # lit /etc/skipper/s3.env ; ou --s3-bucket/--s3-key/--s3-secret ; ou rien pour commencer sans sauvegarde
./backup-files.sh --install
# 2. En skipper (les scripts root ne sont pas lisibles par skipper : en copier le dossier) :
cp -r /root/skipper-install/deploy/cellule /home/skipper/cellule-install && chown -R skipper:skipper /home/skipper/cellule-install
sudo -iu skipper
~/cellule-install/install-skipper.sh --domain skipper2.toolso.io       # ou avec --google-client-id/--google-client-secret ; long : nohup … &
# 3. Migration (facultatif) : d'abord en répétition, puis avec --freeze pour la bascule définitive
~/skipper/deploy/cellule/migrate-from-ec2.sh --old skipper@skipper.toolso.io
```

Le clone de l'étape 1 ne sert qu'à lancer les scripts root ; celui de Skipper lui-même est `/home/skipper/skipper`
(étape 2). Les secrets Google et GitHub ne transitent pas par la ligne de commande quand on migre : `migrate-from-ec2.sh`
les copie de l'ancien `.env` vers le nouveau, de machine à machine.

## Disposition

| Élément | Emplacement |
| --- | --- |
| Clone de Skipper, `.env` | `/home/skipper/skipper` (sources et scripts ; aucun backend n'y tourne en bleu/vert) |
| Instances du backend | `/home/skipper/skipper-blue`, `/home/skipper/skipper-green` : worktrees détachés du clone, chacun avec ses `node_modules` et son build |
| Workspaces, clé maîtresse `.secret-key`, pièces jointes | `/home/skipper/skipper-workspaces` |
| Front publié | `/var/www/skipper` |
| Backend | services systemd `skipper@blue` (port 4101) et `skipper@green` (4102), une seule activée hors mise à jour (`journalctl -u skipper@blue`) ; instance active : `/etc/nginx/skipper-upstream.conf`. Ancien mode : service `skipper`, port 4100 |
| Base | PostgreSQL 17 local, `DATABASE_URL` dans `/etc/skipper/db.env` ; réglages `/etc/postgresql/17/main/conf.d/skipper.conf` |
| Sauvegardes | pgBackRest (`/etc/pgbackrest/pgbackrest.conf`, complète le dimanche, différentielle les autres jours, WAL en continu) et restic (`/etc/skipper/restic.env`, 3 h 30) vers `s3://<bucket>/<hôte>/` ; phrases secrètes dans `/etc/skipper/` **à copier hors de la machine** |
| nginx | `/etc/nginx/sites-available/skipper` (modèle `templates/nginx-site.conf` : compression gzip des bundles et du JSON), TLS Let's Encrypt, HTTP/2 ajouté par bootstrap.sh aux écoutes TLS de certbot |
| Docker | `/etc/docker/daemon.json` : `icc=false` (les conteneurs de projets ne se voient pas), `no-new-privileges`, `live-restore` (les conteneurs survivent au redémarrage du démon), journaux bornés |

## Mettre à jour

```bash
sudo -iu skipper ~/skipper/deploy/cellule/deploy.sh            # origin/main
~/skipper/deploy/cellule/deploy.sh --ref origin/ma-branche      # une autre référence
~/skipper/deploy/cellule/deploy.sh --force                      # tout reconstruire et changer d'instance même sans changement
```

**Bleu/vert** (cellule préparée par `bluegreen-setup.sh`). Deux instances du backend, `skipper@blue` (4101) et
`skipper@green` (4102), chacune dans son dossier ; nginx envoie le trafic à l'instance active. `deploy.sh` :

1. construit la référence dans le dossier de l'autre couleur (`git worktree` détaché du clone, `npm ci` si le lockfile
   a changé, build, image du runner si `deploy/runner/` a changé) : l'instance active n'est pas touchée ;
2. si seul `frontend/` a changé : publie le front, rien d'autre ;
3. sinon démarre la nouvelle instance (elle applique les migrations, s'inscrit dans `backend_instances`, laisse en
   place les sessions de l'autre), attend qu'elle réponde sur `/graphql` (échec : elle est arrêtée, nginx n'a pas
   bougé), réécrit `/etc/nginx/skipper-upstream.conf`, `nginx -t` puis recharge nginx, publie le front ;
4. envoie SIGUSR2 à l'ancienne et la désactive au boot. Elle cède les planificateurs à la nouvelle, finit les tours
   en cours, gare chaque session à la fin de son tour (la prochaine instruction la relance sur la nouvelle instance,
   conversation comprise) et sort d'elle-même quand plus rien n'y tourne (au plus `SKIPPER_DRAIN_TIMEOUT_MINUTES`,
   120 par défaut). Pendant ce temps, l'interface servie par la nouvelle instance voit ce que fait l'ancienne (bus
   PostgreSQL) et lui transmet instructions, interruptions et réponses aux demandes ; les connexions déjà ouvertes
   (subscriptions, terminaux) restent sur l'ancienne jusqu'à sa sortie, puis se reconnectent.

Suivi : `sudo journalctl -u skipper@blue -f` ; instances : `SELECT label, port, heartbeat_at, draining_since FROM
backend_instances`. Une mise à jour lancée pendant que l'instance précédente se vide encore attend sa sortie (au plus
`--max-wait`, puis abandon, ou arrêt forcé avec `--force`). Les migrations doivent rester compatibles avec la version
précédente, qui tourne encore pendant le drainage : ajouter, pas retirer ni renommer dans la même livraison.

**Transition d'une cellule installée avant** (skipper-1) : `sudo …/deploy/cellule/bluegreen-setup.sh` (root, depuis
un clone à jour), qui laisse l'upstream sur l'ancien service (4100) ; le `deploy.sh` suivant fait une dernière mise à
jour avec interruption (attente de la fin des tours, arrêt et désactivation de `skipper`, démarrage de `skipper@blue`,
bascule). L'ancienne version ne sait pas se vider : la nouvelle prendrait ses sessions pour orphelines si les deux
tournaient ensemble.

**Ancien mode** (sans `/etc/nginx/skipper-upstream.conf`) : attente que plus aucune session ne soit `busy` (au plus
`--max-wait`), redémarrage du service `skipper` (3 à 5 secondes), sessions coupées en plein tour relancées par le
nouveau backend.

## Restaurer

```bash
# Base, au dernier état (ou --type=time --target="2026-10-30 14:00:00+01")
sudo systemctl stop skipper@blue skipper@green postgresql
sudo -u postgres pgbackrest --stanza=skipper --delta restore
sudo systemctl start postgresql skipper@blue      # la couleur de /etc/nginx/skipper-upstream.conf (4101 : blue, 4102 : green)
# Fichiers
sudo bash -c '. /etc/skipper/restic.env; restic snapshots; restic restore latest --target /'
```

Tester une restauration sur une machine vide tous les mois : c'est la seule preuve que les sauvegardes valent quelque chose.

## Changer de domaine (bascule skipper2 → skipper)

1. Ajouter l'URI de redirection `https://<domaine>/auth/google/callback` au client OAuth (console Google Cloud).
2. Pointer le DNS, puis `sudo certbot --nginx -d <domaine>` et remplacer `server_name` dans le site nginx.
3. Mettre `APP_URL`, `API_URL`, `VITE_GRAPHQL_URL` à jour dans `.env`, puis `deploy.sh --force` (rebuild du front, nouvelle instance).
