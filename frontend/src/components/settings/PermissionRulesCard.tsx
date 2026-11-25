import { useMemo, useState } from 'react';
import { useMutation } from '@apollo/client';
import { Alert, Badge, Button, Card, Form, Modal, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { usePollingQuery } from '../../lib/usePollingQuery';
import { timeAgo } from '../../lib/humanize';
import { useDialogs } from '../Dialogs';
import {
  ADD_PROJECT_PERMISSION_RULE,
  DELETE_PROJECT_PERMISSION_RULE,
  DELETE_PROJECT_PERMISSION_RULES,
  PROJECT_PERMISSION_RULES,
  UPDATE_PROJECT_PERMISSION_RULE,
  type PermissionRule,
} from '../../graphql/operations';

/** Utilisation d'une règle : nombre d'appels autorisés et dernière utilisation, ou absence d'utilisation depuis le début du suivi. */
function ruleUsage(r: PermissionRule): string {
  if (!r.useCount || !r.lastUsedAt) return `jamais utilisée depuis le ${new Date(r.usageTrackedSince).toLocaleDateString()}`;
  return `utilisée ${r.useCount} fois, dernière fois ${timeAgo(r.lastUsedAt)}`;
}

/** Nombre de règles par outil, du plus fréquent au moins fréquent. */
function countByTool(rules: PermissionRule[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const r of rules) counts.set(r.toolName, (counts.get(r.toolName) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

type UsageFilter = 'all' | 'used' | 'unused';
type SortKey = 'uses' | 'recent' | 'created' | 'alpha';

/**
 * Autorisations d'outils mémorisées pour le projet (réponse « ne plus demander dans ce projet ») :
 * un résumé sur la page, la liste détaillée (filtres, modification, retrait, ajout) dans une modale.
 */
export default function PermissionRulesCard({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const { data } = usePollingQuery<{ project: { permissionRules: PermissionRule[] } | null }>(PROJECT_PERMISSION_RULES, { variables: { id: projectId }, pollInterval: 10000 });
  const [open, setOpen] = useState(false);
  const rules = data?.project?.permissionRules ?? [];
  const unused = rules.filter((r) => !r.useCount).length;
  const byTool = countByTool(rules);
  const shownTools = byTool.slice(0, 6);
  const lastUsed = rules.reduce<string | null>((acc, r) => (r.lastUsedAt && (!acc || r.lastUsedAt > acc) ? r.lastUsedAt : acc), null);

  return (
    <Card className="mt-3">
      <Card.Header className="d-flex align-items-center justify-content-between gap-2">
        <span>Autorisations mémorisées</span>
        <Button size="sm" variant="outline-secondary" onClick={() => setOpen(true)}>
          {canManage ? 'Voir et gérer' : 'Voir'}
        </Button>
      </Card.Header>
      <Card.Body className="small" role="button" title="Voir la liste détaillée" onClick={() => setOpen(true)}>
        {rules.length === 0 ? (
          <span className="text-secondary">Aucune autorisation mémorisée : les agents demandent avant chaque outil sensible.</span>
        ) : (
          <>
            <div>
              <strong>
                {rules.length} règle{rules.length > 1 ? 's' : ''}
              </strong>{' '}
              appliquée{rules.length > 1 ? 's' : ''} sans redemander par toutes les sessions du projet
              {lastUsed && <span className="text-secondary"> · dernière utilisation {timeAgo(lastUsed)}</span>}
              {unused > 0 && (
                <span className="text-secondary">
                  {' '}
                  · {unused} jamais utilisée{unused > 1 ? 's' : ''}
                </span>
              )}
            </div>
            <div className="d-flex flex-wrap gap-1 mt-2">
              {shownTools.map(([tool, n]) => (
                <Badge key={tool} bg="light" text="dark" className="border font-monospace fw-normal">
                  {tool} {n}
                </Badge>
              ))}
              {byTool.length > shownTools.length && <span className="text-secondary">+ {byTool.length - shownTools.length} autres outils</span>}
            </div>
          </>
        )}
      </Card.Body>
      {open && <PermissionRulesModal projectId={projectId} canManage={canManage} rules={rules} byTool={byTool} onClose={() => setOpen(false)} />}
    </Card>
  );
}

function PermissionRulesModal({
  projectId,
  canManage,
  rules,
  byTool,
  onClose,
}: {
  projectId: string;
  canManage: boolean;
  rules: PermissionRule[];
  byTool: [string, number][];
  onClose: () => void;
}) {
  const refetch = { refetchQueries: ['ProjectPermissionRules'] };
  const [addRule, { loading: adding, error: addError }] = useMutation(ADD_PROJECT_PERMISSION_RULE, refetch);
  const [deleteRule, { error: deleteError }] = useMutation(DELETE_PROJECT_PERMISSION_RULE, refetch);
  const [deleteRules, { loading: deletingMany, error: deleteManyError }] = useMutation(DELETE_PROJECT_PERMISSION_RULES, refetch);
  const [updateRule, { loading: updating, error: updateError }] = useMutation(UPDATE_PROJECT_PERMISSION_RULE, refetch);
  const { confirm } = useDialogs();
  const [toolName, setToolName] = useState('');
  const [ruleContent, setRuleContent] = useState('');
  // Règle en cours de modification : identifiant et texte complet (Outil ou Outil(motif)).
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [search, setSearch] = useState('');
  const [tool, setTool] = useState('');
  const [usage, setUsage] = useState<UsageFilter>('all');
  const [sort, setSort] = useState<SortKey>('uses');
  const error = addError ?? deleteError ?? deleteManyError ?? updateError;

  const unused = rules.filter((r) => !r.useCount);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = rules.filter(
      (r) =>
        (!tool || r.toolName === tool) &&
        (usage === 'all' || (usage === 'used' ? r.useCount > 0 : !r.useCount)) &&
        (!q || r.rule.toLowerCase().includes(q) || (r.createdBySession?.name.toLowerCase().includes(q) ?? false)),
    );
    const cmp: Record<SortKey, (a: PermissionRule, b: PermissionRule) => number> = {
      uses: (a, b) => (b.useCount ?? 0) - (a.useCount ?? 0) || a.rule.localeCompare(b.rule),
      recent: (a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') || a.rule.localeCompare(b.rule),
      created: (a, b) => b.createdAt.localeCompare(a.createdAt),
      alpha: (a, b) => a.rule.localeCompare(b.rule),
    };
    return [...list].sort(cmp[sort]);
  }, [rules, search, tool, usage, sort]);
  const filtering = !!search.trim() || !!tool || usage !== 'all';

  const saveEdit = () => {
    if (!editing?.text.trim()) return;
    updateRule({ variables: { id: editing.id, rule: editing.text.trim() } })
      .then(() => setEditing(null))
      .catch(() => undefined);
  };
  const removeUnused = async () => {
    const ok = await confirm({
      title: 'Retirer les règles jamais utilisées',
      message: (
        <>
          <p>Ces règles n'ont autorisé aucun appel d'outil depuis le début du suivi : les prochaines sessions redemanderont.</p>
          <ul className="small mb-0">
            {unused.map((r) => (
              <li key={r.id}>
                <code>{r.rule}</code> <span className="text-secondary">— {ruleUsage(r)}</span>
              </li>
            ))}
          </ul>
        </>
      ),
      confirmLabel: `Retirer ${unused.length} règle${unused.length > 1 ? 's' : ''}`,
      danger: true,
    });
    if (ok) deleteRules({ variables: { projectId, ids: unused.map((r) => r.id) } }).catch(() => undefined);
  };

  return (
    <Modal show onHide={onClose} size="xl" scrollable>
      <Modal.Header closeButton>
        <Modal.Title>Autorisations mémorisées</Modal.Title>
      </Modal.Header>
      <Modal.Body className="small">
        <p className="text-secondary">
          Quand un agent demande une autorisation, « ne plus demander dans ce projet » enregistre la règle ici : toutes les sessions du projet l'appliquent sans redemander. Modifier ou retirer une
          règle ne concerne que les prochaines sessions. Une règle Bash en <code>préfixe *</code> (ex. <code>git checkout *</code>) couvre toutes les commandes qui commencent ainsi.
        </p>
        <div className="d-flex flex-wrap gap-2 align-items-center mb-2">
          <Form.Control size="sm" type="search" placeholder="Filtrer (règle, session)…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 280 }} autoFocus />
          <Form.Select size="sm" value={tool} onChange={(e) => setTool(e.target.value)} style={{ width: 'auto' }} aria-label="Outil">
            <option value="">Tous les outils</option>
            {byTool.map(([t, n]) => (
              <option key={t} value={t}>
                {t} ({n})
              </option>
            ))}
          </Form.Select>
          <Form.Select size="sm" value={usage} onChange={(e) => setUsage(e.target.value as UsageFilter)} style={{ width: 'auto' }} aria-label="Utilisation">
            <option value="all">Utilisées ou non</option>
            <option value="used">Utilisées</option>
            <option value="unused">Jamais utilisées</option>
          </Form.Select>
          <Form.Select size="sm" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} style={{ width: 'auto' }} aria-label="Tri">
            <option value="uses">Plus utilisées d'abord</option>
            <option value="recent">Utilisées récemment</option>
            <option value="created">Créées récemment</option>
            <option value="alpha">Ordre alphabétique</option>
          </Form.Select>
          <span className="text-secondary ms-auto">
            {filtering ? `${filtered.length} sur ${rules.length}` : `${rules.length} règle${rules.length > 1 ? 's' : ''}`}
          </span>
        </div>
        <Table size="sm" className="mb-3 align-middle table-stack">
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td className="text-secondary">{rules.length === 0 ? 'Aucune autorisation mémorisée.' : 'Aucune règle ne correspond au filtre.'}</td>
              </tr>
            )}
            {filtered.map((r) => (
              <tr key={r.id}>
                <td style={{ minWidth: 0 }}>
                  {editing?.id === r.id ? (
                    <Form
                      className="d-flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        saveEdit();
                      }}
                    >
                      <Form.Control
                        size="sm"
                        className="font-monospace"
                        autoFocus
                        value={editing.text}
                        onChange={(e) => setEditing({ id: r.id, text: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.stopPropagation();
                            setEditing(null);
                          }
                        }}
                      />
                      <Button type="submit" size="sm" variant="outline-primary" disabled={updating || !editing.text.trim()}>
                        Enregistrer
                      </Button>
                      <Button size="sm" variant="link" className="text-secondary" onClick={() => setEditing(null)}>
                        Annuler
                      </Button>
                    </Form>
                  ) : (
                    <code
                      className="text-break"
                      role={canManage ? 'button' : undefined}
                      title={canManage ? 'Cliquer pour modifier' : undefined}
                      onClick={() => canManage && setEditing({ id: r.id, text: r.rule })}
                    >
                      {r.rule}
                    </code>
                  )}
                  <div className="text-secondary text-truncate">
                    {ruleUsage(r)} · créée le {new Date(r.createdAt).toLocaleDateString()}
                    {r.createdBySession && (
                      <>
                        {' '}
                        · session{' '}
                        <Link to={`/sessions/${r.createdBySession.id}`} onClick={onClose}>
                          {r.createdBySession.name}
                        </Link>
                      </>
                    )}
                  </div>
                </td>
                {canManage && (
                  <td className="text-end text-nowrap" style={{ width: 170 }}>
                    {editing?.id !== r.id && (
                      <Button size="sm" variant="outline-secondary" className="me-2" onClick={() => setEditing({ id: r.id, text: r.rule })}>
                        Modifier
                      </Button>
                    )}
                    <Button size="sm" variant="outline-danger" onClick={() => deleteRule({ variables: { id: r.id } })}>
                      Retirer
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
        {error && (
          <Alert variant="danger" className="mt-2 mb-0">
            {error.message}
          </Alert>
        )}
      </Modal.Body>
      {canManage && (
        <Modal.Footer className="small justify-content-between align-items-end">
          <Form
            className="d-flex gap-2 align-items-end flex-wrap"
            onSubmit={(e) => {
              e.preventDefault();
              if (!toolName.trim()) return;
              addRule({ variables: { projectId, toolName: toolName.trim(), ruleContent: ruleContent.trim() || null } })
                .then(() => {
                  setToolName('');
                  setRuleContent('');
                })
                .catch(() => undefined);
            }}
          >
            <Form.Group>
              <Form.Label className="mb-1">Outil</Form.Label>
              <Form.Control size="sm" value={toolName} onChange={(e) => setToolName(e.target.value)} placeholder="ex. Bash, Read, WebFetch" style={{ width: 180 }} />
            </Form.Group>
            <Form.Group>
              <Form.Label className="mb-1">Motif (optionnel)</Form.Label>
              <Form.Control size="sm" value={ruleContent} onChange={(e) => setRuleContent(e.target.value)} placeholder="ex. git status * ou npm test *" style={{ width: 260 }} />
            </Form.Group>
            <Button type="submit" size="sm" variant="outline-primary" disabled={adding || !toolName.trim()}>
              {adding ? 'Ajout…' : 'Ajouter'}
            </Button>
          </Form>
          {unused.length > 0 && (
            <Button size="sm" variant="outline-danger" disabled={deletingMany} onClick={() => void removeUnused()}>
              Retirer les règles jamais utilisées ({unused.length})
            </Button>
          )}
        </Modal.Footer>
      )}
    </Modal>
  );
}
