import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { Project } from '../projects/types.js';
import { contextRepository } from './repository.js';

/**
 * Dossier du plugin Claude Code généré pour une bibliothèque (hors workspace, pour ne pas polluer le dépôt) : celle du
 * projet (`.context-plugins/<slug>`), ou la bibliothèque propre d'un agent (`.context-plugins/<slug>/agents/<id>`).
 */
export function contextPluginDir(project: Pick<Project, 'slug'>, agentId: string | null = null): string {
  const base = path.join(config.workspacesRoot, '.context-plugins', project.slug);
  return agentId ? path.join(base, 'agents', agentId) : base;
}

/**
 * Matérialise une bibliothèque de contexte sous forme de plugin Claude Code : une skill par instruction
 * (`skills/<chemin-avec-tirets>/SKILL.md`). Le plugin est passé aux sessions Claude via l'option `plugins` du SDK ;
 * les skills apparaissent comme `context:<nom>` (bibliothèque du projet) ou `memoire:<nom>` (bibliothèque propre de
 * l'agent qui joue la session).
 */
export function materializeSkills(project: Project, agentId: string | null = null): Promise<string> {
  // Une génération à la fois par dossier dans cette instance : deux sessions qui démarrent ensemble (ou une session et
  // l'écriture d'une instruction) se suivent au lieu d'effacer le dossier l'une sous l'autre (ENOTEMPTY sur rmdir).
  const dir = contextPluginDir(project, agentId);
  const previous = pending.get(dir) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => generate(project, agentId, dir));
  const tail = run.catch(() => undefined);
  pending.set(dir, tail);
  void tail.then(() => {
    if (pending.get(dir) === tail) pending.delete(dir);
  });
  return run;
}

const pending = new Map<string, Promise<unknown>>();

async function generate(project: Project, agentId: string | null, dir: string): Promise<string> {
  // Le nouveau jeu de skills est écrit à part puis mis en place par renommage : une autre instance (bleu/vert) qui
  // génère en même temps ne voit jamais un dossier à moitié vidé, et une session déjà lancée ne lit pas un dossier vide.
  const skillsDir = path.join(dir, 'skills');
  const token = randomUUID().slice(0, 8);
  const buildDir = path.join(dir, `.skills-${token}.tmp`);
  await mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
  await mkdir(buildDir, { recursive: true });
  try {
    await writeSkills(project, agentId, dir, buildDir);
    const oldDir = path.join(dir, `.skills-${token}.old`);
    await rename(skillsDir, oldDir).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
    await rename(buildDir, skillsDir);
    await rm(oldDir, { recursive: true, force: true });
  } catch (err) {
    await rm(buildDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  await removeLeftovers(dir);
  return dir;
}

/** Restes d'une génération interrompue (processus arrêté entre deux renommages) : on les retire au passage. */
async function removeLeftovers(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const stale = entries.filter((name) => /^\.skills-[0-9a-f]{8}\.old$/.test(name));
  await Promise.all(stale.map((name) => rm(path.join(dir, name), { recursive: true, force: true }).catch(() => undefined)));
}

async function writeSkills(project: Project, agentId: string | null, dir: string, skillsDir: string): Promise<void> {
  await writeFile(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: agentId ? 'memoire' : 'context', version: '1.0.0', description: agentId ? `Bibliothèque de contexte propre de l'agent (projet ${project.name})` : `Bibliothèque de contexte du projet ${project.name}` }, null, 2),
  );

  const [folders, instructions] = await Promise.all([contextRepository.listFolders(project.id, agentId), contextRepository.listInstructions(project.id, agentId)]);
  const byId = new Map(folders.map((f) => [f.id, f]));
  const folderPath = (id: string | null): string[] => {
    const f = id ? byId.get(id) : undefined;
    return f ? [...folderPath(f.parentId), f.slug] : [];
  };

  for (const instruction of instructions) {
    const parts = [...folderPath(instruction.folderId), instruction.slug];
    const skillName = parts.join('--').slice(0, 64).replace(/-+$/, '');
    const skillDir = path.join(skillsDir, skillName);
    await mkdir(skillDir, { recursive: true });
    const description = (instruction.description || instruction.content.split('\n').find((l) => l.trim()) || instruction.name).slice(0, 200);
    const frontmatter = [
      '---',
      `name: ${skillName}`,
      `description: ${JSON.stringify(`${description} (${agentId ? 'mémoire' : 'contexte'} ${parts.join('/')}, v${instruction.version})`)}`,
      '---',
      '',
    ].join('\n');
    await writeFile(path.join(skillDir, 'SKILL.md'), `${frontmatter}${instruction.content}\n`);
  }
}
