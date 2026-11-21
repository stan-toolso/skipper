/** Formulations en français des actions des agents, pour un public non technique. */

export interface ToolDescription {
  /** Phrase courte, ex. "Lecture du fichier notes.txt". */
  label: string;
  /** Détail affichable dans un bloc code (commande, chemin complet...). */
  detail?: string;
  /** Verbe à l'infinitif pour les demandes d'autorisation : "écrire le fichier notes.txt". */
  action: string;
}

const str = (input: Record<string, unknown>, key: string): string | undefined => (typeof input[key] === 'string' ? (input[key] as string) : undefined);
const baseName = (p?: string) => (p ? p.split('/').filter(Boolean).pop() ?? p : '');

export function describeTool(rawName: string, input: Record<string, unknown> = {}): ToolDescription {
  // Transcripts d'avant le renommage : l'outil s'appelait `worktrees`.
  const name = rawName.replace(/^mcp__worktrees__/, 'mcp__worksessions__');
  switch (name) {
    case 'Bash': {
      const cmd = str(input, 'command') ?? '';
      const desc = str(input, 'description');
      return { label: desc ? `Commande : ${desc}` : `Exécution d'une commande`, detail: cmd, action: `exécuter la commande ${cmd.length > 60 ? `${cmd.slice(0, 57)}…` : cmd}` };
    }
    case 'Read': {
      const p = str(input, 'file_path');
      return { label: `Lecture du fichier ${baseName(p)}`, detail: p, action: `lire le fichier ${baseName(p)}` };
    }
    case 'Write': {
      const p = str(input, 'file_path');
      return { label: `Création du fichier ${baseName(p)}`, detail: p, action: `créer ou remplacer le fichier ${baseName(p)}` };
    }
    case 'Edit':
    case 'NotebookEdit': {
      const p = str(input, 'file_path') ?? str(input, 'notebook_path');
      return { label: `Modification du fichier ${baseName(p)}`, detail: p, action: `modifier le fichier ${baseName(p)}` };
    }
    case 'Glob':
    case 'Grep': {
      const pattern = str(input, 'pattern') ?? '';
      return { label: `Recherche de « ${pattern} »`, detail: str(input, 'path'), action: `rechercher « ${pattern} » dans les fichiers` };
    }
    case 'WebFetch': {
      const url = str(input, 'url') ?? '';
      return { label: `Consultation de ${url}`, action: `consulter la page ${url}` };
    }
    case 'WebSearch': {
      const q = str(input, 'query') ?? '';
      return { label: `Recherche web : ${q}`, action: `faire une recherche web sur « ${q} »` };
    }
    case 'Task':
    case 'Agent': {
      const d = str(input, 'description') ?? 'sous-tâche';
      return { label: `Sous-tâche : ${d}`, action: `lancer une sous-tâche « ${d} »` };
    }
    case 'AskUserQuestion':
      return { label: 'Question posée', action: 'vous poser une question' };
    case 'TodoWrite':
      return { label: 'Mise à jour de la liste des tâches', action: 'mettre à jour sa liste de tâches' };
    case 'Skill':
      return { label: `Utilisation du savoir-faire ${str(input, 'skill') ?? ''}`, action: `utiliser le savoir-faire ${str(input, 'skill') ?? ''}` };
    default: {
      // Depuis un espace personnel, les outils visent un projet de la personne (paramètre project).
      const inProject = str(input, 'project') ? ` dans le projet ${str(input, 'project')}` : '';
      if (name.startsWith('mcp__projects__')) {
        const op = name.slice('mcp__projects__'.length);
        return op === 'get' ? { label: `Consultation du projet ${str(input, 'project') ?? ''}`, action: `consulter le projet ${str(input, 'project') ?? ''}` } : { label: 'Consultation de la liste des projets', action: 'consulter la liste de vos projets' };
      }
      if (name.startsWith('mcp__tasks__')) {
        const op = name.slice('mcp__tasks__'.length);
        const title = str(input, 'title');
        const verbs: Record<string, [string, string]> = {
          list: [`Consultation des tâches${inProject || ' du projet'}`, `consulter les tâches${inProject}`],
          get: ["Consultation d'une tâche", 'consulter une tâche'],
          create: [`Création de la tâche « ${title ?? ''} »${inProject}`, `créer la tâche « ${title ?? ''} »${inProject}`],
          update: [`Mise à jour d'une tâche${str(input, 'status') ? ` (${str(input, 'status')})` : ''}`, 'mettre à jour une tâche'],
          claim: ["Prise en charge d'une tâche", 'prendre une tâche en charge'],
          comment: [str(input, 'reply_to') ? "Réponse dans le fil d'une tâche" : "Message dans le fil d'une tâche", 'écrire dans le fil d\'une tâche'],
          react: [`Réaction ${str(input, 'emoji') ?? ''} sur une tâche`, 'réagir sur une tâche'],
          people: ['Consultation des personnes et sessions mentionnables', 'consulter qui peut être mentionné'],
          pr_list: ['Consultation des pull requests suivies', 'consulter les pull requests suivies'],
          ci_status: [`Lecture de l'état de la CI${str(input, 'ref') ? ` de ${str(input, 'ref')}` : ''}`, "lire l'état de la CI"],
          deploy_record: [`Déclaration du déploiement${str(input, 'sha') ? ` de ${str(input, 'sha')?.slice(0, 7)}` : ''}`, 'déclarer un déploiement'],
          pr_open: [`Ouverture de la pull request « ${title ?? ''} » sur GitHub (branche poussée avec votre compte)`, `ouvrir la pull request « ${title ?? ''} » sur GitHub`],
          pr_merge: [`Fusion de la pull request ${str(input, 'pr') ?? str(input, 'id') ?? ''} avec votre compte`, `fusionner la pull request ${str(input, 'pr') ?? str(input, 'id') ?? ''}${str(input, 'title') ? ` « ${str(input, 'title')} »` : ''} avec votre compte, à votre nom`],
          pr_close: [`Fermeture sans fusion de la pull request ${str(input, 'id') ?? ''} avec votre compte`, `fermer sans la fusionner la pull request ${str(input, 'id') ?? ''}`],
          pr_register: ["Suivi d'une pull request existante", 'suivre une pull request existante'],
          pr_update: [`Mise à jour d'une pull request suivie${str(input, 'status') ? ` (${str(input, 'status')})` : ''}`, 'mettre à jour une pull request suivie'],
        };
        const [label, action] = verbs[op] ?? [`Tâches : ${op}`, `utiliser les tâches (${op})`];
        return { label, action };
      }
      if (name.startsWith('mcp__conversations__')) {
        const op = name.slice('mcp__conversations__'.length);
        const channel = str(input, 'channel') ? `#${String(str(input, 'channel')).replace(/^#/, '')}` : 'un canal';
        const verbs: Record<string, [string, string]> = {
          list: [`Consultation des canaux de conversation${inProject}`, `consulter les canaux de conversation${inProject}`],
          read: [`Lecture du canal ${channel}`, `lire le canal ${channel}`],
          post: [str(input, 'reply_to') ? `Réponse dans un fil de ${channel}` : `Message dans ${channel}`, `écrire dans ${channel}`],
          react: [`Réaction ${str(input, 'emoji') ?? ''} sur un message`, 'réagir sur un message'],
        };
        const [label, action] = verbs[op] ?? [`Conversations : ${op}`, `utiliser les conversations (${op})`];
        return { label, action };
      }
      if (name.startsWith('mcp__context__')) {
        const op = name.slice('mcp__context__'.length);
        const path = str(input, 'path') ?? str(input, 'query') ?? '';
        const verbs: Record<string, [string, string]> = {
          tree: ['Consultation du contexte du projet', 'consulter le contexte du projet'],
          read: [`Lecture de l'instruction ${path}`, `lire l'instruction ${path}`],
          search: [`Recherche dans le contexte : ${path}`, `rechercher dans le contexte`],
          write: [`Enregistrement de l'instruction ${path}`, `enregistrer l'instruction ${path} dans le contexte`],
          create_folder: [`Création du dossier ${path} dans le contexte`, `créer le dossier ${path}`],
          move: [`Déplacement de ${path} dans le contexte`, `déplacer ${path}`],
          delete: [`Suppression de ${path} du contexte`, `supprimer ${path} du contexte`],
          history: [`Historique de l'instruction ${path}`, `consulter l'historique de ${path}`],
        };
        const [label, action] = verbs[op] ?? [`Contexte : ${op}`, `utiliser le contexte (${op})`];
        return { label, action };
      }
      if (name.startsWith('mcp__agents__')) {
        const op = name.slice('mcp__agents__'.length);
        const who = str(input, 'agent') ?? 'un agent';
        const short = (t: string, n = 160) => (t.length > n ? `${t.slice(0, n - 3)}…` : t);
        if (op === 'summon') return { label: `Convocation de l'agent ${who}${str(input, 'task_id') ? ' sur une tâche' : ''}`, detail: short(str(input, 'text') ?? ''), action: `convoquer l'agent ${who} (lance ou relance une de ses sessions)` };
        return { label: 'Consultation des agents du projet', action: 'consulter les agents du projet' };
      }
      if (name.startsWith('mcp__sessions__')) {
        const op = name.slice('mcp__sessions__'.length);
        const short = (t: string, n = 160) => (t.length > n ? `${t.slice(0, n - 3)}…` : t);
        const target = `${str(input, 'new_branch') ? ` sur la branche ${str(input, 'new_branch')}` : str(input, 'worksession') ? ` dans le dossier ${str(input, 'worksession')}` : ''}${inProject}`;
        const verbs: Record<string, [string, string | undefined, string]> = {
          list: [`Consultation des sessions${inProject || ' du projet'}`, undefined, `consulter les sessions${inProject || ' du projet'}`],
          get: ["Consultation d'une session", undefined, 'consulter une session'],
          create: [`Lancement d'une session d'agent${target}`, short(str(input, 'prompt') ?? ''), `lancer une autre session d'agent${target}`],
          wait: ["Attente de la réponse d'une session", undefined, "attendre la réponse d'une session"],
          send: ["Instruction à une session qu'il a lancée", short(str(input, 'text') ?? ''), 'envoyer une instruction à une session'],
          end: ["Fin d'une session qu'il a lancée", undefined, 'terminer une session'],
        };
        const [label, detail, action] = verbs[op] ?? [`Sessions : ${op}`, undefined, `utiliser les sessions (${op})`];
        return { label, detail, action };
      }
      if (name.startsWith('mcp__worksessions__')) {
        const op = name.slice('mcp__worksessions__'.length);
        const branch = str(input, 'branch') ?? str(input, 'name') ?? '';
        const verbs: Record<string, [string, string]> = {
          list: [`Consultation des dossiers de travail${inProject || ' du projet'}`, `consulter les dossiers de travail${inProject}`],
          create: [`Création du dossier de travail ${branch}${inProject}`, `créer le dossier de travail ${branch}${inProject}`],
          delete: [`Suppression du dossier de travail ${branch}${input.delete_branch ? ' et de sa branche' : ''}${inProject}`, `supprimer le dossier de travail ${branch}${input.delete_branch ? ' et sa branche' : ''}${inProject}`],
        };
        const [label, action] = verbs[op] ?? [`Dossiers de travail : ${op}`, `utiliser les dossiers de travail (${op})`];
        return { label, action };
      }
      if (name.startsWith('mcp__env__')) {
        const op = name.slice('mcp__env__'.length);
        const file = str(input, 'path') ?? '';
        const key = str(input, 'key') ?? '';
        const verbs: Record<string, [string, string]> = {
          list: ["Consultation des fichiers d'environnement", "consulter les fichiers d'environnement"],
          keys: [`Lecture des clés de ${file}`, `lire les clés de ${file}`],
          set: [`Ajout de la clé ${key} dans ${file}`, `ajouter la clé ${key} dans ${file}`],
          unset: [`Retrait de la clé ${key} de ${file}`, `retirer la clé ${key} de ${file}`],
          apply: ["Réécriture des fichiers d'environnement dans le dossier de travail", "réécrire les fichiers d'environnement"],
        };
        const [label, action] = verbs[op] ?? [`Fichiers d'environnement : ${op}`, `utiliser les fichiers d'environnement (${op})`];
        return { label, action };
      }
      if (name.startsWith('mcp__preview__')) {
        const op = name.slice('mcp__preview__'.length);
        const page = str(input, 'path') ?? '/';
        const verbs: Record<string, [string, string]> = {
          status: ["Consultation de l'état de l'aperçu", "consulter l'état de l'aperçu"],
          start: ["Lancement de l'aperçu de la branche", "lancer l'aperçu de la branche"],
          stop: ["Arrêt de l'aperçu de la branche", "arrêter l'aperçu de la branche"],
          log: ["Lecture du journal de l'aperçu", "lire le journal de l'aperçu"],
          screenshot: [`Capture de la page ${page} de l'aperçu${input.size === 'mobile' ? ' (mobile)' : ''}`, `capturer la page ${page} de l'aperçu`],
        };
        const [label, action] = verbs[op] ?? [`Aperçu : ${op}`, `utiliser l'aperçu (${op})`];
        return { label, action };
      }
      if (name.startsWith('mcp__chrome__')) {
        const op = name.slice('mcp__chrome__'.length);
        const tab = input.tab !== undefined ? ` (onglet ${String(input.tab)})` : '';
        const url = str(input, 'url') ?? '';
        const text = str(input, 'text') ?? '';
        const short = (t: string, n = 60) => (t.length > n ? `${t.slice(0, n - 3)}…` : t);
        const target = str(input, 'ref') ? ` sur l'élément ${str(input, 'ref')}` : input.x !== undefined ? ` en ${String(input.x)}, ${String(input.y)}` : '';
        const verbs: Record<string, [string, string]> = {
          tabs: ['Liste des onglets Chrome confiés à Skipper', 'lister les onglets Chrome confiés à Skipper'],
          open: [`Ouverture de ${url} dans votre Chrome`, `ouvrir ${url} dans votre Chrome`],
          navigate: [['back', 'forward', 'reload'].includes(url) ? `Navigation (${url}) dans votre Chrome${tab}` : `Navigation vers ${url} dans votre Chrome${tab}`, `naviguer vers ${url} dans votre Chrome`],
          read_page: [`Lecture de la page Chrome${tab}`, 'lire une page de votre Chrome'],
          click: [`Clic${target} dans votre Chrome${tab}`, `cliquer${target} dans votre Chrome`],
          type: [`Saisie de « ${short(text)} » dans votre Chrome${tab}`, `saisir « ${short(text)} » dans votre Chrome`],
          press_key: [`Touche ${str(input, 'key') ?? ''} dans votre Chrome${tab}`, `appuyer sur ${str(input, 'key') ?? ''} dans votre Chrome`],
          scroll: [`Défilement de la page Chrome${tab}`, 'faire défiler une page de votre Chrome'],
          screenshot: [`Capture de l'onglet Chrome${tab}`, 'capturer un onglet de votre Chrome'],
          console: [`Lecture de la console Chrome${tab}`, 'lire la console de votre Chrome'],
          wait: [`Attente dans votre Chrome${tab}`, 'attendre dans votre Chrome'],
          close_tab: [`Fermeture de l'onglet Chrome${tab}`, 'fermer un onglet de votre Chrome'],
        };
        const [label, action] = verbs[op] ?? [`Chrome : ${op}`, `utiliser votre Chrome (${op})`];
        return { label, action };
      }
      if (name.startsWith('mcp__pages__')) {
        const op = name.slice('mcp__pages__'.length);
        const title = str(input, 'title') ?? '';
        const what = input.kind === 'data' ? "l'artefact de données" : input.kind === 'slides' ? 'les diapositives' : 'la page';
        const verbs: Record<string, [string, string | undefined, string]> = {
          publish: [`Publication ${input.kind === 'data' ? "de l'artefact de données" : input.kind === 'slides' ? 'des diapositives' : 'de la page'} « ${title} »`, str(input, 'path'), `publier ${what} « ${title} »`],
          list: ['Liste des artefacts', undefined, 'lister les artefacts'],
          comments: ["Lecture des commentaires d'un artefact", undefined, "lire les commentaires d'un artefact"],
          reply: ['Réponse à un commentaire', str(input, 'body'), 'répondre à un commentaire'],
          resolve: ['Commentaire marqué traité', undefined, 'marquer un commentaire traité'],
          duplicate: [title ? `Copie d'un artefact : « ${title} »` : "Copie d'un artefact", undefined, 'dupliquer un artefact'],
          share: [input.project_access === true ? "Ouverture d'un artefact aux membres du projet" : input.anyone_with_link === true ? "Ouverture d'un artefact par le lien" : "Changement de l'accès d'un artefact", undefined, input.project_access === true ? "ouvrir un artefact aux membres du projet" : "changer l'accès d'un artefact"],
          refresh: ["Rafraîchissement des données d'un artefact", undefined, "rafraîchir les données d'un artefact"],
          set_data: [`Écriture des données de la source « ${str(input, 'source') ?? '?'} »`, undefined, "écrire les données d'un artefact"],
          data: [`Lecture des données ${str(input, 'source') ? `de la source « ${str(input, 'source')} »` : "d'un artefact"}`, undefined, "lire les données d'un artefact"],
        };
        const [label, detail, action] = verbs[op] ?? [`Artefacts : ${op}`, undefined, `utiliser les artefacts (${op})`];
        return { label, detail, action };
      }
      if (name.startsWith('mcp__cockpit__')) {
        const op = name.slice('mcp__cockpit__'.length);
        const scope = str(input, 'scope') ?? 'project';
        const where = scope === 'home' ? "de l'accueil" : scope === 'project' || scope === 'projet' ? 'du tableau de bord du projet' : `de ${scope}`;
        const verbs: Record<string, [string, string | undefined, string]> = {
          get: [`Lecture de l'agencement ${where}`, undefined, `lire l'agencement ${where}`],
          update: [`Modification de l'agencement ${where}`, str(input, 'note'), `modifier l'agencement ${where}`],
          reset: [`Réinitialisation de l'agencement ${where}`, undefined, `réinitialiser l'agencement ${where}`],
          history: [`Historique de l'agencement ${where}`, undefined, `lire l'historique de l'agencement ${where}`],
          restore: [`Restauration de l'agencement ${where} (version ${input.version ?? '?'})`, undefined, `restaurer une version de l'agencement ${where}`],
        };
        const [label, detail, action] = verbs[op] ?? [`Cockpit : ${op}`, undefined, `utiliser le cockpit (${op})`];
        return { label, detail, action };
      }
      if (name.startsWith('mcp__schedules__')) {
        const op = name.slice('mcp__schedules__'.length);
        const title = str(input, 'name');
        const cron = str(input, 'cron');
        const which = title ? ` « ${title} »` : '';
        const verbs: Record<string, [string, string | undefined, string]> = {
          list: ['Liste des planifications du projet', undefined, 'lister les planifications du projet'],
          get: ["Lecture d'une planification", undefined, 'lire une planification'],
          runs: ["Historique d'une planification", undefined, "lire l'historique d'une planification"],
          preview: [`Prochaines échéances de ${cron ?? 'une expression cron'}`, undefined, "calculer les prochaines échéances d'une expression cron"],
          create: [`Création de la planification${which}${cron ? ` (${cron})` : ''}`, str(input, 'prompt'), `créer la planification${which}${cron ? ` (${cron})` : ''}`],
          update: [`Modification d'une planification${which}`, str(input, 'prompt'), `modifier une planification${which}`],
          pause: ['Mise en pause d’une planification', undefined, 'mettre une planification en pause'],
          resume: ['Reprise d’une planification', undefined, 'reprendre une planification'],
          run_now: ["Exécution immédiate d'une planification (nouvelle session)", undefined, 'exécuter une planification maintenant'],
          delete: ["Suppression d'une planification et de son historique", undefined, 'supprimer une planification'],
        };
        const [label, detail, action] = verbs[op] ?? [`Planifications : ${op}`, undefined, `utiliser les planifications (${op})`];
        return { label, detail, action };
      }
      if (name.startsWith('mcp__connections__') || name.startsWith('mcp__vault__')) {
        const op = name.replace(/^mcp__(connections|vault)__/, '');
        const conn = str(input, 'connection') ?? str(input, 'item') ?? '';
        const db = str(input, 'database') ? ` (base ${str(input, 'database')})` : '';
        const cmd = str(input, 'command') ?? '';
        const sql = str(input, 'sql') ?? '';
        const short = (t: string, n = 80) => (t.length > n ? `${t.slice(0, n - 3)}…` : t);
        // Usage d'un secret sur un serveur : la demande porte sur le secret (target = serveur) ou sur le serveur.
        const secretRef = str(input, 'stdin_secret') ?? str(input, 'secret');
        const host = str(input, 'target') ?? conn;
        const verbs: Record<string, [string, string | undefined, string]> = {
          list: ['Consultation des connexions du projet', undefined, 'consulter les connexions du projet'],
          ssh_run: secretRef
            ? [`Commande sur ${host} (SSH), secret ${secretRef} en entrée`, cmd, `exécuter sur ${host}, avec le secret ${secretRef} en entrée standard : ${short(cmd)}`]
            : [`Commande sur ${conn} (SSH)`, cmd, `exécuter sur ${conn} : ${short(cmd)}`],
          ssh_write_secret: [
            `Écriture du secret ${secretRef ?? ''} sur ${host}`,
            `${str(input, 'remote_path') ?? ''} (droits ${str(input, 'mode') ?? '600'})`,
            `écrire le secret ${secretRef ?? ''} dans ${host}:${str(input, 'remote_path') ?? ''}`,
          ],
          run_with_secrets: [`Commande avec des secrets en variables d'environnement`, `${cmd}${str(input, 'env') ? `\n(${str(input, 'env')})` : ''}`, `exécuter une commande avec des secrets en variables d'environnement : ${short(cmd)}`],
          write_env_secret: [
            `Écriture du secret ${secretRef ?? ''} dans ${str(input, 'path') ?? 'un fichier .env'}`,
            `${str(input, 'name') ?? ''} → ${str(input, 'path') ?? ''} (la valeur devient lisible dans l'environnement de la session)`,
            `écrire le secret ${secretRef ?? ''} dans ${str(input, 'path') ?? 'un fichier .env'} (${str(input, 'name') ?? ''})`,
          ],
          request_secrets: [`Demande de secrets (${conn})`, undefined, `vous demander des secrets pour l'élément ${conn}`],
          update_item: [`Modification de l'élément ${conn} du coffre`, undefined, `modifier l'élément ${conn} du coffre`],
          ssh_upload: [`Envoi de ${str(input, 'local_path') ?? ''} vers ${conn}`, str(input, 'remote_path'), `envoyer ${str(input, 'local_path') ?? 'un fichier'} vers ${conn}`],
          ssh_download: [`Récupération de ${str(input, 'remote_path') ?? ''} depuis ${conn}`, str(input, 'local_path'), `récupérer ${str(input, 'remote_path') ?? 'un fichier'} depuis ${conn}`],
          sql_query: [`Requête SQL sur ${conn}${db}`, sql, `exécuter sur ${conn}${db} : ${short(sql)}`],
          sql_schema: [`Schéma de ${conn}${db}${str(input, 'table') ? ` (${str(input, 'table')})` : ''}`, undefined, `consulter le schéma de ${conn}${db}`],
          aws_run: [`Commande AWS sur ${conn}`, cmd ? `aws ${cmd}` : undefined, `exécuter sur ${conn} : aws ${short(cmd)}`],
          scw_run: [`Commande Scaleway sur ${conn}`, cmd ? `scw ${cmd}` : undefined, `exécuter sur ${conn} : scw ${short(cmd)}`],
          scw_api: [`Appel ${str(input, 'method') ?? 'GET'} ${str(input, 'path') ?? ''} de l'API Scaleway (${conn})`, undefined, `appeler l'API Scaleway avec ${conn} : ${str(input, 'method') ?? 'GET'} ${short(str(input, 'path') ?? '')}`],
          http_request: [`Appel ${str(input, 'method') ?? 'GET'} ${str(input, 'path') ?? ''} sur ${conn}`, undefined, `appeler ${conn} : ${str(input, 'method') ?? 'GET'} ${short(str(input, 'path') ?? '')}`],
          browser_fill: [`Saisie du champ « ${str(input, 'field') ?? ''} » de ${conn} dans le navigateur`, str(input, 'page'), `saisir « ${str(input, 'field') ?? ''} » de ${conn} dans le navigateur`],
        };
        const [label, detail, action] = verbs[op] ?? [`Coffre : ${op}`, undefined, `utiliser le coffre (${op})`];
        return { label, detail, action };
      }
      const json = JSON.stringify(input);
      return { label: `Outil ${name}`, detail: json.length > 200 ? `${json.slice(0, 197)}…` : json, action: `utiliser l'outil ${name}` };
    }
  }
}

/** Titre lisible d'une demande : pour une autorisation, l'action demandée ("Autorisation de lire le fichier x"). */
/**
 * Message d'une demande d'autorisation, sans ce que le détail de l'outil montre déjà : les outils du coffre passent la
 * commande (ou `[base] requête`) en message, parfois suivie d'une remarque (élément personnel). On ne garde que le reste.
 */
export function requestNote(message: string | null | undefined, ...shown: (string | undefined)[]): string | undefined {
  let rest = message ?? '';
  for (const s of shown) {
    const t = s?.trim();
    if (t && rest.includes(t)) rest = rest.replace(t, '');
  }
  rest = rest.replace(/^\s*\[[^\]\n]*\]\s*$/m, '').trim();
  return rest || undefined;
}

export function requestTitle(r: { type: string; title: string; payload: Record<string, unknown> }): string {
  const p = r.payload as { toolName?: string; input?: Record<string, unknown> };
  if (r.type === 'permission' && p.toolName) return `Autorisation de ${describeTool(p.toolName, p.input ?? {}).action}`;
  return r.title;
}

/** "à l'instant", "il y a 5 min", "il y a 3 h", "il y a 2 j", puis la date. */
export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  if (s < 86400 * 30) return `il y a ${Math.floor(s / 86400)} j`;
  return new Date(iso).toLocaleDateString();
}

/** Jour d'un instant, pour les séparateurs du transcript : « Aujourd'hui », « Hier », sinon la date (avec l'année si ce n'est pas l'année en cours). */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(d)) / 86_400_000);
  if (days === 0) return "Aujourd'hui";
  if (days === 1) return 'Hier';
  const label = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Heure d'un instant (« 14:05 »). */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export const permissionModeLabels: Record<string, string> = {
  default: 'Vous demande avant chaque action sensible',
  acceptEdits: 'Modifie les fichiers librement',
  plan: 'Réfléchit seulement, sans rien modifier',
  dontAsk: "Refuse sans demander ce qui n'est pas autorisé d'avance",
  bypassPermissions: 'Tout est autorisé',
};

/** Libellés courts des modes d'autorisation, pour la rangée d'outils de la zone de saisie (le libellé complet reste en infobulle). */
export const permissionModeShortLabels: Record<string, string> = {
  default: 'Demander avant d\'agir',
  acceptEdits: 'Modifier les fichiers',
  plan: 'Plan seulement',
  dontAsk: 'Refuser sans demander',
  bypassPermissions: 'Tout autoriser',
};

/**
 * Ce que le mode « Refuser sans demander » (dontAsk) refuse, pour l'expliquer avant d'y passer : ce mode ne veut pas
 * dire « ne plus me déranger » mais « refuser tout ce qui n'est pas autorisé d'avance ». Les éléments du coffre avec
 * approbation, eux, restent soumis à un humain quel que soit le mode (vault/mcp.ts, gate).
 */
export function dontAskConsequences(opts: { approvalConnections?: string[]; scheduleName?: string | null }): string[] {
  const out = [
    'les commandes et modifications de fichiers qui ne sont couvertes ni par une règle du projet ni par les outils pré-autorisés de la session ;',
    'les outils de Skipper soumis à autorisation (ouvrir une pull request, lancer une session, convoquer un agent…) ;',
    'les actions du navigateur (clic, saisie, navigation) et les écritures dans les comptes Google ;',
  ];
  const connections = opts.approvalConnections ?? [];
  if (connections.length) {
    out.push(`les connexions avec approbation (${connections.map((c) => `« ${c} »`).join(', ')}) vous seront toujours soumises : sans réponse, l'agent reste bloqué.`);
  }
  if (opts.scheduleName) {
    out.push(`cette session a été lancée par la planification « ${opts.scheduleName} » : ce mode ne vaut que pour elle, les prochaines exécutions gardent celui de la planification.`);
  }
  return out;
}

/** Refus d'un outil par le mode « Refuser sans demander » (message du CLI Claude Code dans le résultat de l'outil). */
export const DONT_ASK_DENIAL = /has been denied because Claude Code is running in don't ask mode/;

/**
 * Règle proposée pour autoriser un outil refusé : `Bash(grep *)` d'après la première commande (sous-commande gardée
 * pour git, npm…), `mcp__vault__sql_query(production)` pour un élément du coffre, sinon l'outil entier.
 */
export function ruleForCall(toolName: string, input: Record<string, unknown> | null | undefined): string {
  const args = input ?? {};
  if (toolName === 'Bash' && typeof args.command === 'string') {
    const rules = generalizeBashRule(args.command).filter((r) => !/["'`$()]/.test(r) && r.endsWith(' *'));
    return rules.length ? `Bash(${rules[0]})` : 'Bash';
  }
  if (toolName.startsWith('mcp__vault__') && typeof args.item === 'string' && args.item.trim()) return `${toolName}(${args.item.trim()})`;
  return toolName;
}

/** Liste d'outils pré-autorisés d'une session (« Read,Bash(git:*) »), découpée comme le fait le serveur. */
export function splitAllowedTools(value: unknown): string[] {
  return typeof value === 'string' ? value.split(',').map((t) => t.trim()).filter(Boolean) : [];
}

/** Avertissement pour le mode « tout autoriser » : les appels aux connexions soumises à approbation passent sans demande. */
export function bypassConnectionsWarning(connections: string[]): string | null {
  if (!connections.length) return null;
  const names = connections.map((c) => `« ${c} »`).join(', ');
  return `En mode « tout autoriser », les appels aux connexions ${names} ne vous seront pas soumis, alors qu'elles exigent votre approbation.`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} min ${s} s`;
}

/**
 * Unité des coûts que renvoie l'API (`Query.costDisplay`) : USD sur une instance sans facturation, crédits
 * dans une cellule dont la facturation est configurée (le serveur a déjà converti les valeurs). Fixée par
 * `AuthProvider` et mémorisée pour la visite suivante.
 */
export type CostUnit = 'USD' | 'CREDIT';
const COST_UNIT_KEY = 'skipper.costUnit';
let costUnit: CostUnit = (() => {
  try {
    return localStorage.getItem(COST_UNIT_KEY) === 'CREDIT' ? 'CREDIT' : 'USD';
  } catch {
    return 'USD';
  }
})();

export function setCostUnit(unit: CostUnit): void {
  costUnit = unit;
  try {
    localStorage.setItem(COST_UNIT_KEY, unit);
  } catch {
    // stockage indisponible : l'unité vaut pour cette visite
  }
}

export const getCostUnit = (): CostUnit => costUnit;

/** Libellé de l'unité pour un champ de saisie (« USD » ou « crédits »). */
export const costUnitLabel = (): string => (costUnit === 'CREDIT' ? 'crédits' : 'USD');

/** Coût dans l'unité de l'API : « 1,23 $ » ou « 12 crédits ». */
export function formatCost(value: number): string {
  if (costUnit === 'CREDIT') {
    const digits = value < 1 ? 2 : value < 100 ? 1 : 0;
    return `${value.toLocaleString('fr-FR', { maximumFractionDigits: digits })} crédit${value >= 2 ? 's' : ''}`;
  }
  return `${value.toFixed(value < 0.1 ? 3 : 2).replace('.', ',')} $`;
}

/** Nombre de tokens en milliers (« 208 k »), ou en millions au-delà (« 1,2 M »). */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')} M`;
  return `${Math.round(n / 1000)} k`;
}

export const sessionStatusLabels: Record<string, string> = {
  PENDING: 'Pas encore démarrée',
  QUEUED: "En file d'attente",
  RUNNING: 'En cours',
  COMPLETED: 'Terminée',
  FAILED: 'En erreur',
  STOPPED: 'Arrêtée',
  INTERRUPTED: 'Interrompue',
};

/** Phrase d'état d'une session, ex. "travaille", "attend vos instructions", "a besoin de vous". */
export function sessionStateHint(status: string, activity: string | null, pendingRequests: number): string | null {
  if (pendingRequests > 0) return 'a besoin de vous';
  if (status === 'RUNNING') return activity === 'BUSY' ? 'travaille' : 'attend vos instructions';
  if (status === 'FAILED') return 'en erreur';
  if (status === 'QUEUED') return 'attend une place pour démarrer';
  if (status === 'INTERRUPTED' && activity === 'BUSY') return 'interrompue en plein travail';
  return null;
}

/**
 * Puce de la tâche d'une session (sidebar). Une tâche marquée terminée alors que sa session y travaille encore (nouvelle
 * instruction, finitions après coup) ne s'affiche pas « terminée » mais « reprise » : son étiquette d'état (souvent
 * « PR #n à fusionner ») ne vaut plus tant que le tour n'est pas fini ; elle reste lisible dans l'infobulle (`note`).
 */
export function taskChipOf(task: { status: string; statusTag?: string | null }, session: { status: string; activity: string | null } | null): { text: string; cls: string; tag: string | null; note: string | null } {
  const working = session != null && (session.status === 'QUEUED' || (session.status === 'RUNNING' && session.activity === 'BUSY'));
  if (task.status === 'DONE' && working) return { text: 'reprise', cls: 'in_progress', tag: null, note: `marquée terminée${task.statusTag ? ` (« ${task.statusTag} »)` : ''}, mais l'agent y travaille encore` };
  const text = task.status === 'IN_PROGRESS' ? 'en cours' : task.status === 'DONE' ? 'terminée' : task.status === 'CANCELLED' ? 'annulée' : 'à faire';
  return { text, cls: task.status.toLowerCase(), tag: task.statusTag ?? null, note: null };
}

export const taskStatusLabels: Record<string, string> = { TODO: 'À faire', IN_PROGRESS: 'En cours', DONE: 'Terminée', CANCELLED: 'Annulée' };
export const taskPriorityLabels: Record<string, { label: string; bg: string }> = {
  URGENT: { label: 'Urgente', bg: 'danger' },
  HIGH: { label: 'Haute', bg: 'warning' },
  MEDIUM: { label: 'Moyenne', bg: 'secondary' },
  LOW: { label: 'Basse', bg: 'dark' },
};

export const projectRoleLabels: Record<string, { label: string; hint: string }> = {
  ADMIN: { label: 'Administrateur', hint: 'Gère le projet et ses membres, en plus de tout ce que fait un membre.' },
  MEMBER: { label: 'Membre', hint: 'Lance des sessions et des terminaux, gère tâches et contexte.' },
  VIEWER: { label: 'Lecteur', hint: 'Consulte sessions, tâches et contexte sans rien modifier.' },
  GUEST: { label: 'Invité', hint: 'Participe aux conversations du projet et lit les artefacts qu’on lui partage ; ne voit ni sessions, ni tâches, ni coffre.' },
};

/**
 * Ce que « ne plus demander » appliquerait, d'après les suggestions du SDK (PermissionUpdate) : des règles
 * « allow » (addRules, au format Read ou Bash(git status:*)) ou, pour les modifications de fichiers, le mode
 * acceptEdits (setMode), décrit par les outils qu'il libère.
 */
/** Commandes dont le deuxième mot est une sous-commande : la règle proposée la garde (`git checkout *`). */
const SUBCOMMAND_TOOLS = new Set(['git', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'docker', 'pm2', 'gh', 'cargo', 'go', 'kubectl', 'pip', 'pip3', 'make', 'systemctl', 'apt', 'apt-get', 'brew', 'terraform', 'aws', 'gcloud', 'scw']);
/** Commandes trop puissantes pour être autorisées par simple préfixe : la règle proposée reste la commande exacte. */
const EXACT_ONLY = new Set(['rm', 'sudo', 'su', 'sh', 'bash', 'zsh', 'eval', 'exec', 'xargs', 'env', 'ssh', 'scp', 'dd', 'chmod', 'chown', 'kill', 'pkill', 'killall', 'curl', 'wget', 'python', 'python3', 'node', 'perl', 'ruby', 'find', 'awk', 'tee', 'source', '.']);

/** Découpe une commande shell aux opérateurs `&&`, `||`, `;`, `|` et retours à la ligne situés hors guillemets. */
export function splitShellCommand(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) current += command[++i];
      else if (ch === quote) quote = null;
    } else if (ch === '\\' && i + 1 < command.length) current += ch + command[++i];
    else if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (command.startsWith('&&', i) || command.startsWith('||', i)) {
      parts.push(current);
      current = '';
      i++;
    } else if (ch === ';' || ch === '|' || ch === '\n') {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * Règle Bash généralisée pour une commande complète : un préfixe par commande simple (`sed -n '…' f.ts` →
 * `sed *`, `git checkout main` → `git checkout *`), sauf pour les commandes dangereuses, gardées telles quelles.
 * Un motif contenant déjà un joker est conservé ; `cd` est omis.
 */
export function generalizeBashRule(content: string): string[] {
  const c = content.trim().replace(/\s*:\*$/, ' *');
  if (c.includes('*')) return [c];
  const out: string[] = [];
  for (const segment of splitShellCommand(c)) {
    const tokens = segment.split(/\s+/);
    let i = 0;
    while (i < tokens.length - 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    const cmd = tokens[i];
    if (cmd === 'cd') continue;
    let rule: string;
    if (EXACT_ONLY.has(cmd) || /["'`$()]/.test(cmd)) rule = segment;
    else {
      const sub = tokens[i + 1];
      const words = tokens.slice(0, i + 1);
      if (SUBCOMMAND_TOOLS.has(cmd) && sub && /^[A-Za-z][\w:.-]*$/.test(sub)) words.push(sub);
      rule = `${words.join(' ')} *`;
    }
    if (!out.includes(rule)) out.push(rule);
  }
  return out.length ? out : [c];
}

/**
 * Règles proposées à la mémorisation (`Outil` ou `Outil(motif)`), à partir des suggestions du SDK, les commandes
 * Bash exactes étant généralisées par préfixe. L'humain peut les modifier avant de répondre (champ `rules` de la réponse).
 */
export function editableRules(suggestions: unknown[] | undefined | null, toolName?: string, input?: Record<string, unknown> | null): string[] {
  const out: string[] = [];
  // Commande Bash pour laquelle le SDK ne suggère rien (commande composée avec substitution `$(…)`, sous-shell…) :
  // règles déduites de ses commandes simples (`grep *`, `sed *`), pour pouvoir ne plus être sollicité en un clic.
  const hasRules = (suggestions ?? []).some((s) => (s as { type?: string })?.type === 'addRules');
  if (!hasRules && toolName === 'Bash' && typeof input?.command === 'string') {
    return generalizeBashRule(input.command)
      .filter((r) => r.endsWith(' *') && !/["'`$()<>]/.test(r))
      .map((r) => `Bash(${r})`);
  }
  for (const s of (suggestions ?? []) as Array<{ type?: string; behavior?: string; rules?: Array<{ toolName?: string; ruleContent?: string | null }> }>) {
    if (s?.type !== 'addRules' || (s.behavior ?? 'allow') !== 'allow') continue;
    for (const r of s.rules ?? []) {
      if (!r.toolName) continue;
      const rules = r.toolName === 'Bash' && r.ruleContent ? generalizeBashRule(r.ruleContent).map((c) => `Bash(${c})`) : [r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName];
      for (const rule of rules) if (!out.includes(rule)) out.push(rule);
    }
  }
  return out;
}

/** Règles saisies dans le champ d'édition, une par ligne. */
export const parseRuleLines = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** Suggestions de changement de mode (setMode) sous forme de libellés. */
export function suggestedModes(suggestions: unknown[] | undefined | null): string[] {
  return suggestedRules((suggestions ?? []).filter((s) => (s as { type?: string })?.type === 'setMode'));
}

export function suggestedRules(suggestions: unknown[] | undefined | null): string[] {
  const out: string[] = [];
  for (const s of (suggestions ?? []) as Array<{ type?: string; behavior?: string; mode?: string; rules?: Array<{ toolName?: string; ruleContent?: string | null }> }>) {
    if (s?.type === 'setMode' && s.mode) {
      out.push(s.mode === 'acceptEdits' ? 'Modifications de fichiers (Edit, Write, NotebookEdit)' : `mode « ${permissionModeLabels[s.mode] ?? s.mode} »`);
      continue;
    }
    if (s?.type !== 'addRules' || (s.behavior ?? 'allow') !== 'allow') continue;
    for (const r of s.rules ?? []) if (r.toolName) out.push(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);
  }
  return out;
}
