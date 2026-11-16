import { config } from '../config.js';
import type { Project } from '../projects/types.js';
import type { User } from '../users/types.js';
import { AGENT_KIND_LABELS, type Agent } from './types.js';

/** Lien vers la fiche d'un agent dans l'application. */
export const agentLink = (agent: Pick<Agent, 'id' | 'projectId'>) => `${config.appUrl}/projects/${agent.projectId}/agents/${agent.id}`;

/**
 * Règles de rôle ajoutées par Skipper quelles que soient les instructions de l'agent (copiées du modèle à sa création,
 * elles ne suivent pas les évolutions des modèles) : ce que le rôle ne fait jamais lui-même, et à qui il passe la main.
 * Levées quand une personne a pris la main sur la session.
 */
export function roleRulesPrompt(agent: Pick<Agent, 'kind'>, opts: GitAccess = {}): string {
  if (agent.kind === 'product_manager') {
    return [
      '\nRègles de ton rôle (Skipper) :',
      "- Tu ne modifies aucun fichier du dépôt, tu ne commites pas, tu ne pousses pas et tu n'ouvres pas de pull request (`tasks.pr_open` te sera refusé), même pour une ligne et même quand tu as trouvé le correctif : le code passe par l'agent développeur.",
      "- Dès qu'un changement de code est nécessaire, y compris un bug qui bloque ce qu'on t'a demandé (release, mise en production, vérification), crée une tâche : contexte, diagnostic, correctif proposé, critères d'acceptation, rapporteur = la personne qui t'a fait la demande. Passe-la à « prête » et confie-la tout de suite à l'agent développeur du projet (« @Nom » dans son fil, ou `agents.summon`) : ce correctif est couvert par la demande en cours, pas besoin d'un nouvel accord pour le lancer.",
      "- Relie la tâche bloquée au correctif (`depends_on`), passe son étiquette d'état à « bloquée » et dis dans son fil ce qu'on attend. Quand la PR du correctif est fusionnée, reprends là où tu t'étais arrêté.",
      "- S'il n'y a pas d'agent développeur dans le projet, décris le correctif dans la tâche et mentionne une personne du projet.",
      "- Un accord avant une mise en production ou une action sensible se demande toujours avec `tasks.request_approval` (sur la tâche de release ou la tâche concernée), jamais par un simple message ou une mention dans le fil, même si tes instructions le disent : l'outil pose une vraie demande aux administrateurs. Si la personne qui t'a demandé ce travail est administrateur, l'outil constate que son accord est déjà donné : poursuis sans attendre. Sinon termine ton tour et reprends quand la décision arrive dans le fil.",
    ].join('\n');
  }
  if (agent.kind === 'developer') {
    return [
      '\nRègles de ton rôle (Skipper) :',
      "- Tu ne mets rien en production et tu ne modifies pas la configuration des serveurs : c'est le rôle du Product Manager ou d'une personne, après accord.",
      mergeHosts(opts).length
        ? `- Ton compte ${mergeHosts(opts).join(' et ')} prêté permet la fusion : \`tasks.pr_merge\` fusionne directement avec ce compte, sans demande d'accord. Fusionne quand une personne te le demande ou quand tes instructions le prévoient (par exemple après une relecture favorable et une CI verte), jamais une PR dont la CI échoue. Cette règle prime sur une instruction plus ancienne qui t'interdirait toute fusion.`
        : "- Tu ne fusionnes jamais une pull request de ta propre initiative. Quand une personne te demande de la fusionner, utilise `tasks.pr_merge` : elle accepte la demande et la fusion est faite avec son compte, à son nom (ton compte prêté n'y sert pas). Cette règle prime sur une instruction plus ancienne qui t'interdirait toute fusion.",
    ].join('\n');
  }
  return '';
}

/**
 * Section du prompt système d'une session jouée par un agent : qui il est, ses instructions, sa mémoire (dossier du
 * contexte), et qui l'a convoqué. Placée juste après le prompt du projet, avant l'identité de la session. `takenOverBy` :
 * la personne qui a pris la main sur la session (elle prime sur les règles du rôle, ses comptes servent la session).
 */
export function agentIdentityPrompt(
  agent: Agent,
  project: Pick<Project, 'name'>,
  requestedBy: Pick<User, 'name' | 'email'> | null,
  opts: GitAccess = {},
  takenOverBy: Pick<User, 'name' | 'email'> | null = null,
): string {
  const role = AGENT_KIND_LABELS[agent.kind];
  const lines = [
    `Tu es **${agent.name}**, ${role} du projet ${project.name}${agent.description ? ` : ${agent.description}` : ''}. Tu es un membre du projet à part entière : tes sessions, tes messages dans les fils de tâches, tes commits et tes pull requests sont à ton nom (les outils signent pour toi). Les personnes du projet peuvent te convoquer en te mentionnant (« @${agent.name} ») dans le fil d'une tâche, ou en te confiant une tâche ; tu reçois alors leur message dans cette session ou dans une nouvelle.`,
    requestedBy ? `- Cette session a été demandée par ${requestedBy.name} (${requestedBy.email}) : c'est à cette personne que tu réponds d'abord.` : '',
    `- Ta fiche : ${agentLink(agent)}`,
    takenOverBy ? '' : readOnlyLine(opts),
    agent.instructions.trim() ? `\nInstructions de ${agent.name} :\n\n${agent.instructions.trim()}` : '',
    takenOverBy ? takenOverLine(agent, takenOverBy) : roleRulesPrompt(agent, opts),
  ];
  return lines.filter(Boolean).join('\n');
}

/** Paragraphe d'une session d'agent dont une personne a pris la main. */
function takenOverLine(agent: Pick<Agent, 'name'>, by: Pick<User, 'name' | 'email'>): string {
  return `\n**${by.name} (${by.email}) a pris la main sur cette session.** Tu travailles désormais avec ses comptes et ses droits (Claude, GitHub, GitLab, son coffre) au lieu de ceux de ${agent.name} : tu peux pousser, ouvrir une pull request (\`tasks.pr_open\`) ou utiliser ses éléments du coffre quand elle le demande. Ses instructions priment sur les règles de ton rôle ; tes messages restent signés ${agent.name}. Quand elle te rend la main, tu retrouves les comptes et les règles de l'agent.`;
}

/** Accès git des comptes d'une session (`OwnerAccounts`) utiles au prompt. */
type GitAccess = { githubReadOnly?: boolean; githubPullRequests?: boolean; githubMerge?: boolean; gitlabReadOnly?: boolean; gitlabPullRequests?: boolean; gitlabMerge?: boolean };

/** Hébergeurs dont le compte prêté permet de fusionner sans accord (prêt en écriture, fusion permise). */
const mergeHosts = (opts: GitAccess) => [opts.githubMerge && !opts.githubReadOnly ? 'GitHub' : null, opts.gitlabMerge && !opts.gitlabReadOnly ? 'GitLab' : null].filter((h): h is string => Boolean(h));

/**
 * Phrases sur les comptes git prêtés (GitHub, GitLab ou les deux) : en lecture seule sans pull requests (rien ne sort de
 * la session), ou avec (seul `tasks.pr_open` pousse la branche et ouvre la PR) ; en écriture avec fusion permise
 * (`tasks.pr_merge` fusionne sans demande).
 */
function readOnlyLine(opts: GitAccess): string {
  const strict = [opts.githubReadOnly && !opts.githubPullRequests ? 'GitHub' : null, opts.gitlabReadOnly && !opts.gitlabPullRequests ? 'GitLab' : null].filter(Boolean);
  const withPrs = [opts.githubReadOnly && opts.githubPullRequests ? 'GitHub' : null, opts.gitlabReadOnly && opts.gitlabPullRequests ? 'GitLab' : null].filter(Boolean);
  const which = (hosts: unknown[]) => (hosts.length === 2 ? 'Tes comptes GitHub et GitLab sont prêtés' : `Ton compte ${hosts[0]} est prêté`);
  return [
    strict.length
      ? `- ${which(strict)} en lecture seule : sur ${strict.join(' et ')}, tu peux lire et récupérer les dépôts, mais ni pousser une branche ni ouvrir de pull request (ou merge request). Laisse tes commits en local et demande dans le fil de la tâche à une personne de pousser, ou signale-le.`
      : '',
    withPrs.length
      ? `- ${which(withPrs)} en lecture seule, pull requests permises : sur ${withPrs.join(' et ')}, \`git push\` est refusé, mais tu peux ouvrir une pull request (ou merge request) avec l'outil \`tasks.pr_open\`, qui pousse ta branche de travail (jamais la branche de base) puis ouvre la PR. Commite d'abord ; pour des commits ajoutés après l'ouverture, demande dans le fil de la tâche à une personne de pousser.`
      : '',
    mergeHosts(opts).length
      ? `- ${which(mergeHosts(opts))} en écriture, fusion permise : sur ${mergeHosts(opts).join(' et ')}, tu peux pousser, ouvrir des pull requests (\`tasks.pr_open\`) et les fusionner avec \`tasks.pr_merge\`, qui fusionne directement avec ce compte, sans demander d'accord.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Paragraphe du prompt système de toute session d'un projet qui a des agents : qui ils sont et comment les
 * convoquer (mention dans un fil, outil `agents.summon`). `me` : l'agent qui joue la session, exclu de la liste.
 */
export function agentsPromptSummary(agents: Agent[], me: Agent | null): string {
  const others = agents.filter((a) => a.enabled && !a.archivedAt && a.id !== me?.id);
  if (!others.length) return '';
  const lines = others.map((a) => `- ${a.name} (${AGENT_KIND_LABELS[a.kind]}${a.description ? ` : ${a.description}` : ''}, identifiant ${a.id})`);
  return [
    `Le projet a des agents, membres du projet au même titre que les personnes${me ? ' (en plus de toi)' : ''} :`,
    ...lines,
    "Pour passer la main à l'un d'eux : mentionne-le dans le fil de la tâche (« @Nom » dans `tasks.comment`), ou convoque-le avec l'outil `agents.summon` (identifiant ou nom, instruction, tâche éventuelle) : il reçoit le message dans sa session reliée à la tâche, ou dans une nouvelle. Convoquer un agent lance ou relance une session (soumis à autorisation). Ne le fais que quand une personne l'a décidé ou que tes instructions le prévoient.",
  ].join('\n');
}

/**
 * Paragraphe du prompt système d'un chat ou d'une session d'espace personnel : les agents de tous les projets de la
 * personne, avec leur rôle et leur projet. Interpeller un agent (« @Nom », « demande à Nom ») vaut décision de le
 * convoquer : le chat lui transmet la demande et rapporte sa réponse plutôt que de chercher un projet de ce nom.
 */
export function scopedAgentsPromptSummary(agents: Agent[], projects: Pick<Project, 'id' | 'name'>[]): string {
  const active = agents.filter((a) => a.enabled && !a.archivedAt);
  if (!active.length) return '';
  const nameOf = (a: Agent) => projects.find((p) => p.id === a.projectId)?.name ?? a.projectId;
  const lines = active.map((a) => `- ${a.name} : ${AGENT_KIND_LABELS[a.kind]} du projet ${nameOf(a)}${a.description ? ` (${a.description})` : ''}, identifiant ${a.id}`);
  return [
    'Les projets de la personne ont des agents, membres de leur projet au même titre que les personnes :',
    ...lines,
    "Quand la personne s'adresse à l'un d'eux (« @Nom », « demande à Nom… ») ou que sa demande relève clairement du rôle d'un agent, convoque-le avec `agents.summon` : un message complet et autonome (il ne voit pas cette conversation), la tâche concernée s'il y en a une ; puis attends sa réponse avec `sessions.wait` sur la session renvoyée et rapporte-la (avec le lien de sa session). Un nom d'agent n'est pas un nom de projet : l'agent travaille dans son projet. Si plusieurs agents portent ce nom, précise le projet (paramètre `project`).",
  ].join('\n');
}
