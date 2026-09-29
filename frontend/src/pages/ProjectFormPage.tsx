import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Spinner } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CREATE_PROJECT, PROJECT, PROJECTS, UPDATE_PROJECT, type Project } from '../graphql/operations';
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

  useEffect(() => {
    const p = data?.project;
    if (!p) return;
    setName(p.name);
    setSlug(p.slug);
    setDescription(p.description ?? '');
    setSystemPrompt(p.systemPrompt);
    setGitUrl(p.gitUrl ?? '');
    setGitBranch(p.gitBranch ?? '');
  }, [data]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const common = { name, description: description || null, systemPrompt, gitUrl: gitUrl || null, gitBranch: gitBranch || null };
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
              <Form.Label>Slug (nom du dossier)</Form.Label>
              <Form.Control
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                disabled={isEdit}
                placeholder="dérivé du nom si vide"
                pattern="[a-z0-9][a-z0-9-]*"
              />
              <Form.Text>Minuscules, chiffres et tirets. {isEdit ? 'Non modifiable après création.' : 'Le workspace sera créé dans ce dossier.'}</Form.Text>
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Description</Form.Label>
              <Form.Control value={description} onChange={(e) => setDescription(e.target.value)} />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Prompt système</Form.Label>
              <Form.Control as="textarea" rows={8} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} placeholder="Contexte, règles et conventions données à l'agent pour ce projet." />
              <Form.Text>Ajouté au prompt système de l'agent pour chaque session du projet.</Form.Text>
            </Form.Group>

            <fieldset className="mb-3">
              <legend className="h6">Dépôt git (optionnel)</legend>
              <Form.Group className="mb-2">
                <Form.Label className="small mb-1">URL</Form.Label>
                <Form.Control value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} placeholder="git@github.com:org/repo.git" />
              </Form.Group>
              <Form.Group className="mb-2">
                <Form.Label className="small mb-1">Branche</Form.Label>
                <Form.Control value={gitBranch} onChange={(e) => setGitBranch(e.target.value)} placeholder="défaut du dépôt si vide" />
              </Form.Group>
              <Form.Text>
                {isEdit
                  ? "Modifier l'URL n'affecte pas un workspace déjà cloné."
                  : 'Le dépôt est cloné dans le workspace à la création du projet.'}
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
