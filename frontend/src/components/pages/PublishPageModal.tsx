import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Form, Modal } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { PUBLISH_SHARED_PAGE, SHARED_PAGES, type SharedPage } from '../../graphql/misc';

interface Props {
  projectId: string;
  worksessionId: string | null;
  path: string;
  /** Contenu actuel, pour proposer le <title> comme titre. */
  html: string;
  onClose: () => void;
}

/** Publication d'un fichier HTML du dossier de travail comme page partagée (nouvelle page ou nouvelle version). */
export default function PublishPageModal({ projectId, worksessionId, path, html, onClose }: Props) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const fileName = path.split('/').pop() ?? path;
  const htmlTitle = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  const [title, setTitle] = useState(htmlTitle || fileName.replace(/\.html?$/i, ''));
  const [pageId, setPageId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery<{ sharedPages: SharedPage[] }>(SHARED_PAGES);
  const mine = (data?.sharedPages ?? []).filter((p) => p.owner.id === user?.id);
  const [publish, { loading }] = useMutation<{ publishSharedPage: SharedPage }>(PUBLISH_SHARED_PAGE, { refetchQueries: ['SharedPages'] });
  return (
    <Modal show onHide={onClose} centered>
      <Form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            const res = await publish({ variables: { projectId, worksessionId, path, title: title.trim(), pageId: pageId || null } });
            if (res.data) {
              onClose();
              navigate(`/shared/${res.data.publishSharedPage.id}`);
            }
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <Modal.Header closeButton>
          <Modal.Title className="h5">Publier comme page partagée</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="small text-secondary">
            Une copie de <code>{path}</code>, telle qu'enregistrée, sera publiée à un lien Skipper. La page est privée jusqu'à ce que vous la partagiez.
          </p>
          <Form.Group className="mb-3">
            <Form.Label>Titre</Form.Label>
            <Form.Control value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
          </Form.Group>
          {mine.length > 0 && (
            <Form.Group>
              <Form.Label>Publier comme</Form.Label>
              <Form.Select value={pageId} onChange={(e) => setPageId(e.target.value)}>
                <option value="">Une nouvelle page</option>
                {mine.map((p) => (
                  <option key={p.id} value={p.id}>
                    Nouvelle version de « {p.title} » (v{p.version + 1}, même lien)
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
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
          <Button type="submit" disabled={loading || !title.trim()}>
            Publier
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
