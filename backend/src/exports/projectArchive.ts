import { AppError } from '../errors.js';
import { packTarGz, unpackTarGz, type TarEntry } from './tar.js';

/**
 * Archive d'un projet (tar.gz) : son contexte (dossiers, instructions et toutes leurs versions), ses tâches (avec leur
 * fil), ses connexions sans leurs secrets et ses réglages. Ce module est pur : il met en forme les données lues par
 * `service.ts` et relit une archive pour l'import. Les fichiers JSON font foi ; les instructions sont aussi écrites en
 * Markdown (`context/<chemin>.md`) pour être lues sans Skipper.
 */

export const EXPORT_FORMAT = 'skipper-project-export';
export const EXPORT_VERSION = 1;

export interface ExportedProject {
  name: string;
  slug: string;
  description: string | null;
  systemPrompt: string;
  gitUrl: string | null;
  gitBranch: string | null;
  gitHosted: boolean;
  runnerConfig: Record<string, unknown>;
  defaultPermissionMode: string;
  taskInstructions: string;
  permissionRules: { toolName: string; ruleContent: string | null }[];
  /** Fichiers d'environnement : chemins et clés, avec leurs références au coffre ; jamais les valeurs. */
  envFiles: { path: string; applyOnCreate: boolean; keys: { key: string; vaultRefs: string[] }[] }[];
  /** Cockpit : onglets du projet, pages personnalisées et agencements partagés (tableau de bord, pilotage, pages) ; absents dans une archive d'avant. */
  tabs?: { hidden: string[]; order: string[] };
  pages?: { slug: string; title: string; icon: string | null; position: number }[];
  /** Agencements par portée relative (`project`, `tasks`, `page:<slug>`) : les blocs artefacts ne sont pas exportés (identifiants d'un autre serveur). */
  layouts?: { scope: string; layout: unknown }[];
}

export interface ExportedFolder {
  path: string;
  name: string;
}

export interface ExportedVersion {
  version: number;
  name: string;
  description: string;
  content: string;
  changeNote: string | null;
  authorType: 'human' | 'agent';
  createdAt: string;
}

export interface ExportedInstruction {
  path: string;
  name: string;
  description: string;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Toutes les versions, de la plus ancienne à la plus récente. */
  versions: ExportedVersion[];
}

export interface ExportedComment {
  /** Identifiant dans le projet d'origine, pour relier les réponses à leur message (`parentRef`). */
  ref: string;
  parentRef: string | null;
  authorType: 'human' | 'agent';
  authorName: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExportedTask {
  ref: string;
  title: string;
  /** Absent des archives d'avant le résumé des tâches. */
  summary?: string | null;
  description: string;
  status: 'todo' | 'in_progress' | 'done' | 'cancelled';
  statusTag: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  tags: string[];
  dueDate: string | null;
  customFields: { key: string; value: string }[];
  assignee: { name: string | null; email: string | null } | null;
  reporter: { name: string | null; email: string | null } | null;
  branch: string | null;
  createdByType: 'human' | 'agent';
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** Absents des archives antérieures à ces colonnes. */
  startedAt?: string | null;
  cancelledAt?: string | null;
  comments: ExportedComment[];
  /** Fichiers joints (nom, type, taille) : signalés, pas inclus dans l'archive. */
  attachments: { name: string; mediaType: string; size: number }[];
}

export interface ExportedConnection {
  name: string;
  kind: string;
  description: string;
  /** Réglages sans secrets (champs secrets vidés, identifiants retirés des adresses). */
  settings: Record<string, unknown>;
  readOnly: boolean;
  requireApproval: boolean;
  envExport: boolean;
  commandAllowlist: string[];
  publicKey: string | null;
}

export interface ProjectExport {
  exportedAt: string;
  project: ExportedProject;
  context: { folders: ExportedFolder[]; instructions: ExportedInstruction[] };
  tasks: ExportedTask[];
  connections: ExportedConnection[];
}

/** Retire l'utilisateur et le mot de passe d'une adresse (`https://jeton@github.com/...`). */
export function stripCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url.replace(/\/\/[^/@\s]+@/, '//');
  }
}

const URL_KEYS = new Set(['url', 'baseUrl', 'host', 'startUrl']);

/**
 * Réglages d'un élément du coffre sans rien de secret : les secrets sont chiffrés à part et jamais lus ici, mais un
 * champ marqué secret pourrait garder une valeur, et une adresse porter un identifiant.
 */
export function sanitizeSettings(settings: Record<string, unknown>, itemNames: Map<string, string> = new Map()): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'fields' && Array.isArray(value)) {
      out.fields = value.map((f) => (f && typeof f === 'object' && (f as { secret?: unknown }).secret ? { ...(f as object), value: null } : f));
    } else if (key === 'viaItemId') {
      // Tunnel par un autre élément : désigné par son nom, l'identifiant n'a pas de sens ailleurs.
      out.via = typeof value === 'string' ? (itemNames.get(value) ?? null) : null;
    } else if (URL_KEYS.has(key) && typeof value === 'string') {
      out[key] = stripCredentials(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

const statusLabels: Record<string, string> = { todo: 'à faire', in_progress: 'en cours', done: 'terminée', cancelled: 'annulée' };

/** Instruction rendue en Markdown lisible : titre, description et contenu actuel. */
function instructionMarkdown(i: ExportedInstruction): string {
  return [`# ${i.name}`, '', ...(i.description ? [`> ${i.description.replace(/\n/g, '\n> ')}`, ''] : []), `_Version ${i.version}, ${i.updatedAt.slice(0, 10)}_`, '', i.content.replace(/\s+$/, ''), ''].join('\n');
}

function readme(data: ProjectExport): string {
  const open = data.tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress').length;
  return [
    `# Export du projet « ${data.project.name} »`,
    '',
    `Exporté de Skipper le ${data.exportedAt.slice(0, 10)}.`,
    '',
    `- \`manifest.json\` : format de l'archive (${EXPORT_FORMAT}, version ${EXPORT_VERSION})`,
    '- `project.json` : réglages du projet (prompt système, consignes des tâches, autorisations, fichiers d\'environnement sans leurs valeurs)',
    `- \`context/library.json\` : bibliothèque de contexte, ${data.context.folders.length} dossier(s) et ${data.context.instructions.length} instruction(s) avec toutes leurs versions ; \`context/**/*.md\` : leur contenu actuel, lisible tel quel`,
    `- \`tasks.json\` : ${data.tasks.length} tâche(s) (dont ${open} ouverte(s)) avec leur fil de discussion ; les fichiers joints sont listés, pas inclus`,
    `- \`connections.json\` : ${data.connections.length} connexion(s) du coffre, **sans leurs secrets** (à ressaisir après un import)`,
    '',
    'Pour importer : page de modification d\'un projet › « Importer une archive » (contexte, tâches, réglages).',
    '',
  ].join('\n');
}

function tasksMarkdown(tasks: ExportedTask[]): string {
  const lines = ['# Tâches', ''];
  for (const t of tasks) {
    lines.push(`## ${t.title}`, '', `- Statut : ${statusLabels[t.status] ?? t.status}${t.statusTag ? ` (${t.statusTag})` : ''} · priorité ${t.priority}${t.tags.length ? ` · ${t.tags.join(', ')}` : ''}`, `- Créée le ${t.createdAt.slice(0, 10)}${t.assignee ? ` · responsable : ${t.assignee.name ?? t.assignee.email}` : ''}`, '');
    if (t.summary?.trim()) lines.push(`> ${t.summary.trim().replace(/\n/g, '\n> ')}`, '');
    if (t.description.trim()) lines.push(t.description.trim(), '');
    for (const c of t.comments) lines.push(`${c.parentRef ? '  ' : ''}- **${c.authorName}** (${c.createdAt.slice(0, 16).replace('T', ' ')}) : ${c.body.replace(/\n/g, ' ')}`);
    if (t.comments.length) lines.push('');
  }
  return lines.join('\n');
}

/** Racine de l'archive : un dossier au nom du projet, comme le ferait `tar czf slug.tar.gz slug/`. */
export function buildProjectArchive(data: ProjectExport): Buffer {
  const root = data.project.slug || 'projet';
  const entries: TarEntry[] = [
    { name: `${root}/README.md`, content: Buffer.from(readme(data), 'utf8') },
    { name: `${root}/manifest.json`, content: json({ format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: data.exportedAt, project: { name: data.project.name, slug: data.project.slug } }) },
    { name: `${root}/project.json`, content: json(data.project) },
    { name: `${root}/context/library.json`, content: json(data.context) },
    ...data.context.instructions.map((i) => ({ name: `${root}/context/${i.path}.md`, content: Buffer.from(instructionMarkdown(i), 'utf8') })),
    { name: `${root}/tasks.json`, content: json(data.tasks) },
    { name: `${root}/tasks.md`, content: Buffer.from(tasksMarkdown(data.tasks), 'utf8') },
    { name: `${root}/connections.json`, content: json(data.connections) },
  ];
  return packTarGz(entries, new Date(data.exportedAt));
}

/** Contenu relu d'une archive : seules les parties présentes sont renseignées. */
export interface ParsedArchive {
  project: ExportedProject | null;
  context: { folders: ExportedFolder[]; instructions: ExportedInstruction[] } | null;
  tasks: ExportedTask[] | null;
  connections: ExportedConnection[] | null;
}

function parseJson<T>(entry: TarEntry | undefined, what: string): T | null {
  if (!entry) return null;
  try {
    return JSON.parse(entry.content.toString('utf8')) as T;
  } catch {
    throw new AppError(`Archive invalide : ${what} illisible`);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Relit une archive produite par `buildProjectArchive` (ou réempaquetée à la main, avec ou sans dossier racine). */
export function parseProjectArchive(archive: Buffer): ParsedArchive {
  let entries: TarEntry[];
  try {
    entries = unpackTarGz(archive);
  } catch (err) {
    throw new AppError(`Archive illisible : ${(err as Error).message}`);
  }
  // Chemins relatifs à la racine de l'archive, qu'elle ait un dossier de tête ou non.
  const manifest = entries.find((e) => /(^|\/)manifest\.json$/.test(e.name) && e.name.split('/').length <= 2);
  if (!manifest) throw new AppError("Ce n'est pas un export de projet Skipper (manifest.json absent)");
  const prefix = manifest.name.slice(0, manifest.name.length - 'manifest.json'.length);
  const byName = new Map(entries.filter((e) => e.name.startsWith(prefix)).map((e) => [e.name.slice(prefix.length), e]));
  const meta = parseJson<{ format?: unknown; version?: unknown }>(manifest, 'manifest.json');
  if (!isObject(meta) || meta.format !== EXPORT_FORMAT) throw new AppError("Ce n'est pas un export de projet Skipper");
  if (typeof meta.version !== 'number' || meta.version > EXPORT_VERSION) throw new AppError("Cette archive vient d'une version plus récente de Skipper");
  const context = parseJson<ParsedArchive['context']>(byName.get('context/library.json'), 'context/library.json');
  if (context && (!Array.isArray(context.folders) || !Array.isArray(context.instructions))) throw new AppError('Archive invalide : context/library.json');
  const tasks = parseJson<ExportedTask[]>(byName.get('tasks.json'), 'tasks.json');
  if (tasks && !Array.isArray(tasks)) throw new AppError('Archive invalide : tasks.json');
  const connections = parseJson<ExportedConnection[]>(byName.get('connections.json'), 'connections.json');
  const project = parseJson<ExportedProject>(byName.get('project.json'), 'project.json');
  return { project: isObject(project) ? project : null, context, tasks, connections: Array.isArray(connections) ? connections : null };
}
