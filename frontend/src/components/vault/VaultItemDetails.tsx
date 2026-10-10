import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Form, InputGroup, Nav, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import type { Project } from '../../graphql/operations';
import {
  COPY_VAULT_ITEM,
  FORGET_VAULT_HOST_KEY,
  LINK_VAULT_ITEM,
  REGENERATE_VAULT_KEY,
  REVEAL_VAULT_SECRET,
  SHARE_VAULT_ITEM,
  UNLINK_VAULT_ITEM,
  UNSHARE_VAULT_ITEM,
  VAULT_ITEM_DETAILS,
  VAULT_SHARE_CANDIDATES,
  type VaultAuditEvent,
  type VaultItem,
  type VaultLink,
  type VaultLinkScope,
  type VaultPermission,
  type VaultShare,
} from '../../graphql/vault';
import { useDialogs } from '../Dialogs';
import { agentToolsOf, daysToExpiry, fmtDate, fmtDay, isOauthToken, isSkipperKind, PERMISSION_LABELS, skipperUsageOf } from './kinds';

type Tab = 'details' | 'shares' | 'links' | 'audit';
const REFETCH = ['VaultItems', 'VaultProject', 'VaultItemDetails'];

const ACTION_LABELS: Record<string, string> = {
  created: 'création',
  updated: 'modification',
  deleted: 'suppression',
  revealed: 'secret révélé',
  shared: 'partage',
  unshared: 'partage retiré',
  linked: 'ouvert à un projet',
  unlinked: 'retiré d’un projet',
  copied: 'copie',
  tested: 'test',
  used: 'usage par un agent',
  key_regenerated: 'clé régénérée',
  host_key_forgotten: 'clé d’hôte oubliée',
  connected: 'connexion Google',
};

const fieldLabel = (item: VaultItem, field: string) =>
  field === 'password' ? 'Mot de passe' : field === 'secretKey' ? 'Clé secrète' : field === 'token' ? (item.kind === 'litellm' ? "Clé d'API" : item.authScheme === 'basic' ? 'Mot de passe' : 'Jeton') : (item.fields.find((f) => f.key === field)?.label ?? field);

/** Une ligne « révéler » : la valeur est demandée au serveur (journalisée) et masquée après 30 s. */
function RevealRow({ item, field }: { item: VaultItem; field: string }) {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, { loading }] = useMutation<{ revealVaultSecret: { value: string } }>(REVEAL_VAULT_SECRET);
  useEffect(() => {
    if (value === null) return;
    const t = setTimeout(() => setValue(null), 30_000);
    return () => clearTimeout(t);
  }, [value]);
  return (
    <div className="d-flex align-items-center gap-2 flex-wrap">
      <span className="text-secondary">{fieldLabel(item, field)}</span>
      {value === null ? (
        <Button
          size="sm"
          variant="outline-secondary"
          disabled={loading}
          onClick={async () => {
            setError(null);
            try {
              const res = await reveal({ variables: { id: item.id, field } });
              setValue(res.data?.revealVaultSecret.value ?? '');
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <i className="bi bi-eye me-1" /> Révéler
        </Button>
      ) : (
        <>
          <code className="user-select-all">{value}</code>
          <Button size="sm" variant="link" className="p-0" onClick={() => void navigator.clipboard?.writeText(value)}>
            Copier
          </Button>
          <Button size="sm" variant="link" className="p-0 text-secondary" onClick={() => setValue(null)}>
            Masquer
          </Button>
          <span className="text-secondary small">masqué dans 30 s · journalisé</span>
        </>
      )}
      {error && <span className="text-danger small">{error}</span>}
    </div>
  );
}

function DetailsTab({ item, projectPage, browserDisabled, onEdited }: { item: VaultItem; projectPage: boolean; browserDisabled: boolean; onEdited: (item: VaultItem) => void }) {
  const { user } = useAuth();
  const { confirm, showError } = useDialogs();
  const [regenerate] = useMutation<{ regenerateVaultKey: VaultItem }>(REGENERATE_VAULT_KEY, { refetchQueries: REFETCH, onError: (e) => void showError(e) });
  const [forget] = useMutation<{ forgetVaultHostKey: VaultItem }>(FORGET_VAULT_HOST_KEY, { refetchQueries: REFETCH, onError: (e) => void showError(e) });
  const [unshare] = useMutation(UNSHARE_VAULT_ITEM, { refetchQueries: REFETCH, onError: (e) => void showError(e) });
  const manage = item.myPermission === 'MANAGE';
  const days = daysToExpiry(item);
  const secretNote = item.kind === 'ssh' ? 'La clé privée ne quitte jamais le serveur.' : item.kind === 'google' ? 'Le jeton Google ne quitte jamais le serveur.' : isOauthToken(item) ? 'Obtenu par une connexion depuis Skipper : renouvelé automatiquement, jamais révélable.' : null;
  return (
    <div className="vault-details small">
      {item.description && <p className="mb-2">{item.description}</p>}
      <div className="mb-1">
        <span className="text-secondary">Propriétaire : </span>
        {item.ownerProject || item.ownerProjectName ? (
          item.ownerProject ? (
            <Link to={`/projects/${item.ownerProject.id}/vault`}>projet {item.ownerProject.name}</Link>
          ) : (
            `projet ${item.ownerProjectName}`
          )
        ) : (
          `${item.ownerUser?.id === user?.id ? 'vous' : item.ownerUser?.name} (personnel)`
        )}
        {' · votre permission : '}
        <Badge bg="secondary">{PERMISSION_LABELS[item.myPermission]}</Badge>
        {item.myShare && item.ownerUser && item.ownerUser.id !== user?.id && (
          <>
            {' · partagé avec vous · '}
            <Button
              variant="link"
              size="sm"
              className="p-0 align-baseline"
              onClick={async () => {
                if (await confirm({ title: 'Quitter le partage', message: `Ne plus avoir accès à « ${item.name} » ? Vos sessions ne pourront plus l'utiliser.`, confirmLabel: 'Quitter', danger: true })) unshare({ variables: { id: item.id, userId: user?.id } });
              }}
            >
              quitter le partage
            </Button>
          </>
        )}
      </div>
      {item.kind === 'ssh' && item.commandAllowlist.length > 0 && (
        <div className="mb-1">
          <span className="text-secondary">Commandes autorisées : </span>
          {item.commandAllowlist.map((c) => (
            <code key={c} className="me-2">
              {c}
            </code>
          ))}
        </div>
      )}
      {item.kind === 'api' && (
        <div className="mb-1">
          <span className="text-secondary">Authentification : </span>
          {item.authScheme === 'bearer' ? 'en-tête Authorization: Bearer' : item.authScheme === 'header' ? `en-tête ${item.authName}` : item.authScheme === 'basic' ? `Basic, utilisateur ${item.username}` : `paramètre ${item.authName}`}
          {' · '}
          {item.readOnly ? 'lecture seule' : 'écriture autorisée'}
        </div>
      )}
      {item.kind === 'token' && item.token && (
        <div className="mb-1">
          <span className="text-secondary">Service : </span>
          {item.token.serviceLabel}
          {item.token.account && <> · compte <strong>{item.token.account}</strong></>}
          {' · '}
          {item.token.obtained === 'oauth' ? 'obtenu par une connexion depuis Skipper' : 'saisi à la main'}
          {item.token.tokenExpiresAt && <> · expire le {fmtDate(item.token.tokenExpiresAt)}</>}
        </div>
      )}
      {item.kind === 'langfuse' && (
        <div className="mb-1">
          <span className="text-secondary">Clé publique : </span>
          <code>{item.langfusePublicKey}</code>
        </div>
      )}
      {isSkipperKind(item.kind) && (
        <div className="mb-1">
          <span className="text-secondary">Utilisé dans : </span>
          {skipperUsageOf(item)}
          {item.myPermission === 'MANAGE' && <span className="text-secondary"> · le supprimer retire aussi le réglage qui s'y réfère</span>}
        </div>
      )}
      {(item.kind === 'website' || item.kind === 'secret') && item.fields.length > 0 && (
        <div className="mb-1">
          <span className="text-secondary">Champs : </span>
          <ul className="mb-0 ps-3">
            {item.fields.map((f) => (
              <li key={f.key}>
                {f.label} <code className="text-secondary">{f.variable}</code> {f.secret ? <span className="text-secondary">secret, chiffré</span> : <>= {f.value}</>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mb-1">
        <span className="text-secondary">Secret : </span>
        {item.hasSecret ? (
          <>
            enregistré, chiffré{item.secretUpdatedAt && ` · modifié le ${fmtDate(item.secretUpdatedAt)}`}
            {item.expiresAt && (
              <>
                {' · rotation prévue le '}
                {fmtDay(item.expiresAt)}{' '}
                {days !== null && days < 0 ? <Badge bg="danger">expiré</Badge> : days !== null && days < 30 ? <Badge bg="warning" text="dark">dans {days} j</Badge> : null}
              </>
            )}
            {secretNote && ` · ${secretNote}`}
          </>
        ) : (
          'aucun'
        )}
      </div>
      {item.revealableFields.length > 0 && item.myPermission !== 'USE' && (
        <div className="mb-1 d-flex flex-column gap-1">
          {item.revealableFields.map((f) => (
            <RevealRow key={f} item={item} field={f} />
          ))}
        </div>
      )}
      {item.kind === 'ssh' && (
        <div className="mb-1">
          <span className="text-secondary">Clé de l'hôte : </span>
          {item.hostFingerprint ? (
            <>
              <code>{item.hostFingerprint}</code> · mémorisée le {fmtDate(item.hostKeySeenAt)}
              {manage && (
                <>
                  {' · '}
                  <Button
                    variant="link"
                    size="sm"
                    className="p-0 align-baseline"
                    onClick={async () => {
                      if (await confirm({ title: "Oublier la clé de l'hôte", message: 'La prochaine connexion mémorisera la clé que présentera le serveur. À ne faire que si le serveur a vraiment été réinstallé.', confirmLabel: 'Oublier', danger: true })) forget({ variables: { id: item.id } });
                    }}
                  >
                    oublier
                  </Button>
                </>
              )}
            </>
          ) : (
            "pas encore mémorisée : elle le sera à la première connexion réussie (testez l'élément)."
          )}
        </div>
      )}
      {item.lastTestOk === false && item.lastTestError && (
        <div className="mb-1 text-danger">
          <span className="text-secondary">Dernière erreur : </span>
          {item.lastTestError}
        </div>
      )}
      <div className="mb-1">
        <span className="text-secondary">Pour les agents : </span>
        {agentToolsOf(item)}
        {projectPage && browserDisabled && (item.kind === 'website' || item.kind === 'secret') && <span className="text-warning"> · navigateur headless désactivé sur ce projet</span>}
      </div>
      {item.kind === 'ssh' && item.publicKey && (
        <div className="mt-2">
          <div className="text-secondary">
            Clé publique à ajouter dans <code>~/.ssh/authorized_keys</code> de {item.username} sur {item.host} :
          </div>
          <InputGroup size="sm" className="mt-1" style={{ maxWidth: 720 }}>
            <Form.Control readOnly value={item.publicKey} className="font-monospace" onFocus={(e) => e.currentTarget.select()} />
            <Button variant="outline-secondary" onClick={() => void navigator.clipboard?.writeText(item.publicKey ?? '')}>
              Copier
            </Button>
          </InputGroup>
          <div className="text-secondary mt-1">
            Pour restreindre côté serveur : préfixez la ligne par <code>restrict,command="…"</code>.
            {manage && (
              <>
                {' · '}
                <Button
                  variant="link"
                  size="sm"
                  className="p-0 align-baseline"
                  onClick={async () => {
                    if (await confirm({ title: 'Régénérer la clé', message: "Une nouvelle paire de clés sera générée : l'ancienne clé publique cessera de fonctionner sur les serveurs où elle est installée.", confirmLabel: 'Régénérer', danger: true })) {
                      const res = await regenerate({ variables: { id: item.id } });
                      if (res.data) onEdited(res.data.regenerateVaultKey);
                    }
                  }}
                >
                  Régénérer la clé
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SharesTab({ item, shares }: { item: VaultItem; shares: VaultShare[] }) {
  const { confirm, showError } = useDialogs();
  const { data } = useQuery<{ vaultShareCandidates: { id: string; name: string; email: string }[] }>(VAULT_SHARE_CANDIDATES);
  const [email, setEmail] = useState('');
  const [permission, setPermission] = useState<VaultPermission>('USE');
  const [error, setError] = useState<string | null>(null);
  const [share, { loading }] = useMutation(SHARE_VAULT_ITEM, { refetchQueries: REFETCH });
  const [unshare] = useMutation(UNSHARE_VAULT_ITEM, { refetchQueries: REFETCH, onError: (e) => void showError(e) });
  const candidates = (data?.vaultShareCandidates ?? []).filter((c) => !shares.some((s) => s.user.id === c.id));
  return (
    <div className="small">
      <p className="text-secondary mb-2">
        <strong>utiliser</strong> : les sessions de la personne peuvent s'en servir ; <strong>lire</strong> : elle peut aussi révéler les secrets ; <strong>gérer</strong> : elle peut le modifier, le partager et l'ouvrir à des projets.
        {(item.ownerProject || item.ownerProjectName) && " Les administrateurs du projet propriétaire le gèrent ; ses autres membres l'utilisent."}
      </p>
      {shares.length > 0 && (
        <Table size="sm" className="mb-2">
          <tbody>
            {shares.map((s) => (
              <tr key={s.user.id}>
                <td>
                  {s.user.name} <span className="text-secondary">{s.user.email}</span>
                </td>
                <td style={{ width: 140 }}>
                  <Form.Select
                    size="sm"
                    value={s.permission}
                    onChange={(e) =>
                      share({ variables: { id: item.id, email: s.user.email, permission: e.target.value } }).catch((err: Error) => setError(err.message))
                    }
                  >
                    {(['USE', 'READ', 'MANAGE'] as VaultPermission[]).map((p) => (
                      <option key={p} value={p}>
                        {PERMISSION_LABELS[p]}
                      </option>
                    ))}
                  </Form.Select>
                </td>
                <td className="text-secondary">
                  {s.grantedBy && `par ${s.grantedBy.name}, `}
                  {fmtDay(s.createdAt)}
                </td>
                <td className="text-end">
                  <Button
                    variant="link"
                    size="sm"
                    className="p-0 text-danger"
                    onClick={async () => {
                      if (await confirm({ title: 'Retirer le partage', message: `Retirer l'accès de ${s.user.name} à « ${item.name} » ? Ses sessions ne pourront plus l'utiliser.`, confirmLabel: 'Retirer', danger: true })) unshare({ variables: { id: item.id, userId: s.user.id } });
                    }}
                  >
                    Retirer
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Form
        className="d-flex gap-2 align-items-center flex-wrap"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await share({ variables: { id: item.id, email: email.trim(), permission } });
            setEmail('');
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <Form.Control size="sm" type="email" list={`vault-candidates-${item.id}`} placeholder="adresse@exemple.fr" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ width: 260 }} />
        <datalist id={`vault-candidates-${item.id}`}>
          {candidates.map((c) => (
            <option key={c.id} value={c.email}>
              {c.name}
            </option>
          ))}
        </datalist>
        <Form.Select size="sm" value={permission} onChange={(e) => setPermission(e.target.value as VaultPermission)} style={{ width: 'auto' }}>
          {(['USE', 'READ', 'MANAGE'] as VaultPermission[]).map((p) => (
            <option key={p} value={p}>
              {PERMISSION_LABELS[p]}
            </option>
          ))}
        </Form.Select>
        <Button size="sm" type="submit" disabled={loading || !email.trim()}>
          Partager
        </Button>
        {error && <span className="text-danger">{error}</span>}
      </Form>
    </div>
  );
}

function LinksTab({ item, links, projects }: { item: VaultItem; links: VaultLink[]; projects: Project[] }) {
  if (isSkipperKind(item.kind)) return <SkipperLinksNote item={item} />;
  return <AgentLinksTab item={item} links={links} projects={projects} />;
}

/** Un élément réservé à Skipper ne s'ouvre pas aux agents d'un projet : il n'a ni lien ni copie. */
function SkipperLinksNote({ item }: { item: VaultItem }) {
  return (
    <div className="small text-secondary">
      <i className="bi bi-info-circle me-1" />
      Un {item.kind === 'token' ? 'jeton applicatif' : item.kind === 'litellm' ? 'proxy LiteLLM' : 'projet Langfuse'} est réservé à Skipper : il ne s'ouvre pas aux agents d'un projet{item.kind === 'token' && isOauthToken(item) ? ' et ne se copie pas' : ''}. Il se choisit dans {skipperUsageOf(item)} ; partagez-le (onglet Partage) pour qu'une autre personne puisse le choisir dans ses propres réglages.
    </div>
  );
}

function AgentLinksTab({ item, links, projects }: { item: VaultItem; links: VaultLink[]; projects: Project[] }) {
  const { confirm, showError } = useDialogs();
  const [projectId, setProjectId] = useState('');
  const [scope, setScope] = useState<VaultLinkScope>('PERSONAL');
  const [copyProject, setCopyProject] = useState('');
  const [copyName, setCopyName] = useState(item.name);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, { loading }] = useMutation(LINK_VAULT_ITEM, { refetchQueries: REFETCH });
  const [unlink] = useMutation(UNLINK_VAULT_ITEM, { refetchQueries: REFETCH, onError: (e) => void showError(e) });
  const [copy, { loading: copying }] = useMutation<{ copyVaultItem: VaultItem }>(COPY_VAULT_ITEM, { refetchQueries: REFETCH });
  const ownerProjectId = item.ownerProject?.id ?? null;
  const candidates = projects.filter((p) => p.id !== ownerProjectId && p.myRole !== 'VIEWER');
  const chosen = candidates.find((p) => p.id === projectId);
  const canProjectScope = item.myPermission === 'MANAGE' && chosen?.myRole === 'ADMIN';
  const copyTargets = projects.filter((p) => p.id !== ownerProjectId && p.myRole === 'ADMIN');
  useEffect(() => {
    if (!canProjectScope) setScope('PERSONAL');
  }, [canProjectScope]);
  return (
    <div className="small">
      <p className="text-secondary mb-2">Ouvrir un élément à un projet permet à ses agents de l'utiliser : soit pour toutes les sessions du projet, soit seulement pour celles que vous lancez. L'élément reste dans son coffre d'origine.</p>
      {links.length > 0 && (
        <Table size="sm" className="mb-2">
          <tbody>
            {links.map((l) => (
              <tr key={l.id}>
                <td>{l.project ? <Link to={`/projects/${l.project.id}/vault`}>{l.project.name}</Link> : l.projectName}</td>
                <td>{l.scope === 'PROJECT' ? <Badge bg="warning" text="dark">tous les agents</Badge> : <Badge bg="info" text="dark">sessions de {l.user?.name ?? '?'}</Badge>}</td>
                <td className="text-secondary">
                  {l.linkedBy && `par ${l.linkedBy.name}, `}
                  {fmtDay(l.createdAt)}
                </td>
                <td className="text-end">
                  <Button
                    variant="link"
                    size="sm"
                    className="p-0 text-danger"
                    onClick={async () => {
                      if (await confirm({ title: 'Retirer du projet', message: `Les agents de « ${l.project?.name ?? l.projectName} » ne pourront plus utiliser « ${item.name} ». L'élément reste dans le coffre.`, confirmLabel: 'Retirer', danger: true })) unlink({ variables: { linkId: l.id } });
                    }}
                  >
                    Retirer
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Form
        className="d-flex gap-2 align-items-center flex-wrap"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await link({ variables: { id: item.id, projectId, scope } });
            setProjectId('');
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <Form.Select size="sm" value={projectId} onChange={(e) => setProjectId(e.target.value)} required style={{ width: 'auto' }}>
          <option value="">Projet…</option>
          {candidates.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Form.Select>
        <Form.Select size="sm" value={scope} onChange={(e) => setScope(e.target.value as VaultLinkScope)} style={{ width: 'auto' }}>
          <option value="PERSONAL">pour mes sessions seulement</option>
          <option value="PROJECT" disabled={!canProjectScope}>
            pour tous les agents du projet
          </option>
        </Form.Select>
        <Button size="sm" type="submit" disabled={loading || !projectId}>
          Ouvrir
        </Button>
        {error && <span className="text-danger">{error}</span>}
      </Form>
      {item.myPermission === 'MANAGE' && item.kind !== 'google' && copyTargets.length > 0 && (
        <div className="mt-3 pt-2 border-top">
          <div className="mb-1">Copier dans un projet</div>
          <Form
            className="d-flex gap-2 align-items-center flex-wrap"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              const target = copyTargets.find((p) => p.id === copyProject);
              if (!target) return;
              const ok = await confirm({
                title: 'Copier dans un projet',
                message: `Une copie de « ${item.name} », secrets compris, sera créée dans le coffre de « ${target.name} » sous le nom « ${copyName} » : ses administrateurs la gèrent. Les ouvertures de cet élément vers ce projet seront remplacées par la copie. Cet élément reste tel quel : supprimez-le ensuite pour achever une migration.`,
                confirmLabel: 'Copier',
              });
              if (!ok) return;
              try {
                const res = await copy({ variables: { id: item.id, projectId: copyProject, name: copyName.trim() || null } });
                setCopied(`Copié dans ${target.name} sous le nom « ${res.data?.copyVaultItem.name} ».`);
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            <Form.Select size="sm" value={copyProject} onChange={(e) => setCopyProject(e.target.value)} required style={{ width: 'auto' }}>
              <option value="">Projet…</option>
              {copyTargets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Form.Select>
            <Form.Control size="sm" value={copyName} onChange={(e) => setCopyName(e.target.value)} style={{ width: 180 }} placeholder="nom" />
            <Button size="sm" variant="outline-secondary" type="submit" disabled={copying || !copyProject}>
              Copier
            </Button>
          </Form>
          {copied && (
            <Alert variant="success" className="py-1 mt-2 mb-0" dismissible onClose={() => setCopied(null)}>
              {copied}
            </Alert>
          )}
        </div>
      )}
    </div>
  );
}

function AuditTab({ events, onMore, canMore }: { events: VaultAuditEvent[]; onMore: () => void; canMore: boolean }) {
  return (
    <div className="small">
      {events.length === 0 && <div className="text-secondary">Aucun événement.</div>}
      {events.length > 0 && (
        <Table size="sm" className="mb-1">
          <tbody>
            {events.map((e) => (
              <tr key={e.id} className={e.ok ? '' : 'text-danger'}>
                <td className="text-nowrap text-secondary">{fmtDate(e.createdAt)}</td>
                <td className="text-nowrap">{ACTION_LABELS[e.action] ?? e.action}</td>
                <td className="text-nowrap">{e.actor?.name ?? (e.sessionId ? 'agent' : '—')}</td>
                <td className="text-nowrap">{e.sessionId ? <Link to={`/sessions/${e.sessionId}`}>session</Link> : e.project ? e.project.name : e.projectName}</td>
                <td className="text-break">{e.detail}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {canMore && (
        <Button variant="link" size="sm" className="p-0" onClick={onMore}>
          Afficher plus
        </Button>
      )}
    </div>
  );
}

/** Ligne de détails d'un élément : onglets Détails, Partage, Projets, Journal (selon la permission). */
export default function VaultItemDetails({ item, projects, projectPage = false, browserDisabled = false, onEdited }: { item: VaultItem; projects: Project[]; projectPage?: boolean; browserDisabled?: boolean; onEdited: (item: VaultItem) => void }) {
  const [tab, setTab] = useState<Tab>('details');
  const [before, setBefore] = useState<string | null>(null);
  // Journal accumulé page après page : la première page (sans `before`) est rafraîchie par le polling, les suivantes ajoutées à la fin.
  const [events, setEvents] = useState<VaultAuditEvent[]>([]);
  const manage = item.myPermission === 'MANAGE';
  const { data } = useQuery<{ vaultItem: { shares: VaultShare[]; links: VaultLink[]; audit: VaultAuditEvent[] } | null }>(VAULT_ITEM_DETAILS, { variables: { id: item.id, before }, skip: !manage, fetchPolicy: 'cache-and-network' });
  const page = data?.vaultItem?.audit;
  useEffect(() => {
    if (!page) return;
    setEvents((prev) => {
      if (!before) {
        const known = new Set(page.map((e) => e.id));
        return [...page, ...prev.filter((e) => !known.has(e.id))];
      }
      const known = new Set(prev.map((e) => e.id));
      return [...prev, ...page.filter((e) => !known.has(e.id))];
    });
  }, [page, before]);
  return (
    <div className="vault-item-details">
      {manage && (
        <Nav variant="underline" className="small mb-2" activeKey={tab} onSelect={(k) => setTab((k as Tab) ?? 'details')}>
          <Nav.Item>
            <Nav.Link eventKey="details">Détails</Nav.Link>
          </Nav.Item>
          <Nav.Item>
            <Nav.Link eventKey="shares">Partage{data?.vaultItem?.shares.length ? ` (${data.vaultItem.shares.length})` : ''}</Nav.Link>
          </Nav.Item>
          <Nav.Item>
            <Nav.Link eventKey="links">Projets{data?.vaultItem?.links.length ? ` (${data.vaultItem.links.length})` : ''}</Nav.Link>
          </Nav.Item>
          <Nav.Item>
            <Nav.Link eventKey="audit">Journal</Nav.Link>
          </Nav.Item>
        </Nav>
      )}
      {tab === 'details' && <DetailsTab item={item} projectPage={projectPage} browserDisabled={browserDisabled} onEdited={onEdited} />}
      {tab === 'shares' && <SharesTab item={item} shares={data?.vaultItem?.shares ?? []} />}
      {tab === 'links' && <LinksTab item={item} links={data?.vaultItem?.links ?? []} projects={projects} />}
      {tab === 'audit' && (
        <AuditTab
          events={events}
          canMore={(page?.length ?? 0) >= 30}
          onMore={() => {
            const last = events.at(-1);
            if (last) setBefore(last.id);
          }}
        />
      )}
    </div>
  );
}
