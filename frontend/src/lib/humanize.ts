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

export function describeTool(name: string, input: Record<string, unknown> = {}): ToolDescription {
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
      if (name.startsWith('mcp__tasks__')) {
        const op = name.slice('mcp__tasks__'.length);
        const title = str(input, 'title');
        const verbs: Record<string, [string, string]> = {
          list: ['Consultation des tâches du projet', 'consulter les tâches'],
          get: ["Consultation d'une tâche", 'consulter une tâche'],
          create: [`Création de la tâche « ${title ?? ''} »`, `créer la tâche « ${title ?? ''} »`],
          update: [`Mise à jour d'une tâche${str(input, 'status') ? ` (${str(input, 'status')})` : ''}`, 'mettre à jour une tâche'],
          claim: ["Prise en charge d'une tâche", 'prendre une tâche en charge'],
        };
        const [label, action] = verbs[op] ?? [`Tâches : ${op}`, `utiliser les tâches (${op})`];
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
      if (name.startsWith('mcp__connections__')) {
        const op = name.slice('mcp__connections__'.length);
        const conn = str(input, 'connection') ?? '';
        const cmd = str(input, 'command') ?? '';
        const sql = str(input, 'sql') ?? '';
        const short = (t: string, n = 80) => (t.length > n ? `${t.slice(0, n - 3)}…` : t);
        const verbs: Record<string, [string, string | undefined, string]> = {
          list: ['Consultation des connexions du projet', undefined, 'consulter les connexions du projet'],
          ssh_run: [`Commande sur ${conn} (SSH)`, cmd, `exécuter sur ${conn} : ${short(cmd)}`],
          ssh_upload: [`Envoi de ${str(input, 'local_path') ?? ''} vers ${conn}`, str(input, 'remote_path'), `envoyer ${str(input, 'local_path') ?? 'un fichier'} vers ${conn}`],
          ssh_download: [`Récupération de ${str(input, 'remote_path') ?? ''} depuis ${conn}`, str(input, 'local_path'), `récupérer ${str(input, 'remote_path') ?? 'un fichier'} depuis ${conn}`],
          sql_query: [`Requête SQL sur ${conn}`, sql, `exécuter sur ${conn} : ${short(sql)}`],
          sql_schema: [`Schéma de ${conn}${str(input, 'table') ? ` (${str(input, 'table')})` : ''}`, undefined, `consulter le schéma de ${conn}`],
        };
        const [label, detail, action] = verbs[op] ?? [`Connexions : ${op}`, undefined, `utiliser une connexion (${op})`];
        return { label, detail, action };
      }
      const json = JSON.stringify(input);
      return { label: `Outil ${name}`, detail: json.length > 200 ? `${json.slice(0, 197)}…` : json, action: `utiliser l'outil ${name}` };
    }
  }
}

/** Titre lisible d'une demande : pour une autorisation, l'action demandée ("Autorisation de lire le fichier x"). */
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

export const permissionModeLabels: Record<string, string> = {
  default: 'Vous demande avant chaque action sensible',
  acceptEdits: 'Modifie les fichiers librement',
  plan: 'Réfléchit seulement, sans rien modifier',
  dontAsk: 'Ne demande jamais',
  bypassPermissions: 'Tout est autorisé',
};

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} min ${s} s`;
}

export function formatCost(usd: number): string {
  return `${usd.toFixed(usd < 0.1 ? 3 : 2).replace('.', ',')} $`;
}

export const sessionStatusLabels: Record<string, string> = {
  PENDING: 'Pas encore démarrée',
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
  return null;
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
};
