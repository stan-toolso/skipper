import { AppError } from '../errors.js';
import { kindLabels, type ApiSettings, type PostgresSettings, type SecretSettings, type SshSettings, type VaultFieldInput, type VaultItem, type VaultItemInput, type WebsiteSettings } from './types.js';

/**
 * Modification d'un élément du coffre par une session d'agent (outil vault.update_item) : traduction des paramètres
 * de l'outil en entrée du service, et résumé lisible montré à la personne qui donne son accord.
 *
 * Ce qu'un agent peut changer : la description, la cible (hôte, port, utilisateur, base, adresse, tunnel SSH d'une
 * base) et les champs d'un secret ou d'un site web, et activer TLS sur une base (jamais le désactiver) ; une valeur
 * secrète ne s'écrit jamais en clair, seulement par référence à un secret qu'il ne voit pas (`élément.champ` ou
 * `session:nom.champ`). Jamais la politique d'accès (nom, lecture seule, accord à chaque usage, fichiers
 * d'environnement, commandes autorisées) : elle reste aux personnes.
 */

export interface AgentFieldEdit {
  key: string;
  label?: string;
  /** Valeur d'un champ public. */
  value?: string;
  /** Référence d'un secret (élément.champ ou session:nom.champ) dont la valeur devient celle du champ (secret). */
  value_from?: string;
  secret?: boolean;
}

export interface AgentEditParams {
  description?: string;
  host?: string;
  port?: number;
  username?: string;
  database?: string;
  url?: string;
  fields?: AgentFieldEdit[];
  remove_fields?: string[];
  password_from?: string;
  token_from?: string;
  /** postgres : nom du serveur SSH du même coffre à traverser ; chaîne vide = connexion directe. */
  via?: string;
  /** postgres : TLS (seulement l'activer). */
  ssl?: boolean;
}

/** Tunnels résolus par l'appelant : l'actuel (nom) et le demandé (null = connexion directe). */
export interface AgentEditTunnels {
  current?: string | null;
  next?: { id: string; name: string } | null;
}

export interface AgentEdit {
  input: VaultItemInput;
  /** Une ligne par changement demandé (sans aucune valeur secrète). */
  summary: string[];
  /** La cible change alors que l'élément porte des identifiants : ils partiront vers la nouvelle cible. */
  retargets: boolean;
}

const q = (v: unknown) => (v === null || v === undefined || v === '' ? '(vide)' : `« ${String(v)} »`);

/** Références de secrets citées par les paramètres (à résoudre par l'appelant avant `buildAgentEdit`). */
export function secretRefsOf(p: AgentEditParams): string[] {
  return [p.password_from, p.token_from, ...(p.fields ?? []).map((f) => f.value_from)].filter((r): r is string => Boolean(r?.trim()));
}

export function buildAgentEdit(item: VaultItem, p: AgentEditParams, secretValue: (ref: string) => string, tunnels: AgentEditTunnels = {}): AgentEdit {
  const input: VaultItemInput = {};
  const summary: string[] = [];
  let retargets = false;
  const allowed: Record<string, VaultItem['kind'][]> = {
    host: ['ssh', 'postgres'],
    port: ['ssh', 'postgres'],
    username: ['ssh', 'postgres', 'api'],
    database: ['postgres'],
    url: ['api', 'website'],
    fields: ['website', 'secret'],
    remove_fields: ['website', 'secret'],
    password_from: ['postgres'],
    token_from: ['api'],
    via: ['postgres'],
    ssl: ['postgres'],
  };
  for (const [param, kinds] of Object.entries(allowed)) {
    if ((p as Record<string, unknown>)[param] !== undefined && !kinds.includes(item.kind))
      throw new AppError(`Le paramètre ${param} ne s'applique pas à « ${item.name} » (${kindLabels[item.kind]})`);
  }

  if (p.description !== undefined && p.description.trim() !== item.description) {
    input.description = p.description;
    summary.push(`description : ${q(item.description)} → ${q(p.description.trim())}`);
  }

  const target = (param: 'host' | 'port' | 'username' | 'database', label: string, current: unknown, next: string | number | undefined, moves: boolean) => {
    if (next === undefined || String(next) === String(current ?? '')) return;
    (input as Record<string, unknown>)[param] = next;
    summary.push(`${label} : ${q(current)} → ${q(next)}`);
    if (moves) retargets = true;
  };
  if (item.kind === 'ssh' || item.kind === 'postgres') {
    const t = item.settings as SshSettings | PostgresSettings;
    target('host', 'hôte', t.host, p.host?.trim(), true);
    target('port', 'port', t.port, p.port, true);
    target('username', 'utilisateur', t.username, p.username?.trim(), false);
  }
  if (item.kind === 'postgres') {
    const t = item.settings as PostgresSettings;
    if (p.database !== undefined && (p.database.trim() || null) !== (t.database ?? null)) {
      input.database = p.database.trim() || null;
      summary.push(`base : ${q(t.database)} → ${p.database.trim() ? q(p.database.trim()) : 'le serveur entier'}`);
    }
    if (p.password_from) {
      input.password = secretValue(p.password_from);
      summary.push(`mot de passe : remplacé par le secret ${p.password_from}`);
    }
    if (p.via !== undefined) {
      const next = p.via.trim() ? tunnels.next : null;
      if (p.via.trim() && !next) throw new AppError(`Tunnel « ${p.via.trim()} » introuvable`);
      if ((next?.id ?? null) !== (t.viaItemId ?? null)) {
        input.viaItemId = next?.id ?? '';
        summary.push(`tunnel SSH : ${t.viaItemId ? q(tunnels.current ?? '?') : '(aucun, connexion directe)'} → ${next ? q(next.name) : 'aucun (connexion directe)'}`);
        retargets = true;
      }
    }
    if (p.ssl !== undefined) {
      if (!p.ssl && t.ssl) throw new AppError(`Désactiver TLS sur « ${item.name} » reste aux personnes (page Coffre) : les échanges avec la base passeraient en clair`);
      if (p.ssl && !t.ssl) {
        input.ssl = true;
        summary.push('TLS : désactivé → activé');
      }
    }
  }
  if (item.kind === 'api') {
    const t = item.settings as ApiSettings;
    if (p.url !== undefined && p.url.trim() !== t.baseUrl) {
      input.url = p.url.trim();
      summary.push(`adresse de base : ${q(t.baseUrl)} → ${q(p.url.trim())}`);
      retargets = true;
    }
    if (p.username !== undefined) {
      if (t.authScheme !== 'basic') throw new AppError(`« ${item.name} » n'utilise pas l'authentification Basic : pas d'utilisateur`);
      target('username', 'utilisateur', t.username, p.username.trim(), false);
    }
    if (p.token_from) {
      input.token = secretValue(p.token_from);
      summary.push(`${t.authScheme === 'basic' ? 'mot de passe' : 'jeton'} : remplacé par le secret ${p.token_from}`);
    }
  }
  if (item.kind === 'website' && p.url !== undefined && p.url.trim() !== (item.settings as WebsiteSettings).url) {
    input.url = p.url.trim();
    summary.push(`adresse du site : ${q((item.settings as WebsiteSettings).url)} → ${q(p.url.trim())}`);
    retargets = true;
  }

  if (item.kind === 'website' || item.kind === 'secret') {
    const current = (item.settings as SecretSettings | WebsiteSettings).fields;
    if (p.fields?.length || p.remove_fields?.length) {
      const remove = new Set((p.remove_fields ?? []).map((k) => k.trim().toLowerCase()));
      for (const key of remove) {
        if (!current.some((f) => f.key === key)) throw new AppError(`« ${item.name} » n'a pas de champ « ${key} » (champs : ${current.map((f) => f.key).join(', ') || 'aucun'})`);
        summary.push(`champ « ${key} » : retiré`);
      }
      const edits = new Map<string, AgentFieldEdit>();
      for (const f of p.fields ?? []) {
        const key = f.key.trim().toLowerCase();
        if (edits.has(key)) throw new AppError(`Le champ « ${key} » apparaît deux fois`);
        if (remove.has(key)) throw new AppError(`Le champ « ${key} » est à la fois modifié et retiré`);
        edits.set(key, f);
      }
      const out: VaultFieldInput[] = [];
      for (const f of current) {
        if (remove.has(f.key)) continue;
        const e = edits.get(f.key);
        edits.delete(f.key);
        out.push(e ? fieldOf(f.key, e, f, summary, secretValue) : { key: f.key, label: f.label, secret: f.secret, value: f.secret ? null : f.value });
      }
      for (const [key, e] of edits) out.push(fieldOf(key, e, null, summary, secretValue));
      input.fields = out;
    }
  }

  if (!summary.length) throw new AppError(`Rien à modifier sur « ${item.name} » : les valeurs données sont déjà celles de l'élément`);
  return { input, summary, retargets };
}

function fieldOf(key: string, e: AgentFieldEdit, previous: { label: string; secret: boolean; value: string | null } | null, summary: string[], secretValue: (ref: string) => string): VaultFieldInput {
  const secret = e.value_from ? e.secret !== false : (e.secret ?? previous?.secret ?? false);
  const label = e.label?.trim() || previous?.label || key;
  if (e.value_from && e.secret === false) throw new AppError(`Le champ « ${key} » : une valeur tirée d'un secret (value_from) reste secrète`);
  if (secret && e.value !== undefined) throw new AppError(`Le champ « ${key} » est secret : ne donne jamais sa valeur en clair, passe une référence (value_from : élément.champ ou session:nom.champ ; request_secrets pour la faire saisir)`);
  if (!previous && secret && !e.value_from) throw new AppError(`Le nouveau champ secret « ${key} » n'a pas de valeur : donne value_from`);
  const what: string[] = [];
  if (!previous) what.push(secret ? `ajouté (secret, depuis ${e.value_from})` : `ajouté : ${q(e.value ?? '')}`);
  else {
    if (label !== previous.label) what.push(`libellé ${q(previous.label)} → ${q(label)}`);
    if (secret !== previous.secret) what.push(secret ? 'devient secret' : 'devient public');
    if (e.value_from) what.push(`valeur remplacée par le secret ${e.value_from}`);
    else if (!secret && e.value !== undefined && e.value !== (previous.value ?? '')) what.push(`${q(previous.secret ? null : previous.value)} → ${q(e.value)}`);
  }
  if (what.length) summary.push(`champ « ${key} » : ${what.join(', ')}`);
  if (previous?.secret && !secret && e.value === undefined) throw new AppError(`Le champ « ${key} » devient public : donne sa nouvelle valeur (value)`);
  return { key, label, secret, value: e.value_from ? secretValue(e.value_from) : secret ? null : (e.value ?? previous?.value ?? '') };
}
