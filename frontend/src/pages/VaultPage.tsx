import { useQuery } from '@apollo/client';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, ButtonGroup, Form } from 'react-bootstrap';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import PageLoading from '../components/PageLoading';
import VaultItemEditor, { type TunnelCandidate, type VaultOwnerChoice } from '../components/vault/VaultItemEditor';
import VaultTable from '../components/vault/VaultTable';
import { KIND_ORDER, KINDS } from '../components/vault/kinds';
import { PROJECTS, type Project } from '../graphql/operations';
import { VAULT_ITEMS, type VaultItem, type VaultItemKind } from '../graphql/vault';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';

type Scope = 'all' | 'mine' | 'shared' | 'projects';

/** Lit une fois les paramètres de retour de Google et le lien profond `?item=`. */
function useReturnParams() {
  const [params, setParams] = useSearchParams();
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const [deepItem, setDeepItem] = useState<string | null>(null);
  useEffect(() => {
    const google = params.get('google');
    const googleError = params.get('googleError');
    const item = params.get('item');
    if (!google && !googleError && !item) return;
    if (google === 'connected') setFlash({ ok: true, text: `Compte Google ${params.get('email') ?? ''} enregistré dans le coffre.` });
    if (googleError) setFlash({ ok: false, text: `Connexion Google refusée : ${googleError}` });
    if (item) setDeepItem(item);
    const next = new URLSearchParams(params);
    for (const k of ['google', 'googleError', 'email', 'item']) next.delete(k);
    setParams(next, { replace: true });
  }, [params, setParams]);
  return { flash, setFlash, deepItem, setDeepItem };
}

export function tunnelsOf(items: VaultItem[]): TunnelCandidate[] {
  return items.filter((i) => i.kind === 'ssh').map((i) => ({ id: i.id, name: i.name, host: i.host, username: i.username, ownerProjectId: i.ownerProject?.id ?? null, ownerUserId: i.ownerUser?.id ?? null }));
}

/** Coffre : tout ce que l'utilisateur peut voir (éléments personnels, partagés, de ses projets). */
export default function VaultPage() {
  const { user } = useAuth();
  useTabTitle('Coffre');
  const { flash, setFlash, deepItem, setDeepItem } = useReturnParams();
  const { data, loading, error } = usePollingQuery<{ vaultItems: VaultItem[]; vaultGoogleAvailable: boolean }>(VAULT_ITEMS, { pollInterval: 15_000 });
  const { data: projectsData } = useQuery<{ projects: Project[] }>(PROJECTS);
  const [scope, setScope] = useState<Scope>('all');
  const [kind, setKind] = useState<VaultItemKind | ''>('');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<VaultItem | null | 'new'>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    if (deepItem) {
      setOpenId(deepItem);
      setDeepItem(null);
    }
  }, [deepItem, setDeepItem]);

  const items = data?.vaultItems ?? [];
  const projects = projectsData?.projects ?? [];
  const owners: VaultOwnerChoice[] = [{ projectId: null, label: 'Mon coffre personnel' }, ...projects.filter((p) => p.myRole === 'ADMIN').map((p) => ({ projectId: p.id, label: `Projet ${p.name}` }))];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      if (scope === 'mine' && i.ownerUser?.id !== user?.id) return false;
      if (scope === 'shared' && (!i.ownerUser || i.ownerUser.id === user?.id)) return false;
      if (scope === 'projects' && !(i.ownerProject || i.ownerProjectName)) return false;
      if (kind && i.kind !== kind) return false;
      if (!q) return true;
      return [i.name, i.description, i.host, i.url, i.database, i.username, i.google?.email, i.token?.serviceLabel, i.token?.account, i.langfusePublicKey, i.aws?.accountId, i.aws?.accountName, i.aws?.roleName, i.aws?.accessKeyId, i.scaleway?.accessKey, i.scaleway?.identity, i.scaleway?.projectId].some((v) => v?.toLowerCase().includes(q));
    });
  }, [items, scope, kind, search, user?.id]);

  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  return (
    <>
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-2">
        <h1 className="h3 mb-0">Coffre</h1>
        <Button size="sm" onClick={() => setEditing('new')}>
          <i className="bi bi-plus-lg me-1" /> Ajouter un élément
        </Button>
      </div>
      <p className="text-secondary small">
        Serveurs SSH, bases de données, API, comptes AWS, sites web, secrets et comptes Google utilisables par les agents. Chaque élément est chiffré avec sa propre clé ; les agents n'en voient jamais les valeurs, le serveur agit pour eux. Un élément personnel vous appartient : partagez-le avec des collègues ou ouvrez-le à des projets. Un élément de projet est géré par ses administrateurs. Les jetons applicatifs, proxys LiteLLM et projets Langfuse sont réservés à Skipper (vos réglages Claude, OpenCode et GitHub, les agents à appel direct) et ne sont jamais offerts aux agents.
      </p>
      {flash && (
        <Alert variant={flash.ok ? 'success' : 'danger'} dismissible onClose={() => setFlash(null)} className="py-2">
          {flash.text}
        </Alert>
      )}
      <div className="d-flex align-items-center gap-2 flex-wrap mb-3">
        <ButtonGroup size="sm">
          {(
            [
              ['all', 'Tous'],
              ['mine', 'Personnels'],
              ['shared', 'Partagés avec moi'],
              ['projects', 'Projets'],
            ] as [Scope, string][]
          ).map(([s, label]) => (
            <Button key={s} variant={scope === s ? 'primary' : 'outline-secondary'} onClick={() => setScope(s)}>
              {label}
            </Button>
          ))}
        </ButtonGroup>
        <Form.Select size="sm" value={kind} onChange={(e) => setKind(e.target.value as VaultItemKind | '')} style={{ width: 'auto' }}>
          <option value="">Tous les types</option>
          {KIND_ORDER.map((k) => (
            <option key={k} value={k}>
              {KINDS[k].label}
            </option>
          ))}
        </Form.Select>
        <Form.Control size="sm" type="search" placeholder="Chercher…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 220 }} />
      </div>
      <VaultTable rows={filtered.map((item) => ({ item }))} projects={projects} openId={openId} onOpenChange={setOpenId} onEdit={(item) => setEditing(item)} empty={items.length === 0 ? 'Votre coffre est vide.' : 'Aucun élément ne correspond.'} />
      {editing && (
        <VaultItemEditor
          item={editing === 'new' ? null : editing}
          owners={owners}
          tunnels={tunnelsOf(items)}
          googleAvailable={data?.vaultGoogleAvailable ?? false}
          onClose={() => setEditing(null)}
          onSaved={(item) => {
            setEditing(null);
            setOpenId(item.id);
          }}
        />
      )}
    </>
  );
}
