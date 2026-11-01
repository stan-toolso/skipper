/** Aperçu d'une work session, tel que renvoyé par la requête `preview`. */
export interface PreviewInfo {
  worksessionId: string;
  enabled: boolean;
  status: 'STOPPED' | 'INSTALLING' | 'STARTING' | 'RUNNING' | 'FAILED';
  configured: boolean;
  configSource: string | null;
  configError: string | null;
  command: string | null;
  url: string | null;
  error: string | null;
  startedAt: string | null;
  readyAt: string | null;
  depsMode: string | null;
  installCommand: string | null;
  installMs: number | null;
  readyMs: number | null;
}

/** Durée lisible : « 850 ms », « 4,2 s », « 1 min 12 s ». */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`;
  const min = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${min} min ${s} s` : `${min} min`;
}

/** Ce qu'il est advenu des dépendances au dernier lancement. */
export function depsLabel(p: Pick<PreviewInfo, 'depsMode' | 'installCommand' | 'installMs'>): string | null {
  const installed = p.installMs !== null ? ` (${formatDuration(p.installMs)})` : '';
  if (p.depsMode === 'snapshot' && !p.installCommand) return 'dépendances liées depuis le cache, rien à installer';
  if (p.depsMode === 'nearest') return `dépendances liées depuis le cache puis complétées${installed}`;
  if (!p.installCommand) return p.depsMode && p.depsMode !== 'none' ? 'dépendances déjà à jour' : null;
  return `dépendances installées${installed}`;
}

/** Ligne de synthèse d'un aperçu prêt : « Prêt en 4,2 s · dépendances liées depuis le cache, rien à installer ». */
export function previewSummary(p: PreviewInfo): string {
  const parts = [p.readyMs !== null ? `Prêt en ${formatDuration(p.readyMs)}` : 'Prêt', depsLabel(p)];
  return parts.filter(Boolean).join(' · ');
}

/** Étape en cours, pour la barre de progression. */
export function previewStepLabel(status: PreviewInfo['status']): string {
  switch (status) {
    case 'INSTALLING':
      return 'Installation des dépendances…';
    case 'STARTING':
      return 'Démarrage du serveur de développement…';
    case 'RUNNING':
      return 'Prêt';
    case 'FAILED':
      return 'Échec';
    default:
      return 'Arrêté';
  }
}

/** Le lancement est en cours (sondage rapproché). */
export const previewBusy = (status: PreviewInfo['status'] | undefined) => status === 'INSTALLING' || status === 'STARTING';

/** Consigne envoyée à l'agent de la session pour qu'il configure l'aperçu. */
export const CONFIGURE_PREVIEW_PROMPT = [
  "Configure l'aperçu en direct de ce projet dans Skipper : crée le fichier `.skipper/preview.json` à la racine du dépôt, puis commite-le.",
  'Format : `{ "command": "…", "cwd": "sous-dossier (facultatif)", "install": "commande d\'installation (facultatif, déduite du lockfile sinon ; \\"\\" pour aucune)", "env": { "VARIABLE": "valeur non secrète" } }`.',
  "La commande lance le serveur de développement de l'application (front, ou front et API) ; il doit écouter sur 0.0.0.0 et sur le port donné par la variable `$PORT` (exemple Vite : `npx vite --host 0.0.0.0 --port $PORT --strictPort`). Si l'application a besoin d'une API locale, lance-les ensemble (ex. `npx concurrently`) et fais passer l'API par le proxy du serveur de dev, l'aperçu n'exposant que `$PORT`.",
  "Vérifie dans le terminal que la commande démarre bien (avec un PORT d'essai), puis dis-moi de cliquer sur « Lancer l'aperçu » dans l'onglet Aperçu.",
].join('\n\n');
