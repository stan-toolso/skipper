/** Scripts shell exécutés dans le conteneur du projet (à part du service : testés en les exécutant, sans base ni conteneur). */

/**
 * Script de lancement, exécuté dans le conteneur par `setsid` (groupe de processus à lui : l'arrêt tue tout l'arbre).
 * Paramètres par variables d'environnement ; chaque étape est notée dans `events` (voir state.ts).
 */
export const RUN_SCRIPT = `#!/bin/sh
# Généré par Skipper : aperçu d'une work session (installation des dépendances puis serveur de développement).
cd "$SKIPPER_STATE" || exit 1
exec >>log 2>&1
echo $$ > pid
ev() { echo "$(date +%s%3N) $*" >> "$SKIPPER_STATE/events"; }
ev begin
if [ -n "$SKIPPER_INSTALL" ]; then
  ev installing
  # Installation lancée à la création de la work session encore en cours : l'attendre plutôt que d'en lancer une deuxième.
  # Le processus est reconnu à sa ligne de commande : un pid périmé (conteneur recréé) peut désigner un autre processus.
  creation_install() { p=$(cat "$SKIPPER_DEPS_WAIT" 2>/dev/null) && [ -n "$p" ] && grep -qs install.sh "/proc/$p/cmdline"; }
  if [ -n "$SKIPPER_DEPS_WAIT" ] && creation_install; then
    echo "› Attente de l'installation des dépendances lancée à la création de la session (install.log)"
    while creation_install; do sleep 1; done
  fi
  cd "$SKIPPER_INSTALL_DIR" || { ev failed cwd; exit 1; }
  if [ -n "$SKIPPER_DEPS_HASH" ] && [ "$(cat node_modules/.skipper-deps 2>/dev/null)" = "$SKIPPER_DEPS_HASH" ]; then
    echo "Dépendances à jour (installées entre-temps) : aucune installation"
  else
    echo "› ($SKIPPER_INSTALL_DIR) $SKIPPER_INSTALL"
    sh -c "$SKIPPER_INSTALL"
    code=$?
    if [ "$code" -ne 0 ]; then ev failed install "$code"; exit 1; fi
    # Marqueur d'empreinte écrit par renommage : le fichier peut être un lien physique vers un instantané partagé.
    if [ -n "$SKIPPER_DEPS_HASH" ] && [ -d node_modules ]; then
      printf '%s\\n' "$SKIPPER_DEPS_HASH" > "node_modules/.skipper-deps.$$" && mv -f "node_modules/.skipper-deps.$$" node_modules/.skipper-deps
    fi
  fi
  ev installed
fi
cd "$SKIPPER_APP_DIR" || { ev failed cwd; exit 1; }
ev starting
echo "› ($SKIPPER_APP_DIR) $SKIPPER_COMMAND"
sh -c "$SKIPPER_COMMAND"
ev exited $?
`;

/**
 * Installation des dépendances à la création d'une work session sans instantané exact, exécutée dans le conteneur par
 * `setsid`. `install.pid` existe tant qu'elle tourne (l'aperçu et les agents l'attendent), `install.exit` reçoit son
 * code à la fin ; journal dans `install.log`. Mêmes variables que le script de lancement.
 */
export const INSTALL_SCRIPT = `#!/bin/sh
# Généré par Skipper : installation des dépendances d'une work session à sa création (aucun instantané exact).
cd "$SKIPPER_STATE" || exit 1
rm -f install.exit
exec >install.log 2>&1
echo $$ > install.pid
finish() { echo "$1" > "$SKIPPER_STATE/install.exit"; rm -f "$SKIPPER_STATE/install.pid"; exit "$1"; }
echo "Installation des dépendances à la création de la session — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "› ($SKIPPER_INSTALL_DIR) $SKIPPER_INSTALL"
cd "$SKIPPER_INSTALL_DIR" || finish 1
sh -c "$SKIPPER_INSTALL"
code=$?
if [ "$code" -eq 0 ] && [ -n "$SKIPPER_DEPS_HASH" ] && [ -d node_modules ]; then
  printf '%s\\n' "$SKIPPER_DEPS_HASH" > "node_modules/.skipper-deps.$$" && mv -f "node_modules/.skipper-deps.$$" node_modules/.skipper-deps
fi
echo "Fin de l'installation (code $code)"
finish "$code"
`;
