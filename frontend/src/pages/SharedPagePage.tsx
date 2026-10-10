import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Alert, Form } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { sharedPageUrl } from '../apollo';
import { useDialogs } from '../components/Dialogs';
import PageLoading from '../components/PageLoading';
import SharePageModal from '../components/pages/SharePageModal';
import { DELETE_SHARED_PAGE, REMOVE_SHARED_PAGE_MEMBER, SHARED_PAGE, UPDATE_SHARED_PAGE, type SharedPage } from '../graphql/misc';
import { useAuth } from '../auth/AuthContext';
import { formatSize } from '../lib/files';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';
import { accessLabel } from './SharedPagesPage';

const fmt = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

/** Lecture d'une page partagée dans un bac à sable, avec ses versions et ses actions. */
export default function SharedPagePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { confirm, prompt, showError } = useDialogs();
  const { data, loading, error } = usePollingQuery<{ sharedPage: SharedPage | null }>(SHARED_PAGE, { variables: { id }, pollInterval: 15_000 });
  const page = data?.sharedPage;
  useTabTitle(page?.title ?? 'Page');
  const [version, setVersion] = useState<number | null>(null);
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [update] = useMutation(UPDATE_SHARED_PAGE, { refetchQueries: ['SharedPage', 'SharedPages'], onError: (e) => void showError(e) });
  const [remove] = useMutation(DELETE_SHARED_PAGE, { refetchQueries: ['SharedPages'], onError: (e) => void showError(e) });
  const [leave] = useMutation(REMOVE_SHARED_PAGE_MEMBER, { refetchQueries: ['SharedPages'], onError: (e) => void showError(e) });

  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger" className="m-3">Erreur : {error.message}</Alert>;
  if (!page) return <Alert variant="warning" className="m-3">Cette page n'existe pas, ou elle ne vous a pas été partagée. Demandez à son propriétaire de la partager avec vous.</Alert>;
  const owner = page.viewerAccess.owner;
  const shown = version ?? page.version;
  const shownVersion = page.versions.find((v) => v.version === shown);
  const viewUrl = sharedPageUrl(page.id, version);
  const access = accessLabel(page);
  const shared = page.linkAccess || page.members.length > 0;
  return (
    <div className="preview-page">
      <div className="term-header">
        <div className="min-w-0">
          <span className="term-title">{page.title}</span>
          <span className="term-meta">
            {' '}
            · {owner ? 'à vous' : `par ${page.owner.name}`} · <i className={`bi ${access.icon}`} /> {access.text}
            {page.versions.length > 1 ? (
              <>
                {' '}
                ·{' '}
                <Form.Select size="sm" className="d-inline-block w-auto py-0" value={version ?? ''} onChange={(e) => setVersion(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">dernière (v{page.version})</option>
                  {page.versions.map((v) => (
                    <option key={v.version} value={v.version}>
                      v{v.version} · {fmt(v.createdAt)}
                    </option>
                  ))}
                </Form.Select>
              </>
            ) : null}
            {shownVersion && ` · mise à jour ${fmt(shownVersion.createdAt)} · ${formatSize(shownVersion.size)}`}
            {owner && page.session && (
              <>
                {' '}
                · depuis{' '}
                <Link to={`/sessions/${page.session.id}`} className="term-meta" title={page.sourcePath ?? undefined}>
                  {page.session.name}
                </Link>
              </>
            )}
            {owner && !page.session && page.project && ` · depuis ${page.project.name}`}
          </span>
        </div>
        <div className="d-flex gap-1 flex-wrap">
          {owner && (
            <button type="button" className="cc-btn accent" onClick={() => setSharing(true)}>
              <i className="bi bi-people" /> Partager
            </button>
          )}
          <button
            type="button"
            className="cc-btn"
            onClick={() => {
              void navigator.clipboard?.writeText(`${window.location.origin}/shared/${page.id}`);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            <i className={`bi ${copied ? 'bi-check2' : 'bi-link-45deg'}`} /> {copied ? 'Copié' : 'Copier le lien'}
          </button>
          <a className="cc-btn" href={viewUrl} target="_blank" rel="noopener noreferrer">
            <i className="bi bi-box-arrow-up-right" /> Ouvrir dans un onglet
          </a>
          <a className="cc-btn" href={sharedPageUrl(page.id, version, true)}>
            <i className="bi bi-download" /> Télécharger
          </a>
          {owner && (
            <button
              type="button"
              className="cc-btn"
              onClick={async () => {
                const title = await prompt({ title: 'Renommer la page', defaultValue: page.title, confirmLabel: 'Renommer' });
                if (title && title.trim() && title.trim() !== page.title) update({ variables: { id: page.id, input: { title: title.trim() } } });
              }}
            >
              <i className="bi bi-pencil" /> Renommer
            </button>
          )}
          {owner && (
            <button
              type="button"
              className="cc-btn danger"
              onClick={async () => {
                if (await confirm({ title: 'Supprimer la page', message: `Supprimer « ${page.title} » et ses ${page.versions.length} version${page.versions.length > 1 ? 's' : ''} ?${shared ? ' Le lien cessera de fonctionner pour toutes les personnes avec qui elle est partagée.' : ''}`, confirmLabel: 'Supprimer', danger: true })) {
                  await remove({ variables: { id: page.id } });
                  navigate('/shared');
                }
              }}
            >
              <i className="bi bi-trash" /> Supprimer
            </button>
          )}
          {!owner && page.viewerAccess.member && (
            <button
              type="button"
              className="cc-btn"
              onClick={async () => {
                if (await confirm({ title: 'Quitter la page', message: `Ne plus voir cette page de ${page.owner.name} ?${page.linkAccess ? ' Le lien restera ouvert à toute personne de Skipper.' : ''}`, confirmLabel: 'Quitter' })) {
                  await leave({ variables: { id: page.id, userId: user?.id } });
                  navigate('/shared');
                }
              }}
            >
              Quitter
            </button>
          )}
        </div>
      </div>
      <iframe key={`${page.id}:${shown}`} className="preview-frame" title={page.title} src={viewUrl} sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads" allow="clipboard-write" />
      {sharing && <SharePageModal page={page} onClose={() => setSharing(false)} />}
    </div>
  );
}
