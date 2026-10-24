import { useMutation, useQuery } from '@apollo/client';
import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Form, Modal } from 'react-bootstrap';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useDialogs } from '../components/Dialogs';
import PageLoading from '../components/PageLoading';
import VaultItemEditor from '../components/vault/VaultItemEditor';
import VaultTable, { type VaultRow } from '../components/vault/VaultTable';
import { isSkipperKind, KINDS } from '../components/vault/kinds';
import { PROJECTS, type Project } from '../graphql/operations';
import { LINK_VAULT_ITEM, UNLINK_VAULT_ITEM, VAULT_ITEMS, VAULT_PROJECT, type ProjectVaultItem, type VaultItem, type VaultLinkScope } from '../graphql/vault';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';
import ProjectHeader from '../components/ProjectHeader';
import { tunnelsOf } from './VaultPage';

interface VaultProject {
  id: string;
  name: string;
  description: string | null;
  myRole: 'ADMIN' | 'MEMBER' | 'VIEWER';
  runnerConfig: { browser?: boolean };
  vaultItems: ProjectVaultItem[];
}

function LinkModal({ project, mine, inScope, onClose }: { project: VaultProject; mine: VaultItem[]; inScope: Set<string>; onClose: () => void }) {
  const { user } = useAuth();
  const [itemId, setItemId] = useState('');
  const [scope, setScope] = useState<VaultLinkScope>('PERSONAL');
  const [error, setError] = useState<string | null>(null);
  const [link, { loading }] = useMutation(LINK_VAULT_ITEM, { refetchQueries: ['VaultProject', 'VaultItems'] });
  // Les éléments réservés à Skipper (jetons, LiteLLM, Langfuse) ne se relient pas à un projet.
  const candidates = mine.filter((i) => i.ownerProject?.id !== project.id && !inScope.has(i.id) && !isSkipperKind(i.kind));
  const chosen = candidates.find((i) => i.id === itemId);
  const canProject = project.myRole === 'ADMIN' && chosen?.myPermission === 'MANAGE';
  return (
    <Modal show onHide={onClose} centered>
      <Form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await link({ variables: { id: itemId, projectId: project.id, scope: canProject ? scope : 'PERSONAL' } });
            onClose();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <Modal.Header closeButton>
          <Modal.Title className="h5">Utiliser un de mes éléments</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {candidates.length === 0 ? (
            <p className="mb-0">
              Aucun élément disponible. Ajoutez-en dans <Link to="/vault">votre coffre</Link>.
            </p>
          ) : (
            <>
              <Form.Group className="mb-3">
                <Form.Label>Élément</Form.Label>
                <Form.Select value={itemId} onChange={(e) => setItemId(e.target.value)} required>
                  <option value="">Choisir…</option>
                  {candidates.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} — {KINDS[i.kind].label} ({i.ownerProject ? `projet ${i.ownerProject.name}` : i.ownerUser?.id === user?.id ? 'personnel' : i.ownerUser?.name})
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
              <Form.Label>Pour</Form.Label>
              <Form.Check type="radio" id="link-personal" name="scope" checked={scope === 'PERSONAL' || !canProject} onChange={() => setScope('PERSONAL')} label="Mes sessions seulement : seules les sessions que je lance dans ce projet le voient." />
              <Form.Check type="radio" id="link-project" name="scope" disabled={!canProject} checked={scope === 'PROJECT' && canProject} onChange={() => setScope('PROJECT')} label="Toutes les sessions du projet, quel qu'en soit l'auteur (il faut gérer l'élément et administrer le projet)." />
            </>
          )}
          {error && (
            <Alert variant="danger" className="mt-3 mb-0 py-2">
              {error}
            </Alert>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" disabled={loading || !itemId}>
            Ouvrir au projet
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}

/** Coffre d'un projet : ce que ses agents peuvent utiliser (éléments du projet, éléments ouverts, mes éléments pour mes sessions). */
export default function ProjectVaultPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const { confirm, showError } = useDialogs();
  const { data, loading, error } = usePollingQuery<{ project: VaultProject | null; vaultGoogleAvailable: boolean }>(VAULT_PROJECT, { variables: { id }, pollInterval: 15_000 });
  const { data: mineData } = useQuery<{ vaultItems: VaultItem[] }>(VAULT_ITEMS);
  const { data: projectsData } = useQuery<{ projects: Project[] }>(PROJECTS);
  const project = data?.project;
  useTabTitle(project ? `Coffre · ${project.name}` : null);
  const [editing, setEditing] = useState<VaultItem | null | 'new'>(null);
  const [linking, setLinking] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [unlink] = useMutation(UNLINK_VAULT_ITEM, { refetchQueries: ['VaultProject', 'VaultItems'], onError: (e) => void showError(e) });

  const rows = useMemo<VaultRow[]>(() => {
    if (!project) return [];
    return project.vaultItems.map(({ item, via, link, forAgents }) => {
      const canUnlink = link && (project.myRole === 'ADMIN' || item.myPermission === 'MANAGE' || link.user?.id === user?.id);
      return {
        item,
        access: (
          <span className="d-inline-flex gap-1 align-items-center flex-wrap">
            {via === 'OWN' ? <Badge bg="secondary">élément du projet</Badge> : link?.scope === 'PROJECT' ? <Badge bg="warning" text="dark">tous les agents</Badge> : <Badge bg="info" text="dark">sessions de {link?.user?.id === user?.id ? 'moi' : (link?.user?.name ?? '?')}</Badge>}
            {!forAgents && <Badge bg="dark" title="Jamais offert aux agents du projet : géré ici, utilisé par les réglages et les agents à appel direct">réservé à Skipper</Badge>}
            {via !== 'OWN' && <span className="text-secondary">{item.ownerProject ? `projet ${item.ownerProject.name}` : item.ownerUser?.id === user?.id ? 'personnel' : item.ownerUser?.name}</span>}
          </span>
        ),
        extraAction: canUnlink ? (
          <Button
            size="sm"
            variant="link"
            className="p-0 px-1"
            title="Retirer du projet"
            onClick={async () => {
              if (await confirm({ title: 'Retirer du projet', message: `Les agents de ce projet ne pourront plus utiliser « ${item.name} ». L'élément reste dans le coffre.`, confirmLabel: 'Retirer', danger: true })) unlink({ variables: { linkId: link.id } });
            }}
          >
            <i className="bi bi-x-lg" />
          </Button>
        ) : null,
      };
    });
  }, [project, user?.id, confirm, unlink]);

  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (!project) return <Alert variant="warning">Projet introuvable.</Alert>;
  const browserDisabled = !project.runnerConfig.browser;
  const needsBrowser = project.vaultItems.some(({ item, forAgents }) => forAgents && (item.kind === 'website' || item.kind === 'secret'));
  const mine = mineData?.vaultItems ?? [];
  const inScope = new Set(project.vaultItems.map((r) => r.item.id));
  const tunnels = tunnelsOf([...project.vaultItems.map((r) => r.item), ...mine.filter((i) => !inScope.has(i.id))]);
  return (
    <>
      <ProjectHeader project={project} active="vault" />
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-2">
        <div className="d-flex gap-2 flex-wrap ms-auto">
          {project.myRole !== 'VIEWER' && (
            <Button size="sm" variant="outline-primary" onClick={() => setLinking(true)}>
              Utiliser un de mes éléments
            </Button>
          )}
          {project.myRole === 'ADMIN' && (
            <Button size="sm" onClick={() => setEditing('new')}>
              <i className="bi bi-plus-lg me-1" /> Nouvel élément du projet
            </Button>
          )}
        </div>
      </div>
      <p className="text-secondary small">Les agents de ce projet peuvent utiliser les éléments du projet, ceux que leurs gestionnaires lui ont ouverts, et ceux que vous avez ouverts pour vos propres sessions. Les identifiants restent sur le serveur. Les éléments « réservés à Skipper » (jetons, LiteLLM, Langfuse) du projet servent aux agents à appel direct, jamais aux sessions.</p>
      {browserDisabled && needsBrowser && <Alert variant="warning" className="py-2">Le navigateur headless n'est pas activé sur ce projet : les agents ne pourront pas utiliser les sites web et les secrets. Activez-le dans les réglages du projet.</Alert>}
      <VaultTable rows={rows} projects={projectsData?.projects ?? []} openId={openId} onOpenChange={setOpenId} onEdit={(item) => setEditing(item)} projectPage browserDisabled={browserDisabled} empty="Aucun élément pour ce projet." />
      {editing && (
        <VaultItemEditor
          item={editing === 'new' ? null : editing}
          owners={[{ projectId: project.id, label: `Projet ${project.name}` }]}
          initialOwner={project.id}
          tunnels={tunnels}
          googleAvailable={data?.vaultGoogleAvailable ?? false}
          onClose={() => setEditing(null)}
          onSaved={(item) => {
            setEditing(null);
            setOpenId(item.id);
          }}
        />
      )}
      {linking && <LinkModal project={project} mine={mine} inScope={inScope} onClose={() => setLinking(false)} />}
    </>
  );
}
