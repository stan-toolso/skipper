import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useRef, useState } from 'react';
import { Alert, Spinner } from 'react-bootstrap';
import { Link, useParams } from 'react-router-dom';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useCachedName } from '../components/PageLoading';
import { useDeletions } from '../workbench/useDeletions';
import { terminalSocketUrl } from '../apollo';
import { CLOSE_TERMINAL, TERMINAL, TERMINAL_NAME, type Terminal } from '../graphql/operations';
import { useTabTitle } from '../workbench/TabsContext';
import { canAutoFocus } from '../lib/device';
import { useGitTarget } from '../workbench/GitTargetContext';
import { useTheme } from '../lib/theme';


const darkTheme = {
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
const lightTheme = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#b85c3a',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(184, 92, 58, 0.25)',
  black: '#24292f',
  brightBlack: '#6e7781',
  red: '#cf222e',
  green: '#1a7f37',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
};

/** Terminal web : xterm.js relié par WebSocket au shell lancé dans le workspace du projet. */
export default function TerminalPage() {
  const { id = '' } = useParams();
  const { data, loading, error, refetch } = useQuery<{ terminal: Terminal | null }>(TERMINAL, { variables: { id } });
  const [closeTerminal] = useMutation(CLOSE_TERMINAL, { refetchQueries: ['Sidebar'], onCompleted: () => refetch() });
  const { deleteTerminal } = useDeletions();
  const cachedName = useCachedName(TERMINAL_NAME, 'Terminal', id);
  const containerRef = useRef<HTMLDivElement>(null);
  const uiTheme = useTheme();
  const termRef = useRef<XTerm | null>(null);
  // Le terminal suit le thème de l'application sans être recréé.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = uiTheme === 'light' ? lightTheme : darkTheme;
  }, [uiTheme]);
  const [connection, setConnection] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const terminal = data?.terminal;
  useTabTitle(terminal ? `${terminal.name} · ${terminal.project.name}` : cachedName);
  useGitTarget(terminal ? { projectId: terminal.project.id, worksessionId: terminal.worksession?.id ?? null, label: terminal.worksession ? `${terminal.project.name} · ${terminal.worksession.branch}` : terminal.project.name } : null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !terminal || terminal.status !== 'RUNNING') return;

    const term = new XTerm({ theme: uiTheme === 'light' ? lightTheme : darkTheme, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 13, cursorBlink: true, scrollback: 5000, allowProposedApi: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    termRef.current = term;
    fit.fit();

    const ws = new WebSocket(terminalSocketUrl(terminal.id));
    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    ws.onopen = () => {
      setConnection('open');
      sendResize();
      if (canAutoFocus()) term.focus();
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
      termRef.current = null;
    };
  }, [terminal?.id, terminal?.status]);

  if (loading && !data)
    return (
      <div className="term-page">
        <div className="term-header">
          <div>
            <span className="term-title">&gt;_ {cachedName ?? 'Terminal'}</span>
            <span className="term-meta">
              {' '}
              · <Spinner animation="border" size="sm" /> chargement…
            </span>
          </div>
        </div>
      </div>
    );
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
            · <Link to={`/projects/${terminal.project.id}`} className="term-meta">{terminal.project.name}</Link>
            {terminal.worksession && (
              <>
                {' '}
                · <i className="bi bi-git" /> {terminal.worksession.branch}
              </>
            )}{' '}
            · {terminal.worksession?.path ?? terminal.project.workspacePath}
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
            onClick={() => void deleteTerminal({ id, name: terminal.name })}
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
