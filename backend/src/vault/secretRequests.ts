import { AppError } from '../errors.js';
import { REQUEST_SETTLED, requestService } from '../requests/service.js';
import type { HumanRequest } from '../requests/types.js';
import { sessionRepository } from '../sessions/repository.js';
import { userService } from '../users/service.js';
import { vaultService } from './service.js';
import type { SecretSettings, VaultFieldInput, VaultItem } from './types.js';
import { validateFieldKey } from './website.js';

/**
 * Demande de secrets (outil `vault.request_secrets`) : l'agent demande à une personne de saisir un ou plusieurs
 * secrets dans une modale ; les valeurs vont directement dans un élément « secret » du coffre (créé ou mis à jour)
 * sans jamais passer par l'agent, ni par la table des demandes, ni par le transcript. La réponse de la demande ne
 * porte que le nom de l'élément et les clés des champs. L'agent s'en sert ensuite sans les voir (ssh_write_secret,
 * stdin_secret de ssh_run, browser_fill, fichiers d'environnement).
 */
export const SECRETS_REQUEST = 'secrets';

/** Au plus autant de champs par demande. */
export const MAX_REQUESTED_FIELDS = 10;

export interface RequestedSecretField {
  key: string;
  label: string;
  /** Aide affichée sous le champ (format attendu, où le trouver). */
  hint: string | null;
  /** Saisie sur plusieurs lignes (clé privée, certificat, fichier). */
  multiline: boolean;
}

export interface SecretsRequestPayload {
  /** Nom de l'élément du coffre à créer ou mettre à jour. */
  item: string;
  /** Élément existant (de type secret) dans la portée de la session : mise à jour ; null : création. */
  itemId: string | null;
  description: string | null;
  fields: RequestedSecretField[];
  projectId: string;
  /** Personne dont les droits servent la session : seule elle peut ranger le secret dans son coffre personnel. */
  personalUserId: string | null;
}

export type SecretsDestination = 'project' | 'personal';

/** Contrôle et normalise les champs demandés par l'agent. */
export function normalizeRequestedFields(fields: { key: string; label?: string | null; hint?: string | null; multiline?: boolean | null }[]): RequestedSecretField[] {
  if (!fields.length) throw new AppError('Indique au moins un champ à saisir');
  if (fields.length > MAX_REQUESTED_FIELDS) throw new AppError(`Au plus ${MAX_REQUESTED_FIELDS} champs par demande`);
  const seen = new Set<string>();
  return fields.map((f) => {
    const key = validateFieldKey(f.key);
    if (seen.has(key)) throw new AppError(`Le champ « ${key} » apparaît deux fois`);
    seen.add(key);
    return { key, label: f.label?.trim().slice(0, 120) || key, hint: f.hint?.trim().slice(0, 500) || null, multiline: Boolean(f.multiline) };
  });
}

/** Prépare la demande : élément existant à mettre à jour (de type secret, dans la portée) ou nom libre à créer. */
export async function prepareSecretsRequest(input: {
  projectId: string;
  rightsHolderId: string | null;
  item: string;
  description?: string | null;
  fields: RequestedSecretField[];
}): Promise<SecretsRequestPayload> {
  const name = input.item.trim().toLowerCase();
  // Même règle que les noms du coffre (vault/service.ts) : contrôlée ici pour répondre à l'agent avant d'ouvrir la modale.
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) throw new AppError(`Nom d'élément invalide « ${input.item} » : lettres minuscules, chiffres, tirets et soulignés, 40 caractères maximum (ex. cle-deploiement)`);
  const existing = (await vaultService.agentItems(input.projectId, input.rightsHolderId)).find((i) => i.name === name) ?? null;
  if (existing && existing.kind !== 'secret') throw new AppError(`« ${name} » existe déjà dans le coffre et n'est pas un secret : choisis un autre nom`);
  return {
    item: name,
    itemId: existing?.id ?? null,
    description: input.description?.trim() || null,
    fields: input.fields,
    projectId: input.projectId,
    personalUserId: input.rightsHolderId,
  };
}

export interface ProvideSecretsInput {
  values: { key: string; value: string }[];
  destination?: SecretsDestination | null;
  requireApproval?: boolean | null;
}

/** Réponse remise à l'agent (et gardée dans la table des demandes) : jamais de valeur. */
export interface SecretsResponse {
  item: string;
  itemId: string;
  fields: string[];
  created: boolean;
  destination: SecretsDestination | 'existing';
  requireApproval: boolean;
}

/**
 * La personne a saisi les secrets : crée ou met à jour l'élément du coffre en son nom (ses droits), puis règle la
 * demande avec une réponse sans aucune valeur. Les droits : mettre à jour demande de gérer l'élément ; créer dans
 * le coffre du projet demande d'administrer le projet ; créer dans son coffre personnel n'est possible qu'à la
 * personne dont les droits servent la session (l'élément est alors ouvert à ses sessions du projet).
 */
export async function provideSecrets(requestId: string, userId: string, input: ProvideSecretsInput): Promise<HumanRequest> {
  const request = await requestService.get(requestId);
  if (request.type !== SECRETS_REQUEST) throw new AppError("Cette demande n'attend pas de secrets");
  if (request.status !== 'pending') throw new AppError('Cette demande a déjà été réglée', REQUEST_SETTLED);
  const payload = request.payload as unknown as SecretsRequestPayload;
  const session = await sessionRepository.findById(request.sessionId);
  if (!session || session.projectId !== payload.projectId) throw new AppError('Session introuvable');

  const values = new Map(input.values.map((v) => [v.key, v.value]));
  const missing = payload.fields.filter((f) => !values.get(f.key)?.length);
  if (missing.length) throw new AppError(`Champ${missing.length > 1 ? 's' : ''} à remplir : ${missing.map((f) => f.label).join(', ')}`);
  const entries: VaultFieldInput[] = payload.fields.map((f) => ({ key: f.key, label: f.label, secret: true, value: values.get(f.key)! }));
  const actor = { userId, sessionId: request.sessionId, projectId: payload.projectId };

  let item: VaultItem;
  let created = false;
  let destination: SecretsResponse['destination'];
  const existing = payload.itemId ? await vaultService.getInternal(payload.itemId).catch(() => null) : null;
  if (existing) {
    if (existing.kind !== 'secret') throw new AppError(`« ${existing.name} » n'est plus un secret`);
    // Les champs déjà présents sont gardés (valeur inchangée), ceux saisis remplacés ou ajoutés.
    const kept = (existing.settings as SecretSettings).fields.filter((f) => !values.has(f.key)).map((f) => ({ key: f.key, label: f.label, secret: f.secret, value: f.secret ? null : f.value }));
    item = await vaultService.update(actor, existing.id, { fields: [...kept, ...entries], ...(input.requireApproval != null ? { requireApproval: input.requireApproval } : {}) });
    destination = 'existing';
  } else {
    destination = input.destination ?? (payload.personalUserId === userId ? 'personal' : 'project');
    const base = { name: payload.item, kind: 'secret' as const, description: payload.description ?? `Saisi à la demande de la session ${session.name}`, fields: entries, requireApproval: input.requireApproval ?? true };
    if (destination === 'project') {
      if ((await userService.roleFor(userId, payload.projectId)) !== 'admin') throw new AppError("Ranger un secret dans le coffre du projet demande d'en être administrateur : choisissez votre coffre personnel", 'FORBIDDEN');
      item = await vaultService.create(actor, payload.projectId, base);
    } else {
      if (payload.personalUserId !== userId) throw new AppError("Cette session ne tourne pas avec vos droits : votre coffre personnel ne lui serait pas accessible. Choisissez le coffre du projet (administrateurs)", 'FORBIDDEN');
      item = await vaultService.create(actor, null, base);
      try {
        await vaultService.link(actor, item.id, payload.projectId, 'personal');
      } catch (err) {
        await vaultService.delete(actor, item.id).catch(() => undefined);
        throw err;
      }
    }
    created = true;
  }
  const response: SecretsResponse = { item: item.name, itemId: item.id, fields: payload.fields.map((f) => f.key), created, destination, requireApproval: item.requireApproval };
  return requestService.answer(requestId, response as unknown as Record<string, unknown>, userId);
}

/** Remplace dans un texte toute occurrence d'une valeur secrète (sortie d'une commande qui l'aurait affichée). */
export function redactSecret(text: string, secret: string): string {
  if (secret.length < 4) return text;
  let out = text.split(secret).join('[secret masqué]');
  // Une valeur sur plusieurs lignes peut ressortir ligne par ligne (cat d'une clé privée) : chaque ligne longue est masquée.
  for (const line of secret.split(/\r?\n/)) if (line.trim().length >= 8 && line.trim() !== secret) out = out.split(line.trim()).join('[secret masqué]');
  return out;
}

/** Référence « élément.champ » d'un secret du coffre. */
export function parseSecretRef(ref: string): { item: string; field: string } {
  const m = /^\s*([^.\s]+)\.([^.\s]+)\s*$/.exec(ref);
  if (!m) throw new AppError(`Référence de secret invalide : « ${ref} » (attendu : élément.champ, ex. cle-deploiement.private_key)`);
  return { item: m[1].toLowerCase(), field: m[2].toLowerCase() };
}
