import { Link } from 'react-router-dom';
import { refUrl, splitRefs } from '../lib/idRefs';
import type { TaskPerson, TaskPriority, TaskRef, TaskStatus } from '../graphql/operations';

const STATUS: Record<TaskStatus, string> = { TODO: 'À faire', IN_PROGRESS: 'En cours', DONE: 'Terminée', CANCELLED: 'Annulée' };
const PRIORITY: Record<TaskPriority, { label: string; icon: string }> = {
  URGENT: { label: 'Urgente', icon: 'bi-chevron-double-up' },
  HIGH: { label: 'Haute', icon: 'bi-chevron-up' },
  MEDIUM: { label: 'Moyenne', icon: 'bi-dash' },
  LOW: { label: 'Basse', icon: 'bi-chevron-down' },
};

/**
 * Statut d'une tâche (`label` : son statut dans le projet, `attention` : il attend une personne) : une pastille par étape (à faire gris, en cours bleu, terminée vert, annulée barrée) ; son
 * étiquette d'état (où en est le travail : « en revue », « bloquée »…), quand elle existe, suit dans la même pastille.
 */
export function TaskStatusBadge({ status, statusTag, label: own, attention, className = '' }: { status: TaskStatus; statusTag?: string | null; label?: string | null; attention?: boolean; className?: string }) {
  // Statut du projet (« À valider »…) quand on le connaît, sinon celui de la catégorie.
  const label = own || STATUS[status];
  return (
    <span className={`task-status task-status-${status.toLowerCase()}${attention ? ' task-status-attention' : ''} ${className}`} title={statusTag ? `${label} · ${statusTag}` : undefined}>
      {label}
      {statusTag && <span className="task-status-tag">{statusTag}</span>}
    </span>
  );
}

/** Étiquettes d'une tâche en petites puces ; avec `onSelect`, ce sont des boutons (filtrer par étiquette). */
export function TaskTags({ tags, onSelect, className = '' }: { tags: string[]; onSelect?: (tag: string) => void; className?: string }) {
  if (tags.length === 0) return null;
  return (
    <span className={`task-tags ${className}`}>
      {tags.map((tag) =>
        onSelect ? (
          <button
            key={tag}
            type="button"
            className="task-tag"
            title={`Voir les tâches étiquetées « ${tag} »`}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(tag);
            }}
          >
            {tag}
          </button>
        ) : (
          <span key={tag} className="task-tag">
            {tag}
          </span>
        ),
      )}
    </span>
  );
}

export function TaskPriorityBadge({ priority, short = false }: { priority: TaskPriority; short?: boolean }) {
  const p = PRIORITY[priority];
  return (
    <span className={`task-priority task-priority-${priority.toLowerCase()}`} title={`Priorité ${p.label.toLowerCase()}`}>
      <i className={`bi ${p.icon}`} />
      {!short && ` ${p.label}`}
    </span>
  );
}

/** « Nom <e-mail> », ou ce qui est renseigné. */
export function formatPerson(p: TaskPerson | null | undefined): string {
  if (!p) return '';
  if (p.name && p.email) return `${p.name} <${p.email}>`;
  return p.name ?? p.email ?? '';
}

export function PersonChip({ person, icon = 'bi-person-check' }: { person: TaskPerson | null | undefined; icon?: string }) {
  if (!person) return null;
  return (
    <span title={formatPerson(person)}>
      <i className={`bi ${icon} me-1`} />
      {person.name ?? person.email}
    </span>
  );
}

/**
 * Texte avec les liens http(s) rendus cliquables, et les identifiants de tâches et de sessions cités (« la session
 * 2927a9fc », voir `lib/idRefs`) changés en liens vers leur page.
 */
export function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>)]+)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer">
            {part}
          </a>
        ) : (
          <span key={i}>
            {splitRefs(part).map((s, j) =>
              'kind' in s ? (
                <Link key={j} to={refUrl(s.kind, s.id)}>
                  {s.text}
                </Link>
              ) : (
                s.text
              ),
            )}
          </span>
        ),
      )}
    </>
  );
}

export const isOverdue = (t: { dueDate: string | null; status: TaskStatus }) => Boolean(t.dueDate) && t.status !== 'DONE' && t.status !== 'CANCELLED' && t.dueDate! < new Date().toISOString().slice(0, 10);

/**
 * « Bloquée » : la tâche attend des dépendances non terminées (elle ne peut pas être confiée à un agent avant) ; le
 * cadenas s'accompagne d'un éclair quand elle sera lancée automatiquement une fois débloquée.
 */
export function TaskBlockedBadge({ task, short = false, className = '' }: { task: { blockedBy: TaskRef[]; autoStartWhenUnblocked: boolean }; short?: boolean; className?: string }) {
  if (!task.blockedBy.length) return null;
  const title = `Bloquée par ${task.blockedBy.map((t) => `« ${t.title} » (${STATUS[t.status].toLowerCase()})`).join(', ')}${task.autoStartWhenUnblocked ? ' · lancée automatiquement une fois débloquée' : ''}`;
  return (
    <span className={`task-blocked ${className}`} title={title}>
      <i className="bi bi-lock" aria-label={short ? 'bloquée' : undefined} />
      {!short && ` bloquée${task.blockedBy.length > 1 ? ` (${task.blockedBy.length})` : ''}`}
      {task.autoStartWhenUnblocked && <i className="bi bi-lightning-charge ms-1" aria-label="lancement automatique" />}
    </span>
  );
}

/**
 * « Agent arrêté » : la tâche est en cours mais aucune session en charge ne tourne plus (terminée, arrêtée, en erreur ou
 * interrompue, sans pull request ouverte) : personne n'y travaille, il faut la reprendre, la relancer ou la remettre à faire.
 */
export function TaskStalledBadge({ task, short = false, className = '' }: { task: { stalledSince?: string | null; wakeAt?: string | null }; short?: boolean; className?: string }) {
  if (!task.stalledSince) return null;
  const since = shortDate(task.stalledSince);
  const why = task.wakeAt && new Date(task.wakeAt) <= new Date() ? `le réveil prévu le ${shortDate(task.wakeAt)} est passé` : `l'agent s'est arrêté le ${since} sans la terminer`;
  return (
    <span className={`task-stalled ${className}`} title={`En cours, mais ${why} : reprenez sa session, relancez un agent ou remettez-la à faire`}>
      <i className="bi bi-person-x" aria-label={short ? 'agent arrêté' : undefined} />
      {!short && ' agent arrêté'}
    </span>
  );
}

const shortDate = (iso: string) => new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Pourquoi une tâche est « en attente » : réveil daté, ou ce que l'agent a laissé (étiquette d'état, compte rendu dans le fil). */
export function waitingText(task: { wakeAt?: string | null; wakeNote?: string | null; statusTag?: string | null }): string {
  if (task.wakeAt) return `réveil le ${shortDate(task.wakeAt)}${task.wakeNote ? ` : ${task.wakeNote}` : ''}`;
  return `${task.statusTag ? `« ${task.statusTag} »` : 'compte rendu dans le fil'}, sans date de réveil (revient dans « À traiter » au bout de 7 jours)`;
}

/**
 * « En attente » : en cours, aucun agent n'y travaille, mais il a dit ce qu'il attendait (date de réveil, étiquette
 * d'état ou compte rendu dans le fil) : rien à faire avant le réveil.
 */
export function TaskWaitingBadge({ task, short = false, className = '' }: { task: { waitingSince?: string | null; wakeAt?: string | null; wakeNote?: string | null; statusTag?: string | null }; short?: boolean; className?: string }) {
  if (!task.waitingSince) return null;
  return (
    <span className={`task-waiting ${className}`} title={`En attente : ${waitingText(task)}`}>
      <i className="bi bi-hourglass-split" aria-label={short ? 'en attente' : undefined} />
      {!short && (task.wakeAt ? ` réveil ${shortDate(task.wakeAt)}` : ' en attente')}
    </span>
  );
}

/**
 * Date de vérification programmée (date de réveil, `Task.wakeAt`) : jusque-là la tâche est en attente ; passée, elle
 * revient à traiter (en rouge).
 */
export function TaskWakeDate({ task, className = '' }: { task: { wakeAt?: string | null; wakeNote?: string | null }; className?: string }) {
  if (!task.wakeAt) return null;
  const past = new Date(task.wakeAt).getTime() <= Date.now();
  return (
    <span className={`text-nowrap${past ? ' text-danger' : ''} ${className}`} title={`${past ? 'Vérification prévue (date passée)' : 'Vérification programmée'} le ${new Date(task.wakeAt).toLocaleString()}${task.wakeNote ? ` : ${task.wakeNote}` : ''}`}>
      <i className="bi bi-alarm me-1" />
      {shortDate(task.wakeAt)}
    </span>
  );
}

/** Liste de tâches liées (dépendances, tâches qui en dépendent), chacune avec son statut et un lien vers sa page. */
export function TaskRefList({ tasks }: { tasks: TaskRef[] }) {
  return (
    <ul className="task-ref-list">
      {tasks.map((t) => (
        <li key={t.id}>
          <TaskStatusBadge status={t.status} /> <Link to={`/tasks/${t.id}`}>{t.title}</Link>
        </li>
      ))}
    </ul>
  );
}
