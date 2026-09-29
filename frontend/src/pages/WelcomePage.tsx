import { useQuery } from '@apollo/client';
import { Button, Card, Col, Row } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { PROJECTS, REQUESTS, type HumanRequest, type Project } from '../graphql/operations';
import { useTabTitle } from '../workbench/TabsContext';
import { useSessionLauncher } from '../components/SessionLauncher';

/** Page d'accueil : explique le parcours en trois étapes et oriente vers l'action suivante. */
export default function WelcomePage() {
  useTabTitle('Accueil');
  const { openNewSession } = useSessionLauncher();
  const { data } = useQuery<{ projects: Project[] }>(PROJECTS);
  const { data: pending } = useQuery<{ requests: HumanRequest[] }>(REQUESTS, { variables: { status: 'PENDING' }, pollInterval: 3000 });
  const projects = data?.projects ?? [];
  const pendingCount = pending?.requests.length ?? 0;

  return (
    <>
      <h1 className="h3 mb-2">Bienvenue sur Skipper</h1>
      <p className="text-secondary mb-4" style={{ maxWidth: 720 }}>
        Skipper vous permet de confier du travail à des agents (Claude Code, pour commencer) qui travaillent en arrière-plan sur vos projets.
        Vous gardez la main : vous leur donnez des instructions, vous suivez ce qu'ils font, et ils vous demandent votre accord avant les actions sensibles.
      </p>

      {pendingCount > 0 && (
        <Card className="mb-4 border-warning">
          <Card.Body className="d-flex justify-content-between align-items-center">
            <span>
              <i className="bi bi-bell-fill text-warning me-2" />
              {pendingCount === 1 ? 'Un agent attend votre réponse.' : `${pendingCount} agents attendent votre réponse.`}
            </span>
            <Button as={Link as any} to="/requests" size="sm" variant="warning">
              Voir les demandes
            </Button>
          </Card.Body>
        </Card>
      )}

      <Row className="g-3">
        <Col md={4}>
          <Card className="h-100">
            <Card.Body>
              <div className="fs-4 mb-2">
                <i className="bi bi-folder2 text-secondary" /> <span className="badge bg-secondary">1</span>
              </div>
              <Card.Title className="h6">Créez un projet</Card.Title>
              <Card.Text className="text-secondary small">
                Un projet regroupe un dossier de travail (avec, si vous voulez, un dépôt git), des instructions permanentes pour les agents, et leurs sessions.
              </Card.Text>
              <Button as={Link as any} to="/projects/new" size="sm" variant={projects.length ? 'outline-primary' : 'primary'}>
                Nouveau projet
              </Button>
            </Card.Body>
          </Card>
        </Col>
        <Col md={4}>
          <Card className="h-100">
            <Card.Body>
              <div className="fs-4 mb-2">
                <i className="bi bi-chat-dots text-secondary" /> <span className="badge bg-secondary">2</span>
              </div>
              <Card.Title className="h6">Lancez une session</Card.Title>
              <Card.Text className="text-secondary small">
                Décrivez ce que l'agent doit faire. Il travaille en arrière-plan, vous suivez ses actions en direct et pouvez lui écrire à tout moment.
              </Card.Text>
              <Button size="sm" variant={projects.length ? 'primary' : 'outline-secondary'} disabled={!projects.length} onClick={() => openNewSession()}>
                Nouvelle session
              </Button>
            </Card.Body>
          </Card>
        </Col>
        <Col md={4}>
          <Card className="h-100">
            <Card.Body>
              <div className="fs-4 mb-2">
                <i className="bi bi-bell text-secondary" /> <span className="badge bg-secondary">3</span>
              </div>
              <Card.Title className="h6">Répondez aux demandes</Card.Title>
              <Card.Text className="text-secondary small">
                Quand un agent veut modifier un fichier, lancer une commande ou a une question, il vous demande. Autorisez, refusez ou expliquez.
              </Card.Text>
              <Button as={Link as any} to="/requests" size="sm" variant="outline-secondary">
                Voir les demandes
              </Button>
            </Card.Body>
          </Card>
        </Col>
      </Row>

      {projects.length > 0 && (
        <>
          <h2 className="h6 mt-4 mb-2 text-secondary">Vos projets</h2>
          <div className="d-flex flex-wrap gap-2">
            {projects.map((p) => (
              <Button key={p.id} as={Link as any} to={`/projects/${p.id}`} size="sm" variant="outline-secondary">
                <i className="bi bi-folder2 me-1" /> {p.name}
              </Button>
            ))}
          </div>
        </>
      )}
    </>
  );
}
