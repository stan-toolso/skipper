import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Project } from '../projects/types.js';
import { contextService } from './service.js';
import type { Actor, ContextTree } from './types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

function renderTree(tree: ContextTree): string {
  if (tree.folders.length === 0 && tree.instructions.length === 0) return '(bibliothèque vide)';
  const lines: string[] = [];
  const render = (folderId: string | null, indent: string) => {
    for (const i of tree.instructions.filter((x) => x.folderId === folderId)) {
      lines.push(`${indent}📄 ${i.path}${i.description ? ` — ${i.description}` : ''} (v${i.version})`);
    }
    for (const f of tree.folders.filter((x) => x.parentId === folderId)) {
      lines.push(`${indent}📁 ${f.path}/`);
      render(f.id, `${indent}  `);
    }
  };
  render(null, '');
  return lines.join('\n');
}

/**
 * Serveur MCP in-process exposant la bibliothèque de contexte d'un projet à une session d'agent.
 * Toutes les modifications sont attribuées à la session (author agent) et versionnées.
 */
export function createContextMcpServer(project: Project, sessionId: string): McpSdkServerConfigWithInstance {
  const actor: Actor = { type: 'agent', sessionId };
  const run = async (fn: () => Promise<string>) => {
    try {
      return text(await fn());
    } catch (err) {
      return failure(`Erreur : ${(err as Error).message}`);
    }
  };

  return createSdkMcpServer({
    name: 'context',
    version: '1.0.0',
    instructions: `Bibliothèque de contexte du projet "${project.name}" : instructions durables (conventions, décisions, procédures, connaissances) rangées en dossiers. Les chemins sont de la forme "dossier/sous-dossier/nom". Consulte-la avant d'agir et enregistre-y ce qui mérite d'être retenu pour les prochaines sessions.`,
    tools: [
      tool('tree', "Liste l'arborescence complète de la bibliothèque de contexte (dossiers et instructions avec leur description).", {}, async () =>
        run(async () => renderTree(await contextService.tree(project.id))),
      ),
      tool('read', "Lit le contenu d'une instruction du contexte.", { path: z.string().describe('Chemin de l\'instruction, ex. "api/auth/regles-jwt"') }, async ({ path }) =>
        run(async () => {
          const r = await contextService.resolve(project.id, path);
          if (!r || r.kind === 'root') throw new Error(`Introuvable : ${path}`);
          if (r.kind === 'folder') return `📁 ${r.folder.path}/ est un dossier :\n${renderTree(await contextService.tree(project.id))}`;
          const i = r.instruction;
          return `# ${i.name} (${i.path}, version ${i.version})\n${i.description ? `${i.description}\n` : ''}\n${i.content}`;
        }),
      ),
      tool('search', 'Recherche des instructions par mot-clé (nom, description ou contenu).', { query: z.string() }, async ({ query }) =>
        run(async () => {
          const found = await contextService.search(project.id, query);
          return found.length ? found.map((i) => `📄 ${i.path}${i.description ? ` — ${i.description}` : ''} (v${i.version})`).join('\n') : 'Aucun résultat.';
        }),
      ),
      tool(
        'write',
        "Crée ou met à jour une instruction (contenu Markdown). Les dossiers manquants du chemin sont créés. Chaque mise à jour crée une nouvelle version.",
        {
          path: z.string().describe('Chemin de l\'instruction, ex. "conventions/tests"'),
          content: z.string().describe('Contenu complet de l\'instruction (remplace l\'existant)'),
          description: z.string().optional().describe('Résumé en une phrase (affiché dans les listes et comme description de skill)'),
          change_note: z.string().optional().describe('Note de version : ce qui change et pourquoi'),
        },
        async ({ path, content, description, change_note }) =>
          run(async () => {
            const { instruction, created } = await contextService.writeInstructionAtPath(project.id, path, { content, description, changeNote: change_note }, actor);
            return `${created ? 'Créée' : 'Mise à jour'} : ${instruction.path} (version ${instruction.version})`;
          }),
      ),
      tool('create_folder', 'Crée un dossier (et ses parents manquants).', { path: z.string() }, async ({ path }) =>
        run(async () => {
          const folder = await contextService.ensureFolderPath(project.id, path, actor);
          return folder ? `Dossier prêt : ${folder.path}/` : 'Racine';
        }),
      ),
      tool(
        'move',
        'Déplace ou renomme un dossier ou une instruction.',
        { path: z.string().describe('Chemin actuel'), new_path: z.string().describe('Nouveau chemin complet (le dernier segment devient le nouveau nom)') },
        async ({ path, new_path }) =>
          run(async () => {
            const r = await contextService.resolve(project.id, path);
            if (!r || r.kind === 'root') throw new Error(`Introuvable : ${path}`);
            const segments = new_path.split('/').map((s) => s.trim()).filter(Boolean);
            if (segments.length === 0) throw new Error('Nouveau chemin vide');
            const newName = segments[segments.length - 1];
            const parent = await contextService.ensureFolderPath(project.id, segments.slice(0, -1).join('/'), actor);
            if (r.kind === 'folder') {
              if ((parent?.id ?? null) !== r.folder.parentId) await contextService.moveFolder(r.folder.id, parent?.id ?? null, actor);
              const folder = await contextService.renameFolder(r.folder.id, newName, actor);
              return `Dossier déplacé : ${folder.path}/`;
            }
            const instruction = await contextService.updateInstruction(r.instruction.id, { name: newName, folderId: parent?.id ?? null }, actor);
            return `Instruction déplacée : ${instruction.path}`;
          }),
      ),
      tool('delete', 'Supprime une instruction ou un dossier (avec son contenu).', { path: z.string() }, async ({ path }) =>
        run(async () => {
          const r = await contextService.resolve(project.id, path);
          if (!r || r.kind === 'root') throw new Error(`Introuvable : ${path}`);
          if (r.kind === 'folder') {
            await contextService.deleteFolder(r.folder.id, actor);
            return `Dossier supprimé : ${r.folder.path}/`;
          }
          await contextService.deleteInstruction(r.instruction.id, actor);
          return `Instruction supprimée : ${r.instruction.path}`;
        }),
      ),
      tool('history', "Liste les versions d'une instruction (numéro, auteur, note, date).", { path: z.string() }, async ({ path }) =>
        run(async () => {
          const r = await contextService.resolve(project.id, path);
          if (!r || r.kind !== 'instruction') throw new Error(`Instruction introuvable : ${path}`);
          const versions = await contextService.versions(r.instruction.id);
          return versions.map((v) => `v${v.version} · ${v.createdAt.toISOString()} · ${v.authorType}${v.changeNote ? ` · ${v.changeNote}` : ''}`).join('\n');
        }),
      ),
    ],
  });
}
