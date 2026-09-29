import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Collapse, Form, Row, Spinner } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CREATE_PROJECT, GITHUB_REPOSITORIES, GITHUB_STATUS, PROJECT, PROJECTS, UPDATE_PROJECT, type GithubAuthStatus, type GithubRepository, type Project } from '../graphql/operations';

/** Liste des dépôts GitHub de l'utilisateur connecté, pour remplir l'URL et la branche. */
function GithubRepoPicker({ onPick }: { onPick: (repo: GithubRepository) => void }) {
  const { data: statusData } = useQuery<{ settings: { github: GithubAuthStatus } }>(GITHUB_STATUS);
  const connected = statusData?.settings.github.connected ?? false;
  const [query, setQuery] = useState('');
  const { data, loading } = useQuery<{ githubRepositories: GithubRepository[] }>(GITHUB_REPOSITORIES, { variables: { query }, skip: !connected });
  if (!statusData) return null;
  if (!connected) {
    return (
      <Form.Text>
        Dépôt privé ? <Link to="/settings?section=github">Connectez votre compte GitHub</Link> pour le choisir dans une liste et l'utiliser sans clé de déploiement.
      </Form.Text>
    );
  }
  const repos = data?.githubRepositories ?? [];
  return (
    <div className="border rounded p-2 mb-2">
      <div className="d-flex align-items-center gap-2 mb-2">
        <i className="bi bi-github" />
        <Form.Control size="sm" placeholder="Rechercher un de vos dépôts GitHub…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {loading && <Spinner size="sm" />}
      </div>
      <div className="small" style={{ maxHeight: 160, overflow: 'auto' }}>
        {repos.slice(0, 30).map((r) => (
          <button key={r.fullName} type="button" className="btn btn-link btn-sm p-0 d-block text-start text-decoration-none" onClick={() => onPick(r)}>
            {r.fullName}
            {r.private && <span className="text-secondary"> · privé</span>}
            <span className="text-secondary"> · {r.defaultBranch}</span>
          </button>
        ))}
        {data && repos.length === 0 && <div className="text-secondary">Aucun dépôt ne correspond.</div>}
      </div>
    </div>
  );
}
import { useTabTitle } from '../workbench/TabsContext';


/** Création (sans id) ou édition (avec id) d'un projet. */
export default function ProjectFormPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();

  const { data, loading, error } = useQuery<{ project: Project | null }>(PROJECT, { variables: { id }, skip: !isEdit });
  useTabTitle(isEdit ? (data?.project ? `Modifier · ${data.project.name}` : null) : 'Nouveau projet');
  const [createProject, { loading: creating, error: createError }] = useMutation<{ createProject: Project }>(CREATE_PROJECT, {
    refetchQueries: [{ query: PROJECTS }],
    onCompleted: (res) => navigate(`/projects/${res.createProject.id}`),
  });
  const [updateProject, { loading: updating, error: updateError }] = useMutation<{ updateProject: Project }>(UPDATE_PROJECT, {
    onCompleted: (res) => navigate(`/projects/${res.updateProject.id}`),
  });

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [gitBranch, setGitBranch] = useState('');
  const [runner, setRunner] = useState<'local' | 'docker'>('local');
  const [runnerImage, setRunnerImage] = useState('');
  const [runnerMemory, setRunnerMemory] = useState('');
  const [runnerCpus, setRunnerCpus] = useState('');
  const [runnerBrowser, setRunnerBrowser] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(isEdit);

  useEffect(() => {
    const p = data?.project;
    if (!p) return;
    setName(p.name);
    setSlug(p.slug);
    setDescription(p.description ?? '');
    setSystemPrompt(p.systemPrompt);
    setGitUrl(p.gitUrl ?? '');
    setGitBranch(p.gitBranch ?? '');
    setRunner(p.runner ?? 'local');
    setRunnerImage(p.runnerConfig?.image ?? '');
    setRunnerMemory(p.runnerConfig?.memory ?? '');
    setRunnerCpus(p.runnerConfig?.cpus ?? '');
    setRunnerBrowser(Boolean(p.runnerConfig?.browser));
  }, [data]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const runnerConfig: Record<string, unknown> = Object.fromEntries(Object.entries({ image: runnerImage.trim(), memory: runnerMemory.trim(), cpus: runnerCpus.trim() }).filter(([, v]) => v));
    if (runnerBrowser) runnerConfig.browser = true;
    const common = { name, description: description || null, systemPrompt, gitUrl: gitUrl || null, gitBranch: gitBranch || null, runner, runnerConfig };
    if (isEdit) updateProject({ variables: { id, input: common } });
    else createProject({ variables: { input: { ...common, slug: slug || null } } });
  };

  if (loading) return <Spinner animation="border" size="sm" />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  if (isEdit && !data?.project) return <Alert variant="warning">Projet introuvable.</Alert>;
  const mutationError = createError ?? updateError;

  return (
    <>
      <Link to={isEdit ? `/projects/${id}` : '/projects'} className="small">
        ← Retour
      </Link>
      <h1 className="h3 mb-3">{isEdit ? `Modifier « ${data?.project?.name} »` : 'Nouveau projet'}</h1>
      <Card>
        <Card.Body>
          <Form onSubmit={submit}>
            <Form.Group className="mb-3">
              <Form.Label>Nom</Form.Label>
              <Form.Control value={name} onChange={(e) => setName(e.target.value)} required placeholder="Ex. Site marketing" />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Description</Form.Label>
              <Form.Control value={description} onChange={(e) => setDescription(e.target.value)} placeholder="En une phrase, de quoi il s'agit (facultatif)" />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Instructions permanentes pour les agents</Form.Label>
              <Form.Control
                as="textarea"
                rows={8}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="Ce que tout agent doit savoir sur ce projet : de quoi il s'agit, les conventions à respecter, ce qu'il ne faut pas faire…"
              />
              <Form.Text>Transmis à chaque session lancée dans ce projet, en plus de la tâche demandée.</Form.Text>
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Environnement d'exécution</Form.Label>
              <Form.Select value={runner} onChange={(e) => setRunner(e.target.value as 'local' | 'docker')}>
                <option value="local">Sur le serveur (partagé)</option>
                <option value="docker">Conteneur Docker isolé, dédié au projet</option>
              </Form.Select>
              <Form.Text>
                {runner === 'docker'
                  ? "Les agents, terminaux et commandes tournent dans un conteneur qui ne voit que ce projet, avec des limites de mémoire et de CPU. Nécessite Docker sur le serveur."
                  : "Les agents et terminaux tournent directement sur le serveur, avec l'utilisateur de Skipper."}
              </Form.Text>
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Check
                type="switch"
                id="runnerBrowser"
                label="Navigateur headless pour les agents (Playwright)"
                checked={runnerBrowser}
                onChange={(e) => setRunnerBrowser(e.target.checked)}
              />
              <Form.Text>
                Les agents peuvent ouvrir des pages, cliquer et remplir des formulaires dans un Chromium sans fenêtre, pour tester une interface web. Compte 300 à 500 Mo de mémoire en plus par session
                {runner === 'docker' ? ' : prévoyez une limite mémoire de 1,5 Go pour le conteneur.' : ' ; Chromium doit être installé sur le serveur (npx playwright install chromium).'}
              </Form.Text>
            </Form.Group>

            <div className="mb-3">
              <Button variant="link" size="sm" className="p-0 text-secondary" onClick={() => setShowAdvanced((v) => !v)} aria-expanded={showAdvanced}>
                <i className={`bi bi-chevron-${showAdvanced ? 'down' : 'right'} me-1`} />
                Options avancées
              </Button>
              <Collapse in={showAdvanced}>
                <div className="pt-2 ps-3 border-start">
                  <Form.Group className="mb-3">
                    <Form.Label>Identifiant (nom du dossier de travail)</Form.Label>
                    <Form.Control value={slug} onChange={(e) => setSlug(e.target.value)} disabled={isEdit} placeholder="généré à partir du nom si vide" pattern="[a-z0-9][a-z0-9-]*" />
                    <Form.Text>Minuscules, chiffres et tirets. {isEdit ? 'Non modifiable après création.' : 'Le dossier de travail portera ce nom.'}</Form.Text>
                  </Form.Group>
                  {runner === 'docker' && (
                    <Row className="g-2 mb-3">
                      <Col sm={6}>
                        <Form.Label className="small mb-1">Image Docker</Form.Label>
                        <Form.Control size="sm" value={runnerImage} onChange={(e) => setRunnerImage(e.target.value)} placeholder="skipper-runner:latest" />
                      </Col>
                      <Col sm={3}>
                        <Form.Label className="small mb-1">Mémoire</Form.Label>
                        <Form.Control size="sm" value={runnerMemory} onChange={(e) => setRunnerMemory(e.target.value)} placeholder="1g" />
                      </Col>
                      <Col sm={3}>
                        <Form.Label className="small mb-1">CPU</Form.Label>
                        <Form.Control size="sm" value={runnerCpus} onChange={(e) => setRunnerCpus(e.target.value)} placeholder="1" />
                      </Col>
                      <Form.Text>Vides : valeurs par défaut du serveur. Un changement d'image ou de limites s'applique après « Recréer » sur la page du projet.</Form.Text>
                    </Row>
                  )}
                </div>
              </Collapse>
            </div>

            <fieldset className="mb-3">
              <legend className="h6">Dépôt git (facultatif)</legend>
              {!isEdit && (
                <GithubRepoPicker
                  onPick={(r) => {
                    setGitUrl(r.cloneUrl);
                    setGitBranch(r.defaultBranch);
                    if (!name) setName(r.name);
                  }}
                />
              )}
              <Form.Group className="mb-2">
                <Form.Label className="small mb-1">URL</Form.Label>
                <Form.Control value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} placeholder="https://github.com/org/repo.git ou git@github.com:org/repo.git" />
              </Form.Group>
              <Form.Group className="mb-2">
                <Form.Label className="small mb-1">Branche</Form.Label>
                <Form.Control value={gitBranch} onChange={(e) => setGitBranch(e.target.value)} placeholder="défaut du dépôt si vide" />
              </Form.Group>
              <Form.Text>
                {isEdit
                  ? "Modifier l'adresse n'affecte pas un dossier de travail déjà créé."
                  : 'Si vous indiquez un dépôt, son code est récupéré dans le dossier de travail à la création du projet.'}
              </Form.Text>
            </fieldset>

            {mutationError && <Alert variant="danger">{mutationError.message}</Alert>}

            <Button type="submit" disabled={creating || updating}>
              {creating || updating ? 'Enregistrement…' : isEdit ? 'Enregistrer' : 'Créer le projet'}
            </Button>
          </Form>
        </Card.Body>
      </Card>
    </>
  );
}
