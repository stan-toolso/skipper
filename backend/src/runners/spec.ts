/**
 * Configuration d'un conteneur de projet : ce avec quoi il a été créé (label `skipper.spec`, posé par
 * `docker run`) comparé à ce que le code attend aujourd'hui. Fonctions pures, sans Docker : testées à part.
 */

/** Label posé sur le conteneur à sa création : JSON d'un `ContainerSpec`. */
export const SPEC_LABEL = 'skipper.spec';

/** Paramètres de création d'un conteneur, dont dérivent les arguments de `docker run`. */
export interface ContainerSpec {
  /** Image (nom:tag). */
  image: string;
  /** Identifiant de l'image (sha256) au moment de la création ; change à chaque reconstruction. null : image absente localement. */
  imageId: string | null;
  /** Processus init (`--init`) : récolte les processus orphelins et terminés. */
  init: boolean;
  memory: string;
  /** Plafond CPU (`--cpus`) ; chaîne vide : aucun. */
  cpus: string;
  user: string;
  home: string;
  workdir: string;
  restart: string;
  /** Montages `hôte:conteneur[:ro]`. */
  mounts: string[];
  tmpfs: string[];
  hosts: string[];
  command: string[];
}

/** Ce que `docker inspect` dit d'un conteneur existant. */
export interface ContainerFacts {
  /** Valeur du label `skipper.spec`, null s'il n'en a pas (créé avant le suivi de la configuration). */
  specLabel: string | null;
  /** `HostConfig.Init` : true, false, ou null quand le conteneur a été créé sans l'option. */
  init: boolean | null;
  /** Identifiant de l'image dont le conteneur a été créé. */
  imageId: string | null;
}

export interface ImageInfo {
  id: string;
  createdAt: Date | null;
}

const fmtDate = (d: Date | null) => (d ? d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: process.env.TZ || 'Europe/Paris' }) : 'date inconnue');

/** Chemin du conteneur d'un montage ou d'un tmpfs, avec le dossier personnel abrégé en `~`. */
function mountTarget(entry: string, home: string): string {
  const parts = entry.split(':');
  const target = parts.length >= 2 ? parts[1] : parts[0].split(',')[0];
  return target === home ? '~' : target.startsWith(`${home}/`) ? `~${target.slice(home.length)}` : target;
}

function listDiff(before: string[], after: string[], label: string, home: string): string[] {
  const reasons: string[] = [];
  for (const m of after) if (!before.includes(m)) reasons.push(`${label} ${mountTarget(m, home)} ajouté`);
  for (const m of before) if (!after.includes(m)) reasons.push(`${label} ${mountTarget(m, home)} retiré`);
  return reasons;
}

/**
 * Raisons pour lesquelles le conteneur ne correspond plus à la configuration attendue (vide : à jour).
 * `image` : l'image attendue telle qu'elle existe localement (null si absente : on ne peut pas juger de sa fraîcheur).
 */
export function containerDrift(expected: ContainerSpec, actual: ContainerFacts, image: ImageInfo | null): string[] {
  const reasons: string[] = [];
  const imageRebuilt = image && actual.imageId && actual.imageId !== image.id;
  if (actual.specLabel === null) {
    reasons.push('conteneur créé avant le suivi de sa configuration');
    if (expected.init && actual.init !== true) reasons.push('option --init absente (les processus terminés ne sont pas récoltés : zombies)');
    if (imageRebuilt) reasons.push(`image reconstruite le ${fmtDate(image.createdAt)}`);
    return reasons;
  }
  let recorded: Partial<ContainerSpec>;
  try {
    recorded = JSON.parse(actual.specLabel) as Partial<ContainerSpec>;
    if (!recorded || typeof recorded !== 'object') throw new Error('not an object');
  } catch {
    return ['configuration enregistrée sur le conteneur illisible'];
  }
  if (recorded.image !== expected.image) reasons.push(`image ${recorded.image ?? '?'} → ${expected.image}`);
  else if (image && recorded.imageId && recorded.imageId !== image.id) reasons.push(`image reconstruite le ${fmtDate(image.createdAt)}`);
  if (!!recorded.init !== expected.init) reasons.push(expected.init ? 'option --init ajoutée' : 'option --init retirée');
  if (recorded.memory !== expected.memory) reasons.push(`limite mémoire ${recorded.memory ?? '?'} → ${expected.memory}`);
  if ((recorded.cpus ?? '') !== expected.cpus) reasons.push(`plafond CPU ${recorded.cpus || 'aucun'} → ${expected.cpus || 'aucun'}`);
  reasons.push(...listDiff(recorded.mounts ?? [], expected.mounts, 'montage', expected.home));
  reasons.push(...listDiff(recorded.tmpfs ?? [], expected.tmpfs, 'tmpfs', expected.home));
  const simple: Record<string, string> = { user: 'utilisateur', home: 'dossier personnel', workdir: 'dossier de travail', restart: 'politique de redémarrage', hosts: 'hôtes supplémentaires', command: 'commande' };
  for (const key of Object.keys(simple) as (keyof typeof simple & keyof ContainerSpec)[]) {
    if (JSON.stringify(recorded[key] ?? null) !== JSON.stringify(expected[key])) reasons.push(`${simple[key]} modifié`);
  }
  // Paramètre ajouté au code et inconnu du conteneur (ou l'inverse) : signalé sans détail.
  const known = new Set(['image', 'imageId', 'init', 'memory', 'cpus', 'mounts', 'tmpfs', ...Object.keys(simple)]);
  for (const key of new Set([...Object.keys(recorded), ...Object.keys(expected)])) {
    if (known.has(key)) continue;
    if (JSON.stringify((recorded as Record<string, unknown>)[key] ?? null) !== JSON.stringify((expected as unknown as Record<string, unknown>)[key] ?? null)) reasons.push(`paramètre « ${key} » modifié`);
  }
  return reasons;
}

/** Arguments `--cpus` de `docker run` ; aucun plafond quand la valeur est vide. */
export function cpusArgs(cpus: string): string[] {
  return cpus ? ['--cpus', cpus] : [];
}

/**
 * Nombre de processus zombies (état `Z`, terminés mais pas récoltés) dans la sortie de
 * `docker top <conteneur> -o pid,stat` (en-tête puis une ligne par processus).
 */
export function countZombies(topOutput: string): number {
  return topOutput
    .split('\n')
    .slice(1)
    .filter((line) => /^\s*\d+\s+Z/.test(line)).length;
}

/**
 * Découpe la sortie de `docker inspect --format` composée de champs séparés par `|`, le dernier (label JSON)
 * pouvant lui-même contenir des `|`. `<nil>` et `<no value>` deviennent null.
 */
export function splitInspect(output: string, fields: number): (string | null)[] {
  const parts = output.replace(/\n$/, '').split('|');
  const head = parts.slice(0, fields - 1);
  const tail = parts.slice(fields - 1).join('|');
  return [...head, tail].map((v) => (v === '<nil>' || v === '<no value>' || v === '' ? null : v));
}
