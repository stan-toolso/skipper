import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Project } from '../projects/types.js';
import { sessionRepository } from '../sessions/repository.js';
import { worktreePath, worktreeService } from './service.js';
import type { Worktree } from './types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

/**
 * Serveur MCP in-process `worktrees` : un agent peut lister, créer et supprimer les worktrees git
 * de son projet (un dossier par branche, à côté du checkout principal). `list` et `create` sont
 * toujours autorisés ; `delete` passe par la demande d'autorisation habituelle.
 */
export function createWorktreesMcpServer(project: Project, sessionId: string): McpSdkServerConfigWithInstance {
  const run = async (fn: () => Promise<string>) => {
    try {
      return text(await fn());
    } catch (err) {
      return failure(`Erreur : ${(err as Error).message}`);
    }
  };

  const describe = async (w: Worktree): Promise<string> => {
    const [info, sessions] = await Promise.all([worktreeService.gitInfo(project, w), sessionRepository.list({ worktreeId: w.id, status: 'running', limit: 10 })]);
    const state = info ? `${info.commit}` : 'dossier absent du disque';
    const mine = sessions.some((s) => s.id === sessionId) ? ' · c\'est le worktree de cette session' : '';
    const busy = sessions.length ? ` · ${sessions.length} session(s) en cours` : '';
    return `- ${w.name} · branche ${w.branch} · ${state}${busy}${mine}\n  ${worktreePath(project, w)}`;
  };

  return createSdkMcpServer({
    name: 'worktrees',
    version: '1.0.0',
    instructions: `Worktrees git du projet "${project.name}" : chaque worktree est un dossier séparé sur sa propre branche, à côté du checkout principal. Crée un worktree pour isoler un chantier (une branche par sujet) ou pour y lancer une autre session d'agent (outil sessions.create). Un worktree se désigne par son nom de dossier.`,
    tools: [
      tool('list', 'Liste les worktrees du projet (nom, branche, commit, sessions en cours) et la branche du dossier principal.', {}, async () =>
        run(async () => {
          if (!project.gitUrl) return "Ce projet n'est pas relié à un dépôt git : pas de worktree possible, tout se passe dans le dossier principal.";
          const worktrees = await worktreeService.listByProject(project.id);
          const lines = await Promise.all(worktrees.map(describe));
          return [`Dossier principal : branche ${project.gitBranch || 'par défaut'}`, ...(lines.length ? lines : ['Aucun worktree.'])].join('\n');
        }),
      ),
      tool(
        'create',
        'Crée un worktree : extrait la branche si elle existe (localement ou sur origin), sinon la crée depuis base_ref (défaut : HEAD du dossier principal). Renvoie le nom du worktree et son chemin.',
        {
          branch: z.string().describe('Nom de la branche, ex. feature/contact ou task/export-csv'),
          name: z.string().optional().describe('Nom du dossier (défaut : dérivé de la branche)'),
          base_ref: z.string().optional().describe("Point de départ d'une nouvelle branche : branche, tag ou commit (défaut : HEAD du dossier principal)"),
        },
        async ({ branch, name, base_ref }) =>
          run(async () => {
            const w = await worktreeService.create(project.id, { branch, name, baseRef: base_ref });
            return `Worktree créé :\n${await describe(w)}`;
          }),
      ),
      tool(
        'delete',
        'Supprime un worktree (son dossier). Refusé si des sessions y tournent encore. La branche est conservée sauf delete_branch. Les modifications non validées sont perdues.',
        { name: z.string().describe('Nom du worktree (dossier)'), delete_branch: z.boolean().optional().describe('Supprimer aussi la branche locale (défaut : false)') },
        async ({ name, delete_branch }) =>
          run(async () => {
            const w = (await worktreeService.listByProject(project.id)).find((x) => x.name === name || x.branch === name);
            if (!w) throw new Error(`Worktree "${name}" introuvable dans ce projet`);
            await worktreeService.delete(w.id, delete_branch ?? false);
            return `Worktree ${w.name} supprimé${delete_branch ? ` (branche ${w.branch} supprimée)` : ` (branche ${w.branch} conservée)`}.`;
          }),
      ),
    ],
  });
}
