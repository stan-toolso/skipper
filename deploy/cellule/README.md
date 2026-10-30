# Cellule Skipper : installation et exploitation d'une machine dédiée

Une **cellule** est une machine qui porte un Skipper complet : backend, PostgreSQL, conteneurs des projets, nginx,
sauvegardes. Une cellule par client ; la première est celle de Toolso (`skipper-1`, Elastic Metal EM-A116X-SSD,
Scaleway fr-par-2, Ubuntu 24.04). Ces scripts sont idempotents : relançables sans dégât.

| Script | Qui | Rôle |
| --- | --- | --- |
| `bootstrap.sh --domain …` | root, une fois | Paquets, Node 22, Docker durci, PostgreSQL 17 + pgBackRest, nginx + certbot, utilisateur `skipper`, service systemd, pare-feu, fail2ban, mises à jour automatiques |
| `postgres.sh [--s3-…]` | root | Rôle et base `skipper`, réglages, sauvegardes pgBackRest chiffrées vers un bucket Object Storage ; écrit `/etc/skipper/db.env` |
| `backup-files.sh --install --s3-…` | root | Sauvegarde restic quotidienne des workspaces, de la clé maîtresse, des pièces jointes et du `.env` |
| `install-skipper.sh --domain …` | skipper | Clone, `.env`, dépendances, build, front, image du runner, démarrage |
| `deploy.sh` | skipper | **Mise à jour** : build sans toucher au backend, publication du front seule si possible, sinon attente de la fin des tours d'agents puis redémarrage de quelques secondes |
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
| Clone de Skipper, `.env` | `/home/skipper/skipper` |
| Workspaces, clé maîtresse `.secret-key`, pièces jointes | `/home/skipper/skipper-workspaces` |
| Front publié | `/var/www/skipper` |
| Backend | service systemd `skipper` (`journalctl -u skipper`), port 4100 |
| Base | PostgreSQL 17 local, `DATABASE_URL` dans `/etc/skipper/db.env` ; réglages `/etc/postgresql/17/main/conf.d/skipper.conf` |
| Sauvegardes | pgBackRest (`/etc/pgbackrest/pgbackrest.conf`, complète le dimanche, différentielle les autres jours, WAL en continu) et restic (`/etc/skipper/restic.env`, 3 h 30) vers `s3://<bucket>/<hôte>/` ; phrases secrètes dans `/etc/skipper/` **à copier hors de la machine** |
| nginx | `/etc/nginx/sites-available/skipper` (modèle `templates/nginx-site.conf`), TLS Let's Encrypt |
| Docker | `/etc/docker/daemon.json` : `icc=false` (les conteneurs de projets ne se voient pas), `no-new-privileges`, `live-restore` (les conteneurs survivent au redémarrage du démon), journaux bornés |

## Mettre à jour

```bash
sudo -iu skipper ~/skipper/deploy/cellule/deploy.sh            # origin/main
~/skipper/deploy/cellule/deploy.sh --ref origin/ma-branche      # une autre référence
~/skipper/deploy/cellule/deploy.sh --max-wait 60                # attendre au plus une minute que les agents finissent
```

Comportement : si seul `frontend/` a changé, le front est publié sans redémarrage. Sinon le script attend que plus
aucune session ne soit `busy` (requête SQL locale), redémarre le service (3 à 5 secondes d'indisponibilité du
backend), vérifie `/graphql`, puis publie le front. Les sessions qui étaient en plein tour sont relancées
automatiquement par le nouveau backend (réglage Paramètres → Serveur). Le **bleu/vert sans aucune interruption**
(deux instances, drainage, nginx commuté) est suivi par la tâche e1803f30 et remplacera ce redémarrage.

## Restaurer

```bash
# Base, au dernier état (ou --type=time --target="2026-10-30 14:00:00+01")
sudo systemctl stop skipper postgresql
sudo -u postgres pgbackrest --stanza=skipper --delta restore
sudo systemctl start postgresql skipper
# Fichiers
sudo bash -c '. /etc/skipper/restic.env; restic snapshots; restic restore latest --target /'
```

Tester une restauration sur une machine vide tous les mois : c'est la seule preuve que les sauvegardes valent quelque chose.

## Changer de domaine (bascule skipper2 → skipper)

1. Ajouter l'URI de redirection `https://<domaine>/auth/google/callback` au client OAuth (console Google Cloud).
2. Pointer le DNS, puis `sudo certbot --nginx -d <domaine>` et remplacer `server_name` dans le site nginx.
3. Mettre `APP_URL`, `API_URL`, `VITE_GRAPHQL_URL` à jour dans `.env`, puis `deploy.sh --force` (rebuild du front, redémarrage).
