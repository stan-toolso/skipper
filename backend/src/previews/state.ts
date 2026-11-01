/**
 * État d'un aperçu, déduit des événements que le script de lancement (et le backend) ajoutent au fichier `events` du
 * dossier d'état : une ligne `<horodatage ms> <événement> [argument]` par étape. Fonctions pures, testées.
 */

export type PreviewStatus = 'STOPPED' | 'INSTALLING' | 'STARTING' | 'RUNNING' | 'FAILED';

export interface PreviewEvent {
  at: number;
  name: string;
  arg: string;
}

export function parseEvents(text: string): PreviewEvent[] {
  const out: PreviewEvent[] = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d{10,})\s+(\S+)(?:\s+(.*))?$/);
    if (m) out.push({ at: Number(m[1]), name: m[2], arg: m[3]?.trim() ?? '' });
  }
  return out;
}

export interface DerivedState {
  status: PreviewStatus;
  error: string | null;
  /** Début du lancement (événement `begin`). */
  startedAt: Date | null;
  /** Première réponse du serveur sur son port (événement `ready`, posé par le backend). */
  readyAt: Date | null;
  /** Durée de l'installation des dépendances, si elle a eu lieu et s'est terminée. */
  installMs: number | null;
}

/**
 * Statut d'après les événements, la vie du processus (`alive`) et l'ouverture du port (`portOpen`). Un processus
 * disparu sans événement de fin (conteneur recréé, serveur redémarré) rend l'aperçu arrêté, avec une explication.
 */
export function deriveState(events: PreviewEvent[], alive: boolean, portOpen: boolean): DerivedState {
  const lastBegin = events.map((e) => e.name).lastIndexOf('begin');
  const run = lastBegin >= 0 ? events.slice(lastBegin) : [];
  const find = (name: string) => run.find((e) => e.name === name) ?? null;
  const begin = find('begin');
  const installing = find('installing');
  const installed = find('installed');
  const ready = find('ready');
  const base: DerivedState = {
    status: 'STOPPED',
    error: null,
    startedAt: begin ? new Date(begin.at) : null,
    readyAt: ready ? new Date(ready.at) : null,
    installMs: installing && installed ? installed.at - installing.at : null,
  };
  const last = [...run].reverse().find((e) => e.name !== 'ready') ?? null;
  if (!last) return base;
  switch (last.name) {
    case 'stopped':
      return { ...base, status: 'STOPPED' };
    case 'failed':
      return { ...base, status: 'FAILED', error: failureMessage(last.arg) };
    case 'exited':
      return { ...base, status: 'FAILED', error: `Le serveur de développement s'est arrêté (code ${last.arg || '?'}) : voir le journal` };
    default:
      if (!alive) return { ...base, status: 'STOPPED', error: "Le processus de l'aperçu n'existe plus (environnement recréé ou redémarré) : relancez-le" };
      if (last.name === 'installing') return { ...base, status: 'INSTALLING' };
      if (last.name === 'starting' || last.name === 'installed') return { ...base, status: portOpen ? 'RUNNING' : 'STARTING' };
      return { ...base, status: 'STARTING' };
  }
}

function failureMessage(arg: string): string {
  const [what, code] = arg.split(/\s+/);
  if (what === 'install') return `L'installation des dépendances a échoué (code ${code ?? '?'}) : voir le journal`;
  if (what === 'cwd') return "Le dossier de la commande d'aperçu n'existe pas";
  return arg || "L'aperçu a échoué";
}
