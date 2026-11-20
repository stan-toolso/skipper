/**
 * Sous-agents du CLI Claude Code en cours dans une session, pour les montrer dans la sidebar.
 *
 * Un agent lance des sous-agents avec l'outil Agent (au premier plan, ou en arrière-plan avec `run_in_background`). Ce
 * ne sont pas des sessions Skipper : ils vivent dans le processus du CLI, et le transcript n'en montre que l'appel
 * d'outil. Le SDK annonce chacun par des messages système : `task_started` (début), `task_progress` (avancement :
 * outils utilisés, dernier outil, résumé), `task_updated` (changement d'état, passage en arrière-plan) et
 * `task_notification` (fin). Ce module en tient la liste, que le provider enregistre sur la session
 * (`sessions.subagents`) : la sidebar la lit comme le reste de la session, quelle que soit l'instance qui répond
 * (bleu/vert : une session tenue par ses sous-agents pendant un drainage tourne sur l'ancienne instance).
 *
 * Comptent les types qui rendent un compte rendu (sous-agents, workflows : `REPORTING_TASK` de backgroundTasks.ts),
 * hors tâches `ambient` ou `skip_transcript`. Les commandes de fond (Bash `run_in_background`) figurent aussi dans la
 * liste, avec `kind: 'command'`, tant que `background_tasks_changed` les dit vivantes : l'agent qui clôt son tour sur
 * « j'attends la fin des tests » est réveillé par le CLI à leur fin, et sans elles rien ne montrait que la session
 * attendait quelque chose (session 707e72c1, 20/11/2026). Elles ne tiennent pas la session « au travail »
 * (BackgroundHold : un serveur de développement peut tourner sans fin).
 * `background_tasks_changed` (liste complète des tâches de fond vivantes) sert de filet : une tâche de fond absente de
 * cette liste est finie, même si sa notification de fin s'est perdue.
 */

import { reportingBackgroundTasks, type BackgroundTaskLike } from './backgroundTasks.js';

/** Commandes de fond d'une liste (`kind: 'command'`). */
export const backgroundCommands = <T extends Pick<SessionSubagent, 'kind'>>(list: readonly T[] | null | undefined): T[] => (list ?? []).filter((s) => s.kind === 'command');

/** « 1 commande en arrière-plan (« ./test.sh ci ») » : libellé des commandes de fond, pour les notices. */
export function describeBackgroundCommands(list: readonly Pick<SessionSubagent, 'description'>[]): string {
  const n = list.length;
  const names = list.slice(0, 3).map((c) => `« ${c.description.length > 60 ? `${c.description.slice(0, 59)}…` : c.description} »`);
  return `${n} commande${n > 1 ? 's' : ''} en arrière-plan${names.length ? ` (${names.join(', ')}${n > names.length ? ', …' : ''})` : ''}`;
}

/** Sous-agent en cours, tel qu'enregistré sur la session (jsonb `sessions.subagents`). */
export interface SessionSubagent {
  /** Identifiant de la tâche du CLI. */
  id: string;
  /** Sous-agent ou workflow (`agent`, défaut des listes enregistrées avant), ou commande de fond (`command`). */
  kind?: 'agent' | 'command';
  /** Appel de l'outil Agent qui l'a lancé (pour le retrouver dans le transcript). */
  toolUseId: string | null;
  /** Description donnée par l'agent (« Explore strength front module »). */
  description: string;
  /** Type de sous-agent (`general-purpose`, `Explore`, `fork`…) ou nom du workflow ; null si inconnu. */
  agentType: string | null;
  /** Lancé (ou passé) en arrière-plan : l'agent principal peut finir son tour sans l'attendre. */
  background: boolean;
  /** Début (ISO). */
  startedAt: string;
  /** Nombre d'appels d'outils du sous-agent, d'après le dernier avancement. */
  toolUses: number;
  /** Dernier outil utilisé. */
  lastTool: string | null;
  /** Résumé d'avancement en une ligne, quand le CLI en fournit un. */
  summary: string | null;
}

/** Forme lue des messages système du SDK (champs facultatifs : on reste tolérant aux versions). */
export interface TaskMessageLike {
  subtype?: string;
  task_id?: string;
  tool_use_id?: string;
  description?: string;
  subagent_type?: string;
  workflow_name?: string;
  task_type?: string;
  is_backgrounded?: boolean;
  ambient?: boolean;
  skip_transcript?: boolean;
  usage?: { tool_uses?: number };
  last_tool_name?: string;
  summary?: string;
  patch?: { status?: string; description?: string; is_backgrounded?: boolean };
  tasks?: BackgroundTaskLike[];
}

const REPORTING = /agent|workflow|teammate/i;
const ENDED = new Set(['completed', 'failed', 'killed', 'stopped']);
const MAX_DESCRIPTION = 200;

const clip = (s: string | undefined | null, n = MAX_DESCRIPTION): string => {
  const t = (s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * Liste des sous-agents en cours d'une exécution du CLI. `apply` renvoie `'now'` quand la liste change (début, fin) et
 * doit être enregistrée tout de suite, `'later'` pour un simple avancement (enregistrement regroupé par l'appelant),
 * `null` si le message ne la concerne pas.
 */
export class SubagentTracker {
  private readonly byId = new Map<string, SessionSubagent>();
  /** Dernière liste complète des tâches de fond vivantes (`background_tasks_changed`). */
  private backgroundIds = new Set<string>();
  /** Début des tâches qui ne sont pas des sous-agents (commandes), pour les inscrire quand elles passent en arrière-plan ; oublié à leur notification de fin. */
  private readonly otherStarts = new Map<string, { toolUseId: string | null; startedAt: string }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  get list(): SessionSubagent[] {
    return [...this.byId.values()];
  }

  apply(message: TaskMessageLike): 'now' | 'later' | null {
    const id = message.task_id;
    switch (message.subtype) {
      case 'task_started': {
        if (!id || message.ambient || message.skip_transcript) return null;
        // Les sous-agents ont un task_type local_agent / remote_agent ; un message sans task_type mais avec un type de
        // sous-agent vient d'une version du SDK qui ne le renseignait pas encore.
        const type = message.task_type ?? (message.subagent_type ? 'local_agent' : '');
        if (!REPORTING.test(type)) {
          this.otherStarts.set(id, { toolUseId: message.tool_use_id ?? null, startedAt: this.now().toISOString() });
          return null;
        }
        this.byId.set(id, {
          id,
          kind: 'agent',
          toolUseId: message.tool_use_id ?? null,
          description: clip(message.description) || 'Sous-agent',
          agentType: message.subagent_type ?? message.workflow_name ?? null,
          background: Boolean(message.is_backgrounded),
          startedAt: this.now().toISOString(),
          toolUses: 0,
          lastTool: null,
          summary: null,
        });
        return 'now';
      }
      case 'task_progress': {
        const s = id ? this.byId.get(id) : undefined;
        if (!s) return null;
        const toolUses = message.usage?.tool_uses ?? s.toolUses;
        const lastTool = message.last_tool_name ?? s.lastTool;
        const summary = message.summary ? clip(message.summary) : s.summary;
        if (toolUses === s.toolUses && lastTool === s.lastTool && summary === s.summary) return null;
        Object.assign(s, { toolUses, lastTool, summary });
        return 'later';
      }
      case 'task_updated': {
        const s = id ? this.byId.get(id) : undefined;
        if (!s || !message.patch) return null;
        if (message.patch.status && ENDED.has(message.patch.status)) {
          this.byId.delete(s.id);
          return 'now';
        }
        let changed = false;
        if (message.patch.is_backgrounded !== undefined && message.patch.is_backgrounded !== s.background) {
          s.background = message.patch.is_backgrounded;
          changed = true;
        }
        if (message.patch.description && clip(message.patch.description) !== s.description) {
          s.description = clip(message.patch.description);
          changed = true;
        }
        return changed ? 'now' : null;
      }
      case 'task_notification': {
        if (id) this.otherStarts.delete(id);
        if (!id || !this.byId.delete(id)) return null;
        return 'now';
      }
      case 'background_tasks_changed': {
        // Filet : un sous-agent de fond absent de la liste complète est fini. Ceux du premier plan n'y figurent pas.
        const live = new Set(reportingBackgroundTasks(message.tasks).map((t) => t.task_id));
        this.backgroundIds = live;
        // Commandes de fond vivantes (ni sous-agent, ni tâche ambiante comme une surveillance).
        const commands = new Map((message.tasks ?? []).filter((t) => !t.ambient && !REPORTING.test(t.task_type ?? '')).map((t) => [t.task_id, t]));
        let changed = false;
        for (const s of this.byId.values()) {
          if (s.kind === 'command') {
            if (!commands.has(s.id)) {
              this.byId.delete(s.id);
              changed = true;
            }
            continue;
          }
          if (live.has(s.id) && !s.background) {
            s.background = true;
            changed = true;
          } else if (s.background && !live.has(s.id)) {
            this.byId.delete(s.id);
            changed = true;
          }
        }
        for (const [taskId, t] of commands) {
          if (this.byId.has(taskId)) continue;
          const start = this.otherStarts.get(taskId);
          this.byId.set(taskId, {
            id: taskId,
            kind: 'command',
            toolUseId: start?.toolUseId ?? null,
            description: clip(t.description) || 'Commande',
            agentType: null,
            background: true,
            startedAt: start?.startedAt ?? this.now().toISOString(),
            toolUses: 0,
            lastTool: null,
            summary: null,
          });
          changed = true;
        }
        return changed ? 'now' : null;
      }
      default:
        return null;
    }
  }

  /**
   * Fin d'un tour de l'agent principal : un sous-agent du premier plan ne lui survit pas (l'appel d'outil qui
   * l'attendait est clos). Renvoie true si la liste a changé.
   */
  turnEnded(): boolean {
    let changed = false;
    for (const s of this.byId.values()) {
      if (!s.background && !this.backgroundIds.has(s.id)) {
        this.byId.delete(s.id);
        changed = true;
      }
    }
    return changed;
  }

  clear(): boolean {
    const had = this.byId.size > 0;
    this.byId.clear();
    this.otherStarts.clear();
    this.backgroundIds = new Set();
    return had;
  }
}

/** Délai de regroupement des enregistrements d'avancement (ms). */
export const SUBAGENT_PROGRESS_FLUSH_MS = 10_000;

/**
 * Enregistrement de la liste : immédiat pour un début ou une fin, regroupé (au plus un toutes les `flushMs`) pour un
 * avancement. Les écritures sont enchaînées, dans l'ordre.
 */
export class SubagentRecorder {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  /** Dernière liste enregistrée (JSON) ; inconnue au départ : le premier `flush` écrit toujours. */
  private last: string | null = null;

  constructor(
    private readonly tracker: SubagentTracker,
    private readonly save: (list: SessionSubagent[]) => Promise<void>,
    private readonly opts: { flushMs?: number; onError?: (err: unknown) => void } = {},
  ) {}

  /** Résultat de `tracker.apply` ou `turnEnded` : `'now'`/true enregistre, `'later'` programme. */
  changed(kind: 'now' | 'later' | boolean | null): void {
    if (!kind) return;
    if (kind === 'later') {
      if (!this.timer) this.timer = setTimeout(() => this.flush(), this.opts.flushMs ?? SUBAGENT_PROGRESS_FLUSH_MS);
      return;
    }
    this.flush();
  }

  /** Enregistre l'état courant (sans rien écrire s'il n'a pas changé depuis le dernier enregistrement). */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const list = this.tracker.list;
    const json = JSON.stringify(list);
    if (json === this.last) return this.chain;
    this.last = json;
    this.chain = this.chain.then(() => this.save(list)).catch((err) => this.opts.onError?.(err));
    return this.chain;
  }

  /** Fin de l'exécution : liste vidée et enregistrée. */
  dispose(): Promise<void> {
    this.tracker.clear();
    return this.flush();
  }
}
