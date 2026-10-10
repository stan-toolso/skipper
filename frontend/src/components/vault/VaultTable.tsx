import { useMutation } from '@apollo/client';
import { Fragment, useState } from 'react';
import { Alert, Badge, Button, Table } from 'react-bootstrap';
import { useAuth } from '../../auth/AuthContext';
import type { Project } from '../../graphql/operations';
import { DELETE_VAULT_ITEM, TEST_VAULT_ITEM, type VaultItem } from '../../graphql/vault';
import { useDialogs } from '../Dialogs';
import VaultItemDetails from './VaultItemDetails';
import { daysToExpiry, fmtDate, isOauthToken, isSkipperKind, KINDS, ownerLabelOf, targetOf } from './kinds';

export interface VaultRow {
  item: VaultItem;
  /** Colonne « Accès » de la page projet. */
  access?: React.ReactNode;
  /** Action supplémentaire (retirer du projet). */
  extraAction?: React.ReactNode;
}

interface Props {
  rows: VaultRow[];
  projects: Project[];
  /** Élément dont les détails sont ouverts (ex. création, lien profond). */
  openId?: string | null;
  onOpenChange?: (id: string | null) => void;
  onEdit: (item: VaultItem) => void;
  projectPage?: boolean;
  browserDisabled?: boolean;
  empty: React.ReactNode;
}

function PolicyBadges({ item }: { item: VaultItem }) {
  const badges: React.ReactNode[] = [];
  if (item.kind === 'postgres' || item.kind === 'api') badges.push(item.readOnly ? <Badge key="ro" bg="success">lecture seule</Badge> : <Badge key="rw" bg="warning" text="dark">écriture</Badge>);
  if (item.kind === 'ssh' || item.kind === 'postgres' || item.kind === 'api') badges.push(item.requireApproval ? <Badge key="ap" bg="primary">avec accord</Badge> : <Badge key="nap" bg="secondary">sans accord</Badge>);
  if (isSkipperKind(item.kind)) badges.push(<Badge key="sk" bg="secondary" title="Jamais offert aux agents : utilisé par Skipper pour vos réglages">réservé à Skipper</Badge>);
  if (isOauthToken(item)) badges.push(<Badge key="oa" bg="info" text="dark">connexion</Badge>);
  if (item.kind === 'google' && item.google) {
    if (item.google.gmailAccess !== 'NONE') badges.push(<Badge key="gm" bg={item.google.gmailAccess === 'WRITE' ? 'warning' : 'success'} text={item.google.gmailAccess === 'WRITE' ? 'dark' : undefined}>Gmail {item.google.gmailAccess === 'WRITE' ? 'écriture' : 'lecture'}</Badge>);
    if (item.google.driveAccess !== 'NONE') badges.push(<Badge key="dr" bg={item.google.driveAccess === 'WRITE' ? 'warning' : 'success'} text={item.google.driveAccess === 'WRITE' ? 'dark' : undefined}>Drive {item.google.driveAccess === 'WRITE' ? 'écriture' : 'lecture'}</Badge>);
  }
  return <span className="d-inline-flex gap-1 flex-wrap">{badges}</span>;
}

/** Tableau des éléments du coffre, commun aux pages personnelle et projet. */
export default function VaultTable({ rows, projects, openId, onOpenChange, onEdit, projectPage = false, browserDisabled = false, empty }: Props) {
  const { user } = useAuth();
  const { confirm } = useDialogs();
  const [localOpen, setLocalOpen] = useState<string | null>(null);
  const open = openId !== undefined ? openId : localOpen;
  const setOpen = (id: string | null) => {
    setLocalOpen(id);
    onOpenChange?.(id);
  };
  const [notices, setNotices] = useState<Record<string, { ok: boolean; text: string }>>({});
  const notice = (id: string, ok: boolean, text: string) => setNotices((n) => ({ ...n, [id]: { ok, text } }));
  const clear = (id: string) =>
    setNotices((n) => {
      const next = { ...n };
      delete next[id];
      return next;
    });
  const [test, { loading: testing }] = useMutation<{ testVaultItem: { ok: boolean; error: string | null; detail: string | null } }>(TEST_VAULT_ITEM, { refetchQueries: ['VaultItems', 'VaultProject'] });
  const [remove] = useMutation(DELETE_VAULT_ITEM, { refetchQueries: ['VaultItems', 'VaultProject', 'Sidebar'] });
  const [testingId, setTestingId] = useState<string | null>(null);

  const runTest = async (item: VaultItem) => {
    setTestingId(item.id);
    clear(item.id);
    try {
      const res = await test({ variables: { id: item.id } });
      const r = res.data?.testVaultItem;
      if (r) notice(item.id, r.ok, r.ok ? `Test réussi${r.detail ? ` : ${r.detail}` : ''}` : `Échec : ${r.error ?? 'erreur inconnue'}`);
    } catch (err) {
      notice(item.id, false, (err as Error).message);
    } finally {
      setTestingId(null);
    }
  };
  const runDelete = async (item: VaultItem) => {
    const ok = await confirm({
      title: "Supprimer l'élément",
      message: isSkipperKind(item.kind)
        ? `Supprimer « ${item.name} » du coffre ? Les réglages qui s'y réfèrent (Claude, OpenCode, GitHub, agents à appel direct) le perdront et devront en choisir un autre ; le journal est conservé.`
        : `Supprimer « ${item.name} » du coffre ? Les sessions qui l'utilisent ne pourront plus s'en servir ; le journal est conservé.${item.kind === 'google' ? ' L’accès accordé à Skipper sera révoqué chez Google.' : ''}`,
      confirmLabel: 'Supprimer',
      danger: true,
    });
    if (!ok) return;
    try {
      await remove({ variables: { id: item.id } });
      if (open === item.id) setOpen(null);
    } catch (err) {
      notice(item.id, false, (err as Error).message);
    }
  };

  return (
    <Table hover size="sm" className="align-middle vault-table">
      <thead>
        <tr>
          <th style={{ width: 24 }} />
          <th>Nom</th>
          <th>Type</th>
          <th>Cible</th>
          {projectPage ? <th>Accès</th> : <th>Propriétaire</th>}
          <th>Règles</th>
          <th>Dernier test</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={8} className="text-secondary fst-italic">
              {empty}
            </td>
          </tr>
        )}
        {rows.map(({ item, access, extraAction }) => {
          const manage = item.myPermission === 'MANAGE';
          const expanded = open === item.id;
          const days = daysToExpiry(item);
          const n = notices[item.id];
          return (
            <Fragment key={item.id}>
              <tr className={`vault-row${expanded ? ' open' : ''}`} onClick={() => setOpen(expanded ? null : item.id)} role="button">
                <td className="text-secondary">
                  <i className={`bi bi-chevron-${expanded ? 'down' : 'right'} small`} />
                </td>
                <td>
                  <strong>{item.name}</strong>
                  {days !== null && days < 0 && <Badge bg="danger" className="ms-2">expiré</Badge>}
                  {days !== null && days >= 0 && days < 30 && <Badge bg="warning" text="dark" className="ms-2">expire dans {days} j</Badge>}
                  {item.description && <div className="small text-secondary text-truncate" style={{ maxWidth: 320 }}>{item.description}</div>}
                </td>
                <td className="text-nowrap">
                  <i className={`bi ${KINDS[item.kind].icon} me-1 text-secondary`} />
                  {KINDS[item.kind].label}
                </td>
                <td className="small font-monospace text-break" style={{ maxWidth: 320 }}>
                  {targetOf(item)}
                </td>
                <td className="small">{projectPage ? access : ownerLabelOf(item, user?.id)}</td>
                <td>
                  <PolicyBadges item={item} />
                </td>
                <td className="small text-nowrap">
                  {item.lastTestAt ? (
                    <>
                      {item.lastTestOk ? <Badge bg="success">OK</Badge> : <Badge bg="danger">échec</Badge>} <span className="text-secondary">{fmtDate(item.lastTestAt)}</span>
                    </>
                  ) : (
                    <span className="text-secondary">jamais testé</span>
                  )}
                </td>
                <td className="text-end text-nowrap" onClick={(e) => e.stopPropagation()}>
                  {extraAction}
                  {manage && (
                    <>
                      <Button size="sm" variant="link" className="p-0 px-1" disabled={testing && testingId === item.id} title="Tester la connexion" onClick={() => void runTest(item)}>
                        {testing && testingId === item.id ? <span className="spinner-border spinner-border-sm" /> : 'Tester'}
                      </Button>
                      <Button size="sm" variant="link" className="p-0 px-1" title="Modifier" onClick={() => onEdit(item)}>
                        <i className="bi bi-pencil" />
                      </Button>
                      <Button size="sm" variant="link" className="p-0 px-1 text-danger" title="Supprimer" onClick={() => void runDelete(item)}>
                        <i className="bi bi-trash" />
                      </Button>
                    </>
                  )}
                </td>
              </tr>
              {n && (
                <tr className="vault-notice">
                  <td />
                  <td colSpan={7}>
                    <Alert variant={n.ok ? 'success' : 'danger'} className="py-1 my-1 small" dismissible onClose={() => clear(item.id)}>
                      {n.text}
                    </Alert>
                  </td>
                </tr>
              )}
              {expanded && (
                <tr className="vault-expanded">
                  <td />
                  <td colSpan={7}>
                    <VaultItemDetails item={item} projects={projects} projectPage={projectPage} browserDisabled={browserDisabled} onEdited={() => undefined} />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </Table>
  );
}
