import { useMutation } from '@apollo/client';
import { Fragment, useState } from 'react';
import { Alert, Badge, Button, Table } from 'react-bootstrap';
import { useAuth } from '../../auth/AuthContext';
import type { Project } from '../../graphql/operations';
import { DELETE_VAULT_ITEM, DUPLICATE_VAULT_ITEM, TEST_VAULT_ITEM, type VaultItem } from '../../graphql/vault';
import { useDialogs } from '../Dialogs';
import VaultItemDetails from './VaultItemDetails';
import { daysToExpiry, fmtDate, isOauthToken, isSkipperKind, KINDS, NAME_PATTERN, ownerLabelOf, targetOf } from './kinds';

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
  if (item.kind === 'postgres' || item.kind === 'api' || item.kind === 'aws' || item.kind === 'scaleway') badges.push(item.readOnly ? <Badge key="ro" bg="success">lecture seule</Badge> : <Badge key="rw" bg="warning" text="dark">écriture</Badge>);
  if (item.kind === 'ssh' || item.kind === 'postgres' || item.kind === 'api' || item.kind === 'aws' || item.kind === 'scaleway') badges.push(item.requireApproval ? <Badge key="ap" bg="primary">avec accord</Badge> : <Badge key="nap" bg="secondary">sans accord</Badge>);
  if (item.kind === 'aws' && item.aws?.auth === 'sso') badges.push(item.aws.connected ? <Badge key="cx" bg="info" text="dark">connecté</Badge> : <Badge key="ncx" bg="danger">à connecter</Badge>);
  if (isSkipperKind(item.kind)) badges.push(<Badge key="sk" bg="secondary" title="Jamais offert aux agents : utilisé par Skipper pour vos réglages">réservé à Skipper</Badge>);
  if (isOauthToken(item)) badges.push(<Badge key="oa" bg="info" text="dark">connexion</Badge>);
  if (item.kind === 'google' && item.google) {
    if (item.google.gmailAccess !== 'NONE') badges.push(<Badge key="gm" bg={item.google.gmailAccess === 'WRITE' ? 'warning' : 'success'} text={item.google.gmailAccess === 'WRITE' ? 'dark' : undefined}>Gmail {item.google.gmailAccess === 'WRITE' ? 'écriture' : 'lecture'}</Badge>);
    if (item.google.driveAccess !== 'NONE') badges.push(<Badge key="dr" bg={item.google.driveAccess === 'WRITE' ? 'warning' : 'success'} text={item.google.driveAccess === 'WRITE' ? 'dark' : undefined}>Drive {item.google.driveAccess === 'WRITE' ? 'écriture' : 'lecture'}</Badge>);
  }
  return <span className="d-inline-flex gap-1 flex-nowrap">{badges}</span>;
}

/** Tableau des éléments du coffre, commun aux pages personnelle et projet. */
export default function VaultTable({ rows, projects, openId, onOpenChange, onEdit, projectPage = false, browserDisabled = false, empty }: Props) {
  const { user } = useAuth();
  const { confirm, prompt } = useDialogs();
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
  const [duplicate] = useMutation<{ duplicateVaultItem: VaultItem }>(DUPLICATE_VAULT_ITEM, { refetchQueries: ['VaultItems', 'VaultProject', 'Sidebar'] });
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
  /** Copie dans le même coffre, secrets compris, sous le nom demandé ; la copie s'ouvre ensuite dans l'éditeur pour l'ajuster. */
  const runDuplicate = async (item: VaultItem) => {
    const name = await prompt({
      title: `Dupliquer « ${item.name} »`,
      message: 'Une copie de cet élément, secrets compris, sera créée dans le même coffre sous ce nom (partages, ouvertures aux projets et journal ne sont pas copiés). Vous pourrez ensuite la modifier.',
      defaultValue: `${item.name.slice(0, 34)}-copie`,
      placeholder: 'nom de la copie',
      confirmLabel: 'Dupliquer',
    });
    if (name === null) return;
    if (!NAME_PATTERN.test(name.trim().toLowerCase())) return notice(item.id, false, 'Nom invalide : minuscules, chiffres, tirets et tirets bas, 40 caractères au plus.');
    try {
      const res = await duplicate({ variables: { id: item.id, name: name.trim().toLowerCase() } });
      const copy = res.data?.duplicateVaultItem;
      if (copy) {
        setOpen(copy.id);
        onEdit(copy);
      }
    } catch (err) {
      notice(item.id, false, (err as Error).message);
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
    <Table hover responsive size="sm" className="align-middle vault-table">
      <thead>
        <tr>
          <th style={{ width: 24 }} />
          <th>Nom</th>
          <th>Type</th>
          <th className="d-none d-md-table-cell">Cible</th>
          {projectPage ? <th className="d-none d-md-table-cell">Accès</th> : <th className="d-none d-md-table-cell">Propriétaire</th>}
          <th className="d-none d-md-table-cell">Règles</th>
          <th className="d-none d-md-table-cell">Dernier test</th>
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
                  <div className="vault-cell-name">
                    <strong>{item.name}</strong>
                    {days !== null && days < 0 && <Badge bg="danger">expiré</Badge>}
                    {days !== null && days >= 0 && days < 30 && <Badge bg="warning" text="dark">expire dans {days} j</Badge>}
                    {item.description && (
                      <span className="small text-secondary vault-cell-desc" title={item.description}>
                        {item.description}
                      </span>
                    )}
                  </div>
                </td>
                <td className="text-nowrap">
                  <i className={`bi ${KINDS[item.kind].icon} me-1 text-secondary`} title={KINDS[item.kind].label} />
                  <span className="d-none d-md-inline">{KINDS[item.kind].label}</span>
                </td>
                <td className="small font-monospace vault-cell-target d-none d-md-table-cell" title={targetOf(item)}>
                  {targetOf(item)}
                </td>
                <td className="small d-none d-md-table-cell">{projectPage ? access : ownerLabelOf(item, user?.id)}</td>
                <td className="d-none d-md-table-cell">
                  <PolicyBadges item={item} />
                </td>
                <td className="small text-nowrap d-none d-md-table-cell">
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
                      {item.kind !== 'google' && !isOauthToken(item) && (
                        <Button size="sm" variant="link" className="p-0 px-1" title="Dupliquer dans le même coffre" onClick={() => void runDuplicate(item)}>
                          <i className="bi bi-copy" />
                        </Button>
                      )}
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
