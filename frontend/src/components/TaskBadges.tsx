import type { TaskPerson, TaskPriority, TaskStatus } from '../graphql/operations';

const STATUS: Record<TaskStatus, string> = { TODO: 'À faire', IN_PROGRESS: 'En cours', DONE: 'Terminée', CANCELLED: 'Annulée' };
const PRIORITY: Record<TaskPriority, { label: string; icon: string }> = {
  URGENT: { label: 'Urgente', icon: 'bi-chevron-double-up' },
  HIGH: { label: 'Haute', icon: 'bi-chevron-up' },
  MEDIUM: { label: 'Moyenne', icon: 'bi-dash' },
  LOW: { label: 'Basse', icon: 'bi-chevron-down' },
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`task-status task-status-${status.toLowerCase()}`}>{STATUS[status]}</span>;
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

/** Texte avec les liens http(s) rendus cliquables. */
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
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export const isOverdue = (t: { dueDate: string | null; status: TaskStatus }) => Boolean(t.dueDate) && t.status !== 'DONE' && t.status !== 'CANCELLED' && t.dueDate! < new Date().toISOString().slice(0, 10);
