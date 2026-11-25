import { gql, useMutation } from '@apollo/client';
import { useEffect, useMemo, useState } from 'react';
import { usePollingQuery } from '../lib/usePollingQuery';
import { Alert, Badge, Button, Card, Form, Modal, Spinner, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useDialogs } from './Dialogs';
import { TaskStatusBadge } from './TaskBadges';
import { timeAgo } from '../lib/humanize';
import type { TaskStatus } from '../graphql/operations';

export const PROJECT_WORKSESSION_DISK = gql`
  query ProjectWorksessionDisk($id: ID!, $refresh: Boolean) {
    project(id: $id) {
      id
      worksessionDisk(refresh: $refresh) {
        computedAt
        measuring
        sharedBytes
        totalBytes
        prunable
        entries {
          name
          branch
          exists
          gitWorktree
          bytes
          aheadCount
          changes
          prMerged
          merged
          activeSessions
          busySessions
          lastActivityAt
          deps
          cleanable
          blocker
          worksession {
            id
            label
            archivedAt
            task {
              id
              title
              status
              statusTag
            }
          }
        }
      }
    }
  }
`;
const CLEAN_MERGED = gql`
  mutation CleanMergedWorksessions($projectId: ID!, $names: [String!]) {
    cleanMergedWorksessions(projectId: $projectId, names: $names) {
      removed
      freedBytes
      skipped {
        name
        reason
      }
    }
  }
`;
const SHARE_DEPS = gql`
  mutation ShareWorksessionDeps($projectId: ID!, $names: [String!]) {
    shareWorksessionDeps(projectId: $projectId, names: $names) {
      relinked
      skipped {
        name
        reason
      }
    }
  }
`;
const DELETE_WORKSESSION = gql`
  mutation DeleteWorksessionFolder($id: ID!) {
    deleteWorksession(id: $id)
  }
`;
const IMPORT_ORPHAN = gql`
  mutation ImportOrphanWorksession($projectId: ID!, $name: String!) {
    importOrphanWorksession(projectId: $projectId, name: $name) {
      id
    }
  }
`;
const DELETE_ORPHAN = gql`
  mutation DeleteOrphanWorksession($projectId: ID!, $name: String!) {
    deleteOrphanWorksession(projectId: $projectId, name: $name)
  }
`;

interface DiskEntry {
  name: string;
  branch: string | null;
  exists: boolean;
  gitWorktree: boolean;
  bytes: number | null;
  aheadCount: number | null;
  changes: number | null;
  prMerged: boolean;
  merged: boolean;
  activeSessions: number;
  busySessions: number;
  lastActivityAt: string | null;
  deps: 'LINKED' | 'COPY' | 'NO_SNAPSHOT' | null;
  cleanable: boolean;
  blocker: string | null;
  worksession: { id: string; label: string; archivedAt: string | null; task: { id: string; title: string; status: TaskStatus; statusTag: string | null } | null } | null;
}
interface DiskReport {
  computedAt: string | null;
  measuring: boolean;
  sharedBytes: number | null;
  totalBytes: number | null;
  prunable: string[];
  entries: DiskEntry[];
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} Ko`;
  if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)} Mo`;
  return `${(n / 1024 ** 3).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Go`;
}

function MergeState({ e }: { e: DiskEntry }) {
  if (!e.gitWorktree) return <span className="text-secondary">—</span>;
  if (e.prMerged) return <Badge bg="success">PR fusionnée</Badge>;
  if (e.aheadCount === 0) return <span className="text-secondary">rien à fusionner</span>;
  if (e.aheadCount === null) return <span className="text-secondary">inconnu</span>;
  return (
    <span>
      {e.aheadCount} commit{e.aheadCount > 1 ? 's' : ''} non fusionné{e.aheadCount > 1 ? 's' : ''}
    </span>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('fr-FR')} ${n > 1 ? many : one}`;
const sumBytes = (list: DiskEntry[]) => list.reduce((s, e) => s + (e.bytes ?? 0), 0);
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Le dossier peut-il être supprimé à la main ? Un dossier connu de Skipper : les membres ; un dossier inconnu : les administrateurs. */
function deletable(e: DiskEntry, canWrite: boolean, isAdmin: boolean): boolean {
  return e.worksession ? canWrite : isAdmin && e.exists;
}

type Filter = 'all' | 'cleanable' | 'unmerged' | 'changes' | 'active' | 'archived' | 'orphan' | 'copy';
const FILTERS: [Filter, string, (e: DiskEntry) => boolean][] = [
  ['all', 'Tous les dossiers', () => true],
  ['cleanable', 'Fusionnés, nettoyables', (e) => e.cleanable],
  ['unmerged', 'Commits non fusionnés', (e) => !e.prMerged && (e.aheadCount ?? 0) > 0],
  ['changes', 'Fichiers modifiés', (e) => (e.changes ?? 0) > 0],
  ['active', 'Sessions actives', (e) => e.activeSessions > 0],
  ['archived', 'Archivés', (e) => Boolean(e.worksession?.archivedAt)],
  ['orphan', 'Inconnus de Skipper', (e) => !e.worksession],
  ['copy', 'Dépendances copiées', (e) => e.deps === 'COPY'],
];

/** Requête et rechargement de l'état des dossiers, partagés par la carte et sa modale. */
function useWorksessionDisk(projectId: string) {
  const [refreshing, setRefreshing] = useState(false);
  // Une mesure des tailles tourne en arrière-plan (une vingtaine de secondes sur un gros projet) : on réinterroge jusqu'à sa fin.
  const [poll, setPoll] = useState(0);
  const { data, loading, error, refetch } = usePollingQuery<{ project: { id: string; worksessionDisk: DiskReport } | null }>(PROJECT_WORKSESSION_DISK, {
    variables: { id: projectId, refresh: false },
    pollInterval: poll,
  });
  const report = data?.project?.worksessionDisk ?? null;
  useEffect(() => setPoll(report?.measuring ? 4000 : 0), [report?.measuring]);
  const reload = async (fresh = false) => {
    setRefreshing(fresh);
    try {
      await refetch({ id: projectId, refresh: fresh });
    } finally {
      setRefreshing(false);
    }
  };
  return { report, loading, error, reload, busy: (loading && refreshing) || Boolean(report?.measuring) };
}

/**
 * Dossiers de travail du projet sur disque (réglages du projet) : un résumé sur la page (place occupée, dossiers à
 * nettoyer, inconnus, sessions en cours), la liste détaillée dans une modale : tailles (dépendances partagées par liens
 * physiques comptées une fois), fusion de la branche, tâche liée, dernière activité ; suppression d'un dossier ou d'une
 * sélection, nettoyage des dossiers fusionnés, partage des dépendances, import des dossiers inconnus de Skipper.
 */
export default function WorksessionDiskCard({ projectId, canWrite, isAdmin }: { projectId: string; canWrite: boolean; isAdmin: boolean }) {
  const disk = useWorksessionDisk(projectId);
  const { report, loading, error } = disk;
  const [open, setOpen] = useState(false);
  const entries = report?.entries ?? [];
  const cleanable = entries.filter((e) => e.cleanable);
  const orphans = entries.filter((e) => !e.worksession);
  const copies = entries.filter((e) => e.deps === 'COPY');
  const running = entries.filter((e) => e.busySessions > 0);
  const archived = entries.filter((e) => e.worksession?.archivedAt);
  const unmerged = entries.filter((e) => !e.prMerged && (e.aheadCount ?? 0) > 0);
  // Les entrées arrivent triées par taille : les plus gros dossiers d'abord.
  const biggest = entries.filter((e) => e.bytes).slice(0, 4);
  const manage = canWrite || isAdmin;

  return (
    <Card className="mt-3">
      <Card.Header className="d-flex align-items-center justify-content-between gap-2">
        <span>Dossiers de travail</span>
        <Button size="sm" variant="outline-secondary" onClick={() => setOpen(true)} disabled={!report}>
          {manage ? 'Voir et gérer' : 'Voir'}
        </Button>
      </Card.Header>
      <Card.Body className="small" role={report ? 'button' : undefined} title={report ? 'Voir la liste détaillée' : undefined} onClick={() => report && setOpen(true)}>
        {error && <Alert variant="danger" className="mb-0">{error.message}</Alert>}
        {!report && loading && (
          <div className="text-secondary">
            <Spinner size="sm" animation="border" className="me-2" />
            Mesure de la place occupée…
          </div>
        )}
        {report && entries.length === 0 && <span className="text-secondary">Aucun dossier de travail : chaque session en aura un, à côté du checkout principal.</span>}
        {report && entries.length > 0 && (
          <>
            <div>
              <strong>{plural(entries.length, 'dossier')}</strong>
              {report.totalBytes !== null && (
                <>
                  {' '}
                  · {formatBytes(report.totalBytes)} au total{report.sharedBytes ? `, dont ${formatBytes(report.sharedBytes)} de dépendances partagées` : ''}
                </>
              )}
              {report.measuring && <span className="text-secondary"> · mesure en cours…</span>}
            </div>
            <div className="d-flex flex-wrap gap-1 mt-2 align-items-center">
              {cleanable.length > 0 && (
                <Badge bg="success">
                  {plural(cleanable.length, 'fusionné nettoyable', 'fusionnés nettoyables')} · {formatBytes(sumBytes(cleanable))}
                </Badge>
              )}
              {running.length > 0 && <Badge bg="primary">{plural(running.length, 'session en cours', 'sessions en cours')}</Badge>}
              {unmerged.length > 0 && (
                <Badge bg="light" text="dark" className="border fw-normal">
                  {plural(unmerged.length, 'branche non fusionnée', 'branches non fusionnées')}
                </Badge>
              )}
              {archived.length > 0 && <Badge bg="secondary">{plural(archived.length, 'archivé')}</Badge>}
              {orphans.length > 0 && (
                <Badge bg="warning" text="dark">
                  {plural(orphans.length, 'inconnu de Skipper', 'inconnus de Skipper')}
                </Badge>
              )}
              {copies.length > 0 && (
                <Badge bg="light" text="dark" className="border fw-normal">
                  {plural(copies.length, 'dossier', 'dossiers')} aux dépendances copiées
                </Badge>
              )}
            </div>
            {biggest.length > 0 && (
              <div className="d-flex flex-wrap gap-1 mt-2 align-items-center">
                <span className="text-secondary me-1">Les plus gros :</span>
                {biggest.map((e) => (
                  <Badge key={e.name} bg="light" text="dark" className="border font-monospace fw-normal text-truncate" style={{ maxWidth: '18rem' }} title={e.branch ?? e.name}>
                    {e.branch ?? e.name} {formatBytes(e.bytes)}
                  </Badge>
                ))}
              </div>
            )}
          </>
        )}
      </Card.Body>
      {open && report && <WorksessionDiskModal projectId={projectId} canWrite={canWrite} isAdmin={isAdmin} report={report} disk={disk} onClose={() => setOpen(false)} />}
    </Card>
  );
}

function WorksessionDiskModal({
  projectId,
  canWrite,
  isAdmin,
  report,
  disk,
  onClose,
}: {
  projectId: string;
  canWrite: boolean;
  isAdmin: boolean;
  report: DiskReport;
  disk: ReturnType<typeof useWorksessionDisk>;
  onClose: () => void;
}) {
  const { confirm, alert, showError } = useDialogs();
  const [clean, { loading: cleaning }] = useMutation<{ cleanMergedWorksessions: { removed: string[]; freedBytes: number; skipped: { name: string; reason: string }[] } }>(CLEAN_MERGED);
  const [shareDeps, { loading: sharing }] = useMutation<{ shareWorksessionDeps: { relinked: string[]; skipped: { name: string; reason: string }[] } }>(SHARE_DEPS);
  const [deleteWorksession] = useMutation(DELETE_WORKSESSION);
  const [importOrphan] = useMutation(IMPORT_ORPHAN);
  const [deleteOrphan] = useMutation(DELETE_ORPHAN);
  const [deleting, setDeleting] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const { reload } = disk;
  const entries = report.entries;
  const cleanable = entries.filter((e) => e.cleanable);
  const orphans = entries.filter((e) => !e.worksession);
  const copies = entries.filter((e) => e.deps === 'COPY');
  const working = deleting || cleaning;

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const keep = FILTERS.find(([f]) => f === filter)?.[2] ?? (() => true);
    return entries.filter(
      (e) => keep(e) && (!q || [e.name, e.branch, e.worksession?.label, e.worksession?.task?.title].some((v) => v?.toLowerCase().includes(q))),
    );
  }, [entries, search, filter]);
  // La sélection ne garde que les dossiers encore listés et supprimables.
  const selected = entries.filter((e) => picked.has(e.name) && deletable(e, canWrite, isAdmin));
  const shownDeletable = shown.filter((e) => deletable(e, canWrite, isAdmin));
  const allShownPicked = shownDeletable.length > 0 && shownDeletable.every((e) => picked.has(e.name));
  const selectable = canWrite || isAdmin;
  const toggle = (name: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  const toggleShown = (on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const e of shownDeletable) {
        if (on) next.add(e.name);
        else next.delete(e.name);
      }
      return next;
    });

  /**
   * Supprime des dossiers : les fusionnés par le nettoyage (branche locale supprimée, ses commits sont ailleurs), les autres
   * dossiers connus par la suppression de leur work session (sessions arrêtées puis archivées avec leur historique, branche
   * conservée), les inconnus de Skipper par leur suppression (branche conservée). La confirmation dit ce qui sera perdu.
   */
  const deleteFolders = async (targets: DiskEntry[]) => {
    if (!targets.length) return;
    const lost = targets.filter((e) => (e.changes ?? 0) > 0);
    const busy = targets.filter((e) => e.busySessions > 0);
    const active = targets.filter((e) => e.activeSessions > 0 && !e.worksession?.archivedAt);
    const unmerged = targets.filter((e) => e.worksession && !e.cleanable && !e.prMerged && (e.aheadCount ?? 0) > 0);
    const unknown = targets.filter((e) => !e.worksession);
    const label = (e: DiskEntry) => <code>{e.branch ?? e.name}</code>;
    const list = (l: DiskEntry[]) => l.slice(0, 5).map((e, i) => <span key={e.name}>{i > 0 && ', '}{label(e)}</span>);
    const more = (l: DiskEntry[]) => (l.length > 5 ? ` et ${l.length - 5} autre${l.length - 5 > 1 ? 's' : ''}` : '');
    const ok = await confirm({
      title: targets.length === 1 ? 'Supprimer le dossier de travail' : `Supprimer ${targets.length} dossiers de travail`,
      message: (
        <>
          <p>
            Supprimer {targets.length === 1 ? <>le dossier de {label(targets[0])}</> : `ces ${targets.length} dossiers`} (environ {formatBytes(sumBytes(targets))}) ? Leurs sessions sont archivées
            avec leur historique ; les branches sont conservées, sauf celles des dossiers fusionnés dont les commits sont déjà dans la branche principale ou sur origin.
          </p>
          {(lost.length > 0 || busy.length > 0 || active.length > 0 || unmerged.length > 0 || unknown.length > 0) && (
            <ul className="small mb-0">
              {lost.length > 0 && (
                <li className="text-danger">
                  Modifications non commitées perdues : {list(lost)}
                  {more(lost)}.
                </li>
              )}
              {busy.length > 0 && (
                <li className="text-danger">
                  Session au travail, arrêtée : {list(busy)}
                  {more(busy)}.
                </li>
              )}
              {active.length > 0 && (
                <li>
                  Sessions actives, archivées : {list(active)}
                  {more(active)}.
                </li>
              )}
              {unmerged.length > 0 && (
                <li>
                  Commits non fusionnés, gardés dans leur branche : {list(unmerged)}
                  {more(unmerged)}.
                </li>
              )}
              {unknown.length > 0 && (
                <li>
                  Dossiers inconnus de Skipper : {list(unknown)}
                  {more(unknown)}.
                </li>
              )}
            </ul>
          )}
        </>
      ),
      confirmLabel: targets.length === 1 ? 'Supprimer' : `Supprimer ${targets.length} dossiers`,
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    const failed: { name: string; reason: string }[] = [];
    const removed = new Set<string>();
    try {
      const merged = targets.filter((e) => e.cleanable && e.worksession);
      if (merged.length) {
        try {
          const res = await clean({ variables: { projectId, names: merged.map((e) => e.name) } });
          for (const n of res.data?.cleanMergedWorksessions.removed ?? []) removed.add(n);
          failed.push(...(res.data?.cleanMergedWorksessions.skipped ?? []));
        } catch (err) {
          failed.push(...merged.map((e) => ({ name: e.name, reason: messageOf(err) })));
        }
      }
      for (const e of targets.filter((t) => !(t.cleanable && t.worksession))) {
        try {
          if (e.worksession) await deleteWorksession({ variables: { id: e.worksession.id } });
          else await deleteOrphan({ variables: { projectId, name: e.name } });
          removed.add(e.name);
        } catch (err) {
          failed.push({ name: e.name, reason: messageOf(err) });
        }
      }
    } finally {
      setPicked((prev) => new Set([...prev].filter((n) => !removed.has(n))));
      setDeleting(false);
    }
    await reload();
    if (failed.length)
      await alert({
        title: failed.length === 1 ? 'Dossier conservé' : 'Dossiers conservés',
        message: (
          <ul className="mb-0">
            {failed.map((s) => (
              <li key={s.name}>
                <code>{s.name}</code> : {s.reason}
              </li>
            ))}
          </ul>
        ),
      });
  };

  const shareAll = async () => {
    const ok = await confirm({
      title: 'Partager les dépendances',
      message: `Remplacer les node_modules installés à part dans ${copies.length === 1 ? 'un dossier' : `${copies.length} dossiers`} par l'instantané de même lockfile, lié (même contenu, aucune place en plus) ? Les dossiers où une session, un terminal, un aperçu ou une installation tourne sont laissés tels quels.`,
      confirmLabel: 'Partager',
    });
    if (!ok) return;
    try {
      const res = await shareDeps({ variables: { projectId, names: copies.map((e) => e.name) } });
      const r = res.data?.shareWorksessionDeps;
      if (r?.skipped.length) await alert({ title: 'Dossiers laissés tels quels', message: <ul className="mb-0">{r.skipped.map((x) => <li key={x.name}>{x.name} : {x.reason}</li>)}</ul> });
    } catch (err) {
      await showError(err);
    }
    await reload(true);
  };

  return (
    <Modal show onHide={onClose} size="xl" scrollable>
      <Modal.Header closeButton>
        <Modal.Title>
          Dossiers de travail
          <span className="text-secondary small fw-normal ms-2">
            {formatBytes(report.totalBytes)} au total{report.sharedBytes ? `, dont ${formatBytes(report.sharedBytes)} de dépendances partagées` : ''}
          </span>
        </Modal.Title>
      </Modal.Header>
      <Modal.Body className="small">
        <p className="text-secondary">
          Chaque session travaille dans son dossier, à côté du checkout principal. Les dépendances (<code>node_modules</code>) installées une fois sont partagées par liens physiques entre dossiers de même
          lockfile : elles ne comptent qu'une fois, dans « dépendances partagées ». Un dossier est nettoyable quand rien n'y tourne, qu'il n'a pas de modification non commitée et que sa branche est
          fusionnée ; les autres se suppriment aussi à la main, la confirmation dit ce qui serait perdu.
        </p>
        {orphans.length > 0 && (
          <Alert variant="warning" className="py-2">
            {orphans.length === 1 ? 'Un dossier est inconnu' : `${orphans.length} dossiers sont inconnus`} de Skipper (créés à la main, ou dont la session a disparu) : importez-les pour y travailler depuis
            Skipper, ou supprimez-les{isAdmin ? '' : ' (administrateurs)'}.
          </Alert>
        )}
        <div className="d-flex flex-wrap gap-2 align-items-center mb-2">
          <Form.Control size="sm" type="search" placeholder="Filtrer (branche, tâche)…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 260 }} autoFocus />
          <Form.Select size="sm" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} style={{ width: 'auto' }} aria-label="Dossiers montrés">
            {FILTERS.map(([f, text, keep]) => {
              const n = entries.filter(keep).length;
              return (
                (f === 'all' || n > 0 || f === filter) && (
                  <option key={f} value={f}>
                    {text} ({n})
                  </option>
                )
              );
            })}
          </Form.Select>
          <Button size="sm" variant="outline-secondary" disabled={disk.busy} onClick={() => void reload(true)} title="Mesurer à nouveau (les tailles sont gardées 10 minutes) et mettre à jour les branches d'origin">
            {disk.busy ? <Spinner size="sm" animation="border" /> : <i className="bi bi-arrow-clockwise" />}
          </Button>
          <span className="text-secondary ms-auto">
            {shown.length === entries.length ? plural(entries.length, 'dossier') : `${shown.length} sur ${entries.length}`}
            {report.measuring ? ' · mesure en cours…' : report.computedAt ? ` · mesuré ${timeAgo(report.computedAt)}` : ''}
          </span>
        </div>
        <Table size="sm" hover className="align-middle mb-0 table-stack">
          <thead>
            <tr>
              {selectable && (
                <th style={{ width: 28 }}>
                  <Form.Check
                    aria-label="Tout sélectionner"
                    title="Sélectionner tous les dossiers montrés"
                    checked={allShownPicked}
                    disabled={!shownDeletable.length}
                    onChange={(e) => toggleShown(e.target.checked)}
                  />
                </th>
              )}
              <th>Branche</th>
              <th className="text-end">Taille</th>
              <th>Fusion</th>
              <th className="d-none d-lg-table-cell">Tâche</th>
              <th className="d-none d-md-table-cell">Activité</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={7} className="text-secondary">
                  {entries.length === 0 ? 'Aucun dossier de travail.' : 'Aucun dossier ne correspond au filtre.'}
                </td>
              </tr>
            )}
            {shown.map((e) => {
              const canDel = deletable(e, canWrite, isAdmin);
              return (
                <tr key={e.name} className={picked.has(e.name) && canDel ? 'table-active' : undefined}>
                  {selectable && (
                    <td>
                      {canDel && <Form.Check aria-label={`Sélectionner ${e.branch ?? e.name}`} checked={picked.has(e.name)} onChange={(ev) => toggle(e.name, ev.target.checked)} />}
                    </td>
                  )}
                  <td>
                    <span className="font-monospace text-break" title={`Dossier ${e.name}`}>
                      {e.branch ?? e.name}
                    </span>
                    {!e.worksession && e.branch !== e.name && <div className="text-secondary">dossier {e.name}</div>}
                    <div>
                      {!e.worksession && (
                        <Badge bg="warning" text="dark" className="me-1">
                          inconnu de Skipper
                        </Badge>
                      )}
                      {e.worksession?.archivedAt && (
                        <Badge bg="secondary" className="me-1">
                          archivé
                        </Badge>
                      )}
                      {e.busySessions > 0 && (
                        <Badge bg="primary" className="me-1">
                          session en cours
                        </Badge>
                      )}
                      {!e.exists && (
                        <Badge bg="light" text="dark" className="me-1">
                          absent du disque
                        </Badge>
                      )}
                      {!!e.changes && <span className="text-warning">{plural(e.changes, 'fichier modifié', 'fichiers modifiés')}</span>}
                    </div>
                  </td>
                  <td className="text-end text-nowrap">
                    {formatBytes(e.bytes)}
                    {e.deps === 'COPY' && (
                      <div className="text-warning" title="node_modules installés à part : « Partager les dépendances » les remplace par l'instantané lié">
                        dépendances copiées
                      </div>
                    )}
                    {e.deps === 'LINKED' && <div className="text-secondary">dépendances partagées</div>}
                  </td>
                  <td>
                    <MergeState e={e} />
                    {e.cleanable ? (
                      <div className="text-success">nettoyable</div>
                    ) : (
                      e.worksession &&
                      e.blocker &&
                      // Les commits non fusionnés et les fichiers modifiés se lisent déjà à côté : seul un autre motif est montré.
                      !/non fusionn|non commit/.test(e.blocker) && (
                        <div className="text-secondary" title="Pourquoi le nettoyage des dossiers fusionnés le garde">
                          {e.blocker}
                        </div>
                      )
                    )}
                  </td>
                  <td className="d-none d-lg-table-cell">
                    {e.worksession?.task ? (
                      <>
                        <Link to={`/tasks/${e.worksession.task.id}`} className="d-block text-truncate" style={{ maxWidth: '20rem' }} title={e.worksession.task.title} onClick={onClose}>
                          {e.worksession.task.title}
                        </Link>
                        <TaskStatusBadge status={e.worksession.task.status} statusTag={e.worksession.task.statusTag} />
                      </>
                    ) : (
                      <span className="text-secondary">—</span>
                    )}
                  </td>
                  <td className="d-none d-md-table-cell text-secondary text-nowrap">{e.lastActivityAt ? timeAgo(e.lastActivityAt) : '—'}</td>
                  <td className="text-end text-nowrap">
                    {!e.worksession && canWrite && e.gitWorktree && e.branch && (
                      <Button
                        size="sm"
                        variant="outline-secondary"
                        className="me-2"
                        disabled={working}
                        onClick={async () => {
                          await importOrphan({ variables: { projectId, name: e.name } }).catch(showError);
                          await reload();
                        }}
                      >
                        Importer
                      </Button>
                    )}
                    {canDel && (
                      <Button size="sm" variant="outline-danger" disabled={working} onClick={() => void deleteFolders([e])}>
                        Supprimer
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Modal.Body>
      {selectable && (
        <Modal.Footer className="small justify-content-between">
          <div className="d-flex gap-2 align-items-center flex-wrap">
            <Button size="sm" variant="danger" disabled={!selected.length || working} onClick={() => void deleteFolders(selected)}>
              {deleting ? <Spinner size="sm" animation="border" className="me-1" /> : <i className="bi bi-trash me-1" />}
              {selected.length ? `Supprimer la sélection (${selected.length}, ${formatBytes(sumBytes(selected))})` : 'Supprimer la sélection'}
            </Button>
            {selected.length > 0 && (
              <Button size="sm" variant="link" className="text-secondary" onClick={() => setPicked(new Set())}>
                Tout désélectionner
              </Button>
            )}
          </div>
          <div className="d-flex gap-2 align-items-center flex-wrap">
            {canWrite && copies.length > 0 && (
              <Button size="sm" variant="outline-primary" disabled={sharing} onClick={() => void shareAll()} title="Dossiers dont les node_modules sont une copie complète de l'instantané de même lockfile">
                <i className="bi bi-link-45deg me-1" />
                Partager les dépendances ({copies.length})
              </Button>
            )}
            {canWrite && cleanable.length > 0 && (
              <Button size="sm" variant="outline-danger" disabled={working} onClick={() => void deleteFolders(cleanable)}>
                Nettoyer les dossiers fusionnés ({cleanable.length}, {formatBytes(sumBytes(cleanable))})
              </Button>
            )}
          </div>
        </Modal.Footer>
      )}
    </Modal>
  );
}
