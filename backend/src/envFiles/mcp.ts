import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Project } from '../projects/types.js';
import { worksessionService } from '../worksessions/service.js';
import { envFileService } from './service.js';
import type { EnvApplyResult, EnvFile } from './types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

export interface EnvMcpContext {
  project: Project;
  sessionId: string;
  /** Personne qui pilote la session : sa portée du coffre résout les références. */
  ownerId: string | null;
  /** Dossier de travail de la session (null : session d'avant les work sessions, rien n'y est écrit). */
  worksessionId: string | null;
}

function describeApply(r: EnvApplyResult): string {
  const lines: string[] = [];
  if (r.written.length) lines.push(`Écrit dans ton dossier de travail : ${r.written.join(', ')}`);
  for (const s of r.skipped) lines.push(`Non écrit — ${s}`);
  for (const p of r.problems) lines.push(`Référence non résolue (valeur vide) — ${p}`);
  return lines.join('\n') || 'Rien à écrire.';
}

function describeFile(f: EnvFile): string {
  const keys = envFileService.keys(f);
  const lines = f.content.split('\n').length;
  return `${f.path} · ${envFileService.isDotenv(f) ? `${keys.length} clé(s)` : `${lines} ligne(s), fichier libre`} · ${f.applyOnCreate ? 'importé à la création des sessions' : 'non importé à la création'}`;
}

/**
 * Serveur MCP `env` : fichiers d'environnement du projet (envFiles/). Lister, lire les clés (références au coffre
 * affichées comme références, jamais résolues), ajouter, modifier ou retirer une clé pour tout le projet, réécrire
 * les fichiers dans le dossier de travail de la session.
 */
export function createEnvMcpServer(ctx: EnvMcpContext): McpSdkServerConfigWithInstance {
  const actor = { userId: ctx.ownerId, sessionId: ctx.sessionId };
  const run = async (fn: () => Promise<string>) => {
    try {
      return text(await fn());
    } catch (err) {
      return failure(`Erreur : ${(err as Error).message}`);
    }
  };
  const worksession = async () => (ctx.worksessionId ? worksessionService.assertUsable(ctx.project, ctx.worksessionId) : null);

  return createSdkMcpServer({
    name: 'env',
    version: '1.0.0',
    instructions: `Fichiers d'environnement du projet "${ctx.project.name}" (.env ou autres), écrits dans chaque nouveau dossier de travail avec des valeurs du coffre ({{vault:élément.champ}}). Consulte les clés, ajoute-en, réécris les fichiers dans ton dossier de travail. Ne commite jamais ces fichiers.`,
    tools: [
      tool('list', "Liste les fichiers d'environnement du projet (chemin, nombre de clés, import à la création).", {}, async () =>
        run(async () => {
          const files = await envFileService.list(ctx.project.id);
          return files.length ? files.map(describeFile).join('\n') : "Aucun fichier d'environnement dans ce projet (env.set en crée un).";
        }),
      ),
      tool(
        'keys',
        "Clés d'un fichier dotenv du projet, avec leur source : valeur écrite dans le modèle, ou référence au coffre {{vault:élément.champ}} (la valeur d'un secret n'est pas affichée ; elle est dans le fichier de ton dossier de travail). Pour un fichier libre, renvoie son modèle.",
        { path: z.string().describe('Chemin du fichier, ex. ".env" ou "backend/.env"') },
        async ({ path }) =>
          run(async () => {
            const file = await envFileService.byPath(ctx.project.id, path);
            const problems = await envFileService.problems(file, ctx.project.id, ctx.ownerId);
            const notes = problems.length ? `\n\nRéférences non résolues :\n${problems.map((p) => `- ${p}`).join('\n')}` : '';
            if (!envFileService.isDotenv(file)) return `${file.path} (fichier libre, modèle) :\n${file.content}${notes}`;
            const keys = envFileService.keys(file);
            if (!keys.length) return `${file.path} : aucune clé.${notes}`;
            return `${file.path} :\n${keys.map((k) => `${k.key} = ${k.value}${k.refs.length ? '  (coffre)' : ''}`).join('\n')}${notes}`;
          }),
      ),
      tool(
        'set',
        "Ajoute ou modifie une clé d'un fichier dotenv du projet (créé s'il n'existe pas), pour toutes les futures sessions, et la met à jour dans le fichier de ton dossier de travail. La valeur peut être une référence au coffre {{vault:élément.champ}} (élément utilisable dans les fichiers d'environnement).",
        {
          path: z.string().describe('Chemin du fichier, ex. ".env"'),
          key: z.string().describe('Nom de la clé, ex. "DATABASE_URL"'),
          value: z.string().describe('Valeur, ou référence {{vault:élément.champ}}'),
        },
        async ({ path, key, value }) =>
          run(async () => {
            const file = await envFileService.setKey(ctx.project.id, path, key, value, actor);
            const problems = await envFileService.problems({ content: value }, ctx.project.id, ctx.ownerId);
            const ws = await worksession();
            const applied = ws ? describeApply(await envFileService.applyKey(ctx.project, ws, ctx.ownerId, file, key.trim(), ctx.sessionId)) : 'Pas de dossier de travail : rien écrit sur disque.';
            return [`${key.trim()} enregistrée dans ${file.path} (projet).`, applied, ...problems.map((p) => `Attention — ${p}`)].join('\n');
          }),
      ),
      tool(
        'unset',
        "Retire une clé d'un fichier dotenv du projet (pour les futures sessions) et du fichier de ton dossier de travail.",
        { path: z.string().describe('Chemin du fichier, ex. ".env"'), key: z.string().describe('Nom de la clé') },
        async ({ path, key }) =>
          run(async () => {
            const file = await envFileService.unsetKey(ctx.project.id, path, key, actor);
            const ws = await worksession();
            const applied = ws ? describeApply(await envFileService.applyKey(ctx.project, ws, ctx.ownerId, file, key.trim(), ctx.sessionId)) : '';
            return [`${key.trim()} retirée de ${file.path} (projet).`, applied].filter(Boolean).join('\n');
          }),
      ),
      tool(
        'apply',
        "Réécrit les fichiers d'environnement du projet dans ton dossier de travail (valeurs du coffre à jour), en remplaçant les fichiers présents.",
        { paths: z.array(z.string()).optional().describe('Fichiers à réécrire ; absent : tous') },
        async ({ paths }) =>
          run(async () => {
            const ws = await worksession();
            if (!ws) throw new Error("Cette session n'a pas de dossier de travail à elle");
            return describeApply(await envFileService.apply(ctx.project, ws, ctx.ownerId, { onlyPaths: paths ?? null, overwrite: true, sessionId: ctx.sessionId }));
          }),
      ),
    ],
  });
}
