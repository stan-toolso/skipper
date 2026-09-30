import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { Project } from '../projects/types.js';
import * as drive from './drive.js';
import * as gmail from './gmail.js';
import { accessLabels } from './service.js';
import type { GoogleAccess, GoogleAccount } from './types.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

export interface GoogleMcpContext {
  project: Project;
  /** Comptes Google reliés au projet (au moins un). */
  accounts: GoogleAccount[];
  sessionId: string;
  /** Dossier de travail de la session : les fichiers téléchargés ou envoyés doivent s'y trouver. */
  cwd: string;
  /** Journalise un événement de session (audit des accès). */
  emit(type: string, payload?: Record<string, unknown>): Promise<void>;
}

/** Chemin local résolu dans le dossier de travail, sans en sortir. */
function localPath(cwd: string, p: string): string {
  const resolved = path.resolve(cwd, p);
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) throw new AppError(`Le chemin local doit rester dans le dossier de travail (${cwd})`);
  return resolved;
}

/**
 * Serveur MCP in-process `google` : Gmail et Drive des comptes reliés au projet. Les outils proposés
 * dépendent des accès accordés (au moins un compte doit les avoir) ; chaque outil prend l'adresse du
 * compte visé (`account`), facultative quand un seul compte convient. Le backend détient les jetons et
 * journalise chaque usage comme événement `connection` (kind gmail / drive) de la session.
 */
export function createGoogleMcpServer(ctx: GoogleMcpContext): McpSdkServerConfigWithInstance {
  const { accounts } = ctx;
  const several = accounts.length > 1;
  const describeAccount = (a: GoogleAccount) => `${a.email}${a.name ? ` (${a.name})` : ''} : Gmail ${accessLabels[a.gmailAccess]}, Drive ${accessLabels[a.driveAccess]}`;

  /** Paramètre `account` des outils : obligatoire dans les faits dès que plusieurs comptes ont l'accès voulu. */
  const accountParam = z
    .string()
    .optional()
    .describe(several ? `Adresse du compte Google à utiliser (${accounts.map((a) => a.email).join(', ')})` : `Adresse du compte Google (facultatif : ${accounts[0].email})`);

  /** Compte visé par un outil, qui doit avoir au moins le niveau d'accès demandé sur le service. */
  const pick = (email: string | undefined, service: 'gmail' | 'drive', level: Exclude<GoogleAccess, 'none'>): GoogleAccount => {
    const ok = (a: GoogleAccount) => {
      const access = service === 'gmail' ? a.gmailAccess : a.driveAccess;
      return level === 'read' ? access !== 'none' : access === 'write';
    };
    const label = `${service === 'gmail' ? 'Gmail' : 'Drive'} en ${accessLabels[level]}`;
    const eligible = accounts.filter(ok);
    if (email) {
      const account = accounts.find((a) => a.email === email.trim().toLowerCase());
      if (!account) throw new AppError(`Compte Google inconnu : ${email}. Comptes reliés au projet : ${accounts.map((a) => a.email).join(', ')}`);
      if (!ok(account)) throw new AppError(`Le compte ${account.email} n'a pas l'accès ${label}${eligible.length ? ` (comptes qui l'ont : ${eligible.map((a) => a.email).join(', ')})` : ''}`);
      return account;
    }
    if (eligible.length === 1) return eligible[0];
    throw new AppError(`Plusieurs comptes Google ont l'accès ${label} : précise lequel avec le paramètre account (${eligible.map((a) => a.email).join(', ')})`);
  };

  const run = async (fn: () => Promise<string>) => {
    try {
      return text(await fn());
    } catch (err) {
      return failure(`Erreur : ${(err as Error).message}`);
    }
  };

  /** Exécute une action en la journalisant (succès ou échec, durée). */
  const audited = async <T>(account: GoogleAccount, kind: 'gmail' | 'drive', action: string, summary: string, fn: () => Promise<{ result: T; note?: string }>): Promise<T> => {
    const started = Date.now();
    try {
      const { result, note } = await fn();
      await ctx.emit('connection', { connection: account.email, kind, action, summary, ok: true, note: note ?? null, durationMs: Date.now() - started });
      return result;
    } catch (err) {
      await ctx.emit('connection', { connection: account.email, kind, action, summary, ok: false, error: (err as Error).message, durationMs: Date.now() - started });
      throw err;
    }
  };

  // Même type que le paramètre `tools` du SDK (chaque outil a son propre schéma d'arguments).
  const tools: Array<SdkMcpToolDefinition<any>> = [
    tool('account', 'Liste les comptes Google reliés au projet et les accès accordés aux agents sur chacun.', {}, async () =>
      run(async () => accounts.map(describeAccount).join('\n')),
    ),
  ];

  if (accounts.some((a) => a.gmailAccess !== 'none')) {
    tools.push(
      tool(
        'gmail_search',
        'Cherche des messages dans la boîte Gmail du compte. La requête suit la syntaxe de recherche Gmail (from:, to:, subject:, newer_than:7d, has:attachment, label:, is:unread, "expression exacte"...). Renvoie les en-têtes et un extrait ; lis un message avec gmail_read.',
        {
          query: z.string().describe('Requête Gmail (vide = messages les plus récents)'),
          max_results: z.number().int().min(1).max(50).optional().describe('Nombre de messages (défaut 10)'),
          account: accountParam,
        },
        async ({ query, max_results, account }) =>
          run(async () => {
            const acct = pick(account, 'gmail', 'read');
            const result = await audited(acct, 'gmail', 'gmail_search', query || '(récents)', async () => {
              const r = await gmail.search(acct.id, query, max_results ?? 10);
              return { result: r, note: `${r.messages.length} message(s)` };
            });
            return gmail.renderSummaries(result);
          }),
      ),
      tool(
        'gmail_read',
        "Lit un message Gmail (en-têtes, corps en texte, liste des pièces jointes) à partir de l'identifiant renvoyé par gmail_search.",
        { message_id: z.string().describe('Identifiant du message'), account: accountParam },
        async ({ message_id, account }) =>
          run(async () => {
            const acct = pick(account, 'gmail', 'read');
            const m = await audited(acct, 'gmail', 'gmail_read', message_id, async () => {
              const r = await gmail.read(acct.id, message_id);
              return { result: r, note: r.subject.slice(0, 60) };
            });
            return gmail.renderMessage(m);
          }),
      ),
    );
  }
  if (accounts.some((a) => a.gmailAccess === 'write')) {
    tools.push(
      tool(
        'gmail_send',
        "Envoie un e-mail (texte brut) depuis un compte Google du projet, ou répond à un message existant (même fil). L'envoi est soumis à l'approbation d'un humain.",
        {
          to: z.string().optional().describe('Destinataires (séparés par des virgules) ; facultatif pour une réponse (expéditeur du message d\'origine)'),
          subject: z.string().optional().describe('Sujet ; facultatif pour une réponse ("Re: …")'),
          body: z.string().describe('Corps du message, texte brut'),
          cc: z.string().optional(),
          bcc: z.string().optional(),
          reply_to_message_id: z.string().optional().describe('Identifiant du message auquel répondre'),
          account: accountParam,
        },
        async ({ to, subject, body, cc, bcc, reply_to_message_id, account }) =>
          run(async () => {
            const acct = pick(account, 'gmail', 'write');
            const sent = await audited(acct, 'gmail', 'gmail_send', `${to ?? '(réponse)'} · ${subject ?? ''}`.trim(), async () => {
              const r = await gmail.send(acct.id, { to: to ?? '', subject: subject ?? '', body, cc, bcc, replyToMessageId: reply_to_message_id });
              return { result: r, note: `à ${r.to}` };
            });
            return `Message envoyé à ${sent.to} (sujet : ${sent.subject}, id ${sent.id}, fil ${sent.threadId}).`;
          }),
      ),
    );
  }

  if (accounts.some((a) => a.driveAccess !== 'none')) {
    tools.push(
      tool(
        'drive_search',
        "Cherche des fichiers et dossiers dans le Drive du compte (y compris les Drive partagés). Sans requête, liste le contenu d'un dossier (ou les fichiers récents).",
        {
          query: z.string().optional().describe('Mots du nom ou du contenu'),
          folder_id: z.string().optional().describe('Limiter à un dossier (identifiant)'),
          mime_type: z.string().optional().describe("Limiter à un type, ex. application/vnd.google-apps.document, application/vnd.google-apps.folder, application/pdf"),
          max_results: z.number().int().min(1).max(100).optional().describe('Nombre de résultats (défaut 20)'),
          account: accountParam,
        },
        async ({ query, folder_id, mime_type, max_results, account }) =>
          run(async () => {
            const acct = pick(account, 'drive', 'read');
            const files = await audited(acct, 'drive', 'drive_search', [query, folder_id && `dossier ${folder_id}`, mime_type].filter(Boolean).join(' · ') || '(récents)', async () => {
              const r = await drive.search(acct.id, { query, folderId: folder_id, mimeType: mime_type, maxResults: max_results ?? 20 });
              return { result: r, note: `${r.length} résultat(s)` };
            });
            return files.length ? files.map(drive.describe).join('\n') : 'Aucun fichier ne correspond.';
          }),
      ),
      tool(
        'drive_read',
        "Lit le contenu d'un fichier du Drive : Google Doc et Slides en texte, Sheet en CSV (première feuille), fichiers texte (2 Mo maximum), dossier listé. Les binaires (PDF, images…) se récupèrent avec drive_download.",
        { file_id: z.string().describe('Identifiant du fichier (drive_search ou URL Google)'), account: accountParam },
        async ({ file_id, account }) =>
          run(async () => {
            const acct = pick(account, 'drive', 'read');
            const r = await audited(acct, 'drive', 'drive_read', file_id, async () => {
              const res = await drive.readContent(acct.id, file_id);
              return { result: res, note: res.file.name.slice(0, 60) };
            });
            return `${drive.describe(r.file)}${r.note ? `\n(${r.note})` : ''}\n\n${r.content}${r.truncated ? '\n\n[contenu tronqué]' : ''}`;
          }),
      ),
      tool(
        'drive_download',
        'Télécharge un fichier du Drive dans le dossier de travail. Un document Google est exporté (Doc → docx, Sheet → xlsx, Slides → pptx par défaut ; ou pdf, txt, csv, md, html).',
        {
          file_id: z.string().describe('Identifiant du fichier'),
          local_path: z.string().describe('Chemin de destination, relatif au dossier de travail'),
          format: z.enum(['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'csv', 'md', 'html']).optional().describe("Format d'export d'un document Google"),
          account: accountParam,
        },
        async ({ file_id, local_path, format, account }) =>
          run(async () => {
            const acct = pick(account, 'drive', 'read');
            const target = localPath(ctx.cwd, local_path);
            await mkdir(path.dirname(target), { recursive: true });
            const r = await audited(acct, 'drive', 'drive_download', `${file_id} → ${local_path}`, async () => {
              const res = await drive.download(acct.id, file_id, target, format);
              return { result: res, note: `${res.bytes} octets` };
            });
            return `Fichier « ${r.file.name} » enregistré dans ${path.relative(ctx.cwd, r.localPath)} (${r.bytes} octets).`;
          }),
      ),
    );
  }
  if (accounts.some((a) => a.driveAccess === 'write')) {
    tools.push(
      tool(
        'drive_upload',
        "Dépose un fichier du dossier de travail sur le Drive (100 Mo maximum), éventuellement converti en Google Doc, Sheet ou Slides. Soumis à l'approbation d'un humain.",
        {
          local_path: z.string().describe('Chemin du fichier, relatif au dossier de travail'),
          name: z.string().optional().describe('Nom sur le Drive (défaut : nom du fichier)'),
          folder_id: z.string().optional().describe('Dossier de destination (défaut : racine « Mon Drive »)'),
          convert_to: z.enum(['document', 'spreadsheet', 'presentation']).optional().describe('Convertir en document Google'),
          account: accountParam,
        },
        async ({ local_path, name, folder_id, convert_to, account }) =>
          run(async () => {
            const acct = pick(account, 'drive', 'write');
            const source = localPath(ctx.cwd, local_path);
            const f = await audited(acct, 'drive', 'drive_upload', `${local_path} → ${name ?? path.basename(local_path)}${folder_id ? ` (dossier ${folder_id})` : ''}`, async () => ({
              result: await drive.upload(acct.id, source, { name, folderId: folder_id, convertTo: convert_to }),
            }));
            return `Fichier déposé :\n${drive.describe(f)}`;
          }),
      ),
      tool(
        'drive_write',
        "Crée un fichier sur le Drive à partir d'un texte : Google Doc (Markdown converti), Google Sheet (CSV) ou fichier texte. Avec file_id, remplace le contenu d'un fichier existant. Soumis à l'approbation d'un humain.",
        {
          name: z.string().describe('Nom du fichier'),
          content: z.string().describe('Contenu : Markdown pour un document, CSV pour une feuille, texte sinon'),
          kind: z.enum(['document', 'spreadsheet', 'text']).optional().describe('Type créé (défaut : document)'),
          folder_id: z.string().optional().describe('Dossier de destination'),
          file_id: z.string().optional().describe('Fichier existant dont remplacer le contenu'),
          account: accountParam,
        },
        async ({ name, content, kind, folder_id, file_id, account }) =>
          run(async () => {
            const acct = pick(account, 'drive', 'write');
            const r = await audited(acct, 'drive', 'drive_write', `${file_id ? `remplace ${file_id}` : `crée ${name}`} (${kind ?? 'document'})`, async () => ({
              result: await drive.write(acct.id, { name, content, kind: kind ?? 'document', folderId: folder_id, fileId: file_id }),
            }));
            return `${r.replaced ? 'Contenu remplacé' : 'Fichier créé'} :\n${drive.describe(r.file)}`;
          }),
      ),
    );
  }

  return createSdkMcpServer({
    name: 'google',
    version: '1.0.0',
    instructions: `${several ? `Comptes Google reliés au projet "${ctx.project.name}" (paramètre account de chaque outil) :\n${accounts.map((a) => `- ${describeAccount(a)}`).join('\n')}` : `Compte Google ${describeAccount(accounts[0])}, relié au projet "${ctx.project.name}".`}\nLes jetons sont gérés par le serveur : ne cherche jamais à les obtenir. Les résultats volumineux sont tronqués : affine tes requêtes.`,
    tools,
  });
}
