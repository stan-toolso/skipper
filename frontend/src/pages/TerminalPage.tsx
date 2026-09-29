import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Spinner } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { terminalSocketUrl } from '../apollo';
import { CLOSE_TERMINAL, DELETE_TERMINAL, TERMINAL, type Terminal } from '../graphql/operations';
import { useTabTitle } from '../workbench/TabsContext';

const theme = {
  background: '#141414',
  foreground: '#e8e6e3',
  cursor: '#d97757',
  cursorAccent: '#141414',
  selectionBackground: 'rgba(217, 119, 87, 0.3)',
  black: '#1a1a1a',
  brightBlack: '#5c5c5c',
  red: '#e5534b',
  green: '#5cb85c',
  yellow: '#e3b341',
  blue: '#6fa8dc',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#e8e6e3',
};

/** Terminal web : xterm.js relié par WebSocket au shell lancé dans le workspace du projet. */
export default function TerminalPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, loading, error, refetch } = useQuery<{ terminal: Terminal | null }>(TERMINAL, { variables: { id } });
  const [closeTerminal] = useMutation(CLOSE_TERMINAL, { refetchQueries: ['Sidebar'], onCompleted: () => refetch() });
  const [deleteTerminal] = useMutation(DELETE_TERMINAL, { refetchQueries: ['Sidebar'], onCompleted: () => navigate(`/projects/${data?.terminal?.project.id ?? ''}`) });
  const containerRef = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const terminal = data?.terminal;
  useTabTitle(terminal ? `${terminal.name} · ${terminal.project.name}` : null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !terminal || terminal.status !== 'RUNNING') return;

    const term = new XTerm({ theme, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 13, cursorBlink: true, scrollback: 5000, allowProposedApi: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    fit.fit();

    const ws = new WebSocket(terminalSocketUrl(terminal.id));
    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    ws.onopen = () => {
      setConnection('open');
      sendResize();
      term.focus();
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { type: 'data'; data: string } | { type: 'exit'; code: number | null };
      if (message.type === 'data') term.write(message.data);
      else {
        term.write(`\r\n\x1b[90m[processus terminé${message.code !== null ? ` avec le code ${message.code}` : ''}]\x1b[0m\r\n`);
        setConnection('closed');
        void refetch();
      }
    };
    ws.onclose = () => setConnection('closed');
    ws.onerror = () => setConnection('closed');
    const input = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: d }));
    });

    // On n'ajuste xterm que si la taille du conteneur a réellement changé : sinon fit() modifie
    // les dimensions internes, l'observateur se redéclenche et la barre de défilement clignote.
    let last = { width: container.clientWidth, height: container.clientHeight };
    const observer = new ResizeObserver(() => {
      const next = { width: container.clientWidth, height: container.clientHeight };
      if (next.width === last.width && next.height === last.height) return;
      last = next;
      fit.fit();
      sendResize();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      input.dispose();
      ws.close();
      term.dispose();
    };
  }, [terminal?.id, terminal?.status]);

  if (loading && !data) return <Spinner animation="border" size="sm" className="m-3" />;
  if (error) return <Alert variant="danger" className="m-3">Erreur : {error.message}</Alert>;
  if (!terminal) return <Alert variant="warning" className="m-3">Terminal introuvable.</Alert>;

  const live = terminal.status === 'RUNNING';
  return (
    <div className="term-page">
      <div className="term-header">
        <div>
          <span className="term-title">&gt;_ {terminal.name}</span>
          <span className="term-meta">
            {' '}
            · <Link to={`/projects/${terminal.project.id}`} className="term-meta">{terminal.project.name}</Link> · {terminal.project.workspacePath}
            {!live && <> · fermé{terminal.exitCode !== null && ` (code ${terminal.exitCode})`}</>}
            {live && connection !== 'open' && <> · {connection === 'connecting' ? 'connexion…' : 'déconnecté'}</>}
          </span>
        </div>
        <div className="cc-actions">
          {live && (
            <button type="button" className="cc-btn danger" onClick={() => closeTerminal({ variables: { id } })}>
              Fermer le shell
            </button>
          )}
          <button
            type="button"
            className="cc-btn danger"
            onClick={() => {
              if (window.confirm('Supprimer ce terminal ?')) deleteTerminal({ variables: { id } });
            }}
          >
            Supprimer
          </button>
        </div>
      </div>
      {live ? (
        <div className="term-body" ref={containerRef} />
      ) : (
        <div className="p-3 text-secondary">Ce terminal est fermé. Ouvrez-en un nouveau depuis le menu « + » du projet.</div>
      )}
    </div>
  );
}
