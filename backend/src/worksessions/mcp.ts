import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Project } from '../projects/types.js';
import { sessionRepository } from '../sessions/repository.js';
import { removeWorksessionKeepingSessions } from '../projects/cleanup.js';
import { worksessionPath, worksessionService } from './service.js';
import type { Worksession } from './types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

/**
 * Serveur MCP in-process `worksessions` : un agent liste, crée et supprime les work sessions de son projet
 * (un dossier chacune, à côté du checkout principal ; un git worktree sur sa propre branche pour un projet
 * git). `list` et `create` sont toujours autorisés ; `delete` passe par la demande d'autorisation habituelle.
 */
export function createWorksessionsMcpServer(project: Project, sessionId: string): McpSdkServerConfigWithInstance {
  const run = async (fn: () => Promise<string>) => {
    try {
      return text(await fn());
    } catch (err) {
      return failure(`Erreur : ${(err as Error).message}`);
    }
  };

  const describe = async (w: Worksession): Promise<string> => {
    const [info, exists, sessions] = await Promise.all([worksessionService.gitInfo(project, w), worksessionService.exists(project, w), sessionRepository.list({ worksessionId: w.id, status: 'running', limit: 10 })]);
    const state = info ? info.commit : exists ? (project.gitUrl ? 'sans commit' : 'dossier présent') : 'dossier absent du disque (recréé à la prochaine session)';
    const mine = sessions.some((s) => s.id === sessionId) ? ' · work session de cette session' : '';
    const busy = sessions.length ? ` · ${sessions.length} session(s) en cours` : '';
    const label = w.label ? ` · « ${w.label} »` : '';
    const branch = project.gitUrl ? ` · branche ${w.branch}` : '';
    return `- ${w.name}${label}${branch} · ${state}${busy}${mine}\n  ${worksessionPath(project, w)}`;
  };

  return createSdkMcpServer({
    name: 'worksessions',
    version: '1.0.0',
    instructions: `Work sessions du projet "${project.name}" : chacune est un dossier séparé${project.gitUrl ? ' sur sa propre branche (git worktree), à côté du checkout principal' : ''}. Toute session d'agent travaille dans l'une d'elles. Crée une work session pour isoler un chantier${project.gitUrl ? ' (une branche par sujet)' : ''} ou pour y lancer une autre session d'agent (outil sessions.create). Une work session se désigne par son nom de dossier.`,
    tools: [
      tool('list', 'Liste les work sessions du projet (nom, libellé, branche, commit, sessions en cours).', {}, async () =>
        run(async () => {
          const worksessions = await worksessionService.listByProject(project.id);
          const lines = await Promise.all(worksessions.map(describe));
          return [...(project.gitUrl ? [`Checkout principal : branche ${project.gitBranch || 'par défaut'} (rien n'y tourne)`] : []), ...(lines.length ? lines : ['Aucune work session.'])].join('\n');
        }),
      ),
      tool(
        'create',
        `Crée une work session.${project.gitUrl ? ' Extrait la branche si elle existe (localement ou sur origin), sinon la crée depuis base_ref (défaut : HEAD du dossier principal).' : ''} Renvoie son nom et son chemin.`,
        {
          name: z.string().optional().describe('Nom du dossier (défaut : dérivé de la branche, sinon du libellé)'),
          branch: z.string().optional().describe('Branche, pour un projet git, ex. feature/contact ou task/export-csv (défaut : le nom du dossier)'),
          label: z.string().optional().describe('Ce dont parle la work session (affiché dans l\'interface)'),
          base_ref: z.string().optional().describe("Point de départ d'une nouvelle branche : branche, tag ou commit (défaut : HEAD du dossier principal)"),
        },
        async ({ name, branch, label, base_ref }) =>
          run(async () => {
            // Le dépôt distant est contacté avec le compte GitHub du propriétaire de la session.
            const ownerId = (await sessionRepository.findById(sessionId))?.ownerId ?? null;
            const w = await worksessionService.create(project.id, { branch, name, label, baseRef: base_ref }, ownerId);
            return `Work session créée :\n${await describe(w)}`;
          }),
      ),
      tool(
        'delete',
        "Supprime une work session (son dossier). Refusé si des sessions y tournent encore : termine-les d'abord (sessions.end). Ses sessions terminées sont archivées avec leur historique. La branche est conservée sauf delete_branch. Les modifications non validées sont perdues.",
        { name: z.string().describe('Nom de la work session (dossier)'), delete_branch: z.boolean().optional().describe('Supprimer aussi la branche locale (défaut : false)') },
        async ({ name, delete_branch }) =>
          run(async () => {
            const w = (await worksessionService.listByProject(project.id)).find((x) => x.name === name || x.branch === name);
            if (!w) throw new Error(`Work session "${name}" introuvable dans ce projet`);
            const { archivedSessionIds } = await removeWorksessionKeepingSessions(w.id, { deleteBranch: delete_branch ?? false });
            const kept = project.gitUrl ? (delete_branch ? ` (branche ${w.branch} supprimée)` : ` (branche ${w.branch} conservée)`) : '';
            return `Work session ${w.name} supprimée${kept}${archivedSessionIds.length ? ` ; ${archivedSessionIds.length} session(s) archivée(s) avec leur historique` : ''}.`;
          }),
      ),
    ],
  });
}
