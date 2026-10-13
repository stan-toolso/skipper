import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { formatTokens } from '../lib/humanize';
import AddMenu from './AddMenu';
import { useTabs } from './TabsContext';
import { mineFirst, sessionGroups, subagentsSummary, type SidebarSession } from './workspaces';

export function sessionDotClass(s: Pick<SidebarSession, 'status' | 'activity' | 'pendingRequestCount'>): string {
  if (s.pendingRequestCount > 0) return 'ask';
  if (s.status === 'RUNNING') return s.activity === 'BUSY' ? 'busy' : 'idle';
  if (s.status === 'QUEUED' || s.status === 'PENDING') return 'pending';
  if (s.status === 'FAILED') return 'failed';
  if (s.status === 'COMPLETED') return 'done';
  return 'stopped';
}

/** Pastille « contexte lourd » d'une session dont le contexte dépasse le seuil serveur : la page propose de le nettoyer. */
export function ContextDot({ context }: { context: { tokens: number | null } }) {
  return (
    <span className="wb-ctx" title={`Contexte de l'agent : ${formatTokens(context.tokens ?? 0)} tokens. Ouvrez la session pour compacter ou repartir d'une conversation neuve.`}>
      <i className="bi bi-speedometer2" />
    </span>
  );
}

/** Compteur de sous-agents sur la puce ou l'onglet d'une session parente. */
export function SubagentsCount({ children }: { children: SidebarSession[] }) {
  const sum = subagentsSummary(children);
  return (
    <span className={`wb-chip-sub ${sum.state ?? 'none'}`} title={`${sum.label}${sum.hint ? ` · ${sum.hint}` : ''}${sum.pending ? ` · ${sum.pending} demande(s) en attente` : ''}`}>
      <i className="bi bi-robot" />
      {children.length}
    </span>
  );
}

/** Initiales d'un nom (deux lettres). */
export const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

/**
 * Sous-barre d'un dossier de travail : Fichiers, les sessions (les miennes d'abord), le navigateur des sessions
 * qui en ont un, les terminaux, et un « + » pour y ouvrir quelque chose. Affichée seulement quand la page
 * courante appartient à un dossier.
 */
export default function WorkspaceTabs() {
  const location = useLocation();
  const { user } = useAuth();
  const { workspaces } = useTabs();
  const stripRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  const key = workspaces.keyOf(location.pathname);
  const ws = key ? workspaces.get(key) : undefined;

  useEffect(() => {
    stripRef.current?.querySelector<HTMLElement>('.wb-ws-tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [location.pathname, ws?.sessions.length]);

  if (!ws) return null;
  const sessions = mineFirst(ws.sessions, user?.id ?? null);
  const filesActive = location.pathname.startsWith(ws.key);
  const link = (to: string, active: boolean, title: string, children: React.ReactNode) => (
    <Link key={to} to={to} className={`wb-ws-tab${active ? ' active' : ''}`} title={title}>
      {children}
    </Link>
  );
  return (
    <div className="wb-ws-tabs">
      <div
        className="wb-ws-strip"
        ref={stripRef}
        onWheel={(e) => {
          const el = stripRef.current;
          if (!el || el.scrollWidth <= el.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
          el.scrollLeft += e.deltaY;
        }}
      >
        {link(ws.key, filesActive, `Fichiers · ${ws.name}`, (
          <>
            <i className="bi bi-folder2-open" /> Fichiers
          </>
        ))}
        {sessionGroups(sessions).flatMap(({ root, children }) =>
          // Un onglet par session de premier niveau (avec le compte de ses sous-agents) ; un sous-agent n'a le sien que s'il est la page courante ou attend une réponse.
          [root, ...children.filter((c) => location.pathname.startsWith(`/sessions/${c.session.id}`) || c.session.pendingRequestCount > 0)].map(({ session: s, depth, byAgent, parentName }) => {
          const mine = !s.owner || s.owner.id === user?.id;
          return (
            <span key={s.id} className="wb-ws-group">
              {link(`/sessions/${s.id}`, location.pathname === `/sessions/${s.id}`, `${s.name}${byAgent ? ` · sous-agent${parentName ? ` de « ${parentName} »` : ''}` : ''}${s.owner && !mine ? ` · session de ${s.owner.name}` : ''}`, (
                <>
                  {depth > 0 && <span className="wb-tree">└</span>}
                  <span className={`wb-dot ${sessionDotClass(s)}`} />
                  {byAgent && depth === 0 && <i className="bi bi-robot wb-robot" aria-label="Sous-agent" />}
                  <span className="wb-ws-label">{s.name}</span>
                  {depth === 0 && children.length > 0 && <SubagentsCount children={children.map((c) => c.session)} />}
                  {s.context.overThreshold && <ContextDot context={s.context} />}
                  {s.owner && !mine ? <span className="wb-owner" title={`Session de ${s.owner.name}`}>{initialsOf(s.owner.name)}</span> : null}
                  {s.pendingRequestCount > 0 && <span className="wb-badge">{s.pendingRequestCount}</span>}
                </>
              ))}
              {s.browserActive &&
                link(`/sessions/${s.id}/browser`, location.pathname === `/sessions/${s.id}/browser`, `Navigateur de « ${s.name} »`, (
                  <>
                    <i className="bi bi-globe2 wb-browser-icon" /> Navigateur
                  </>
                ))}
            </span>
          );
          }),
        )}
        {ws.terminals.map((t) =>
          link(`/terminals/${t.id}`, location.pathname === `/terminals/${t.id}`, t.status === 'RUNNING' ? 'Terminal ouvert' : 'Terminal fermé', (
            <>
              <i className={`bi bi-terminal wb-term-icon${t.status === 'RUNNING' ? ' live' : ''}`} /> {t.name}
            </>
          )),
        )}
      </div>
      <span className={`wb-row-actions open wb-ws-add${menu ? ' open' : ''}`}>
        <button
          type="button"
          className="wb-plus"
          title="Ouvrir quelque chose dans ce dossier"
          onClick={(e) => {
            e.stopPropagation();
            setMenu((v) => !v);
          }}
        >
          <i className="bi bi-plus-lg" />
        </button>
        {menu && <AddMenu projectId={ws.projectId} worktree={ws.worktree} canWorktree={false} onClose={() => setMenu(false)} />}
      </span>
    </div>
  );
}
