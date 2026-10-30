import { useQuery } from '@apollo/client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, Spinner } from 'react-bootstrap';
import { useNavigate } from 'react-router-dom';
import { SEARCH } from '../graphql/misc';
import type { SearchHit } from '../graphql/operations';
import { canAutoFocus } from '../lib/device';
import { timeAgo } from '../lib/humanize';
import { useShortcut } from '../lib/useShortcut';

interface State {
  openSearch: () => void;
}
const Ctx = createContext<State | null>(null);

export function useSearchPalette(): State {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSearchPalette doit être utilisé dans un SearchPaletteProvider');
  return ctx;
}

type Kind = SearchHit['kind'];
type Filter = 'ALL' | Kind | 'PAGES';
const KINDS: Kind[] = ['PROJECT', 'SESSION', 'TERMINAL', 'TASK', 'VAULT_ITEM'];
const FILTERS: Filter[] = ['ALL', ...KINDS, 'PAGES'];
const KIND_LABELS: Record<Kind, { one: string; many: string; icon: string }> = {
  PROJECT: { one: 'Projet', many: 'Projets', icon: 'bi-folder2' },
  SESSION: { one: 'Session', many: 'Sessions', icon: 'bi-chat-dots' },
  TERMINAL: { one: 'Terminal', many: 'Terminaux', icon: 'bi-terminal' },
  TASK: { one: 'Tâche', many: 'Tâches', icon: 'bi-check2-square' },
  VAULT_ITEM: { one: 'Élément du coffre', many: 'Coffre', icon: 'bi-shield-lock' },
};

/** Pages de l'application, cherchées en local (libellé + mots-clés). */
const PAGES: { to: string; label: string; keywords: string; icon: string }[] = [
  { to: '/', label: 'Tableau de bord', keywords: 'accueil dashboard', icon: 'bi-speedometer2' },
  { to: '/projects', label: 'Projets', keywords: 'projects', icon: 'bi-folder2' },
  { to: '/sessions', label: 'Sessions', keywords: 'agents conversations', icon: 'bi-chat-dots' },
  { to: '/tasks', label: 'Tâches', keywords: 'tableau todo', icon: 'bi-check2-square' },
  { to: '/vault', label: 'Coffre', keywords: 'secrets identifiants ssh postgres api sites', icon: 'bi-shield-lock' },
  { to: '/shared', label: 'Pages partagées', keywords: 'html rapports', icon: 'bi-file-earmark-richtext' },
  { to: '/requests', label: 'Demandes', keywords: 'permissions questions attente', icon: 'bi-bell' },
  { to: '/settings', label: 'Paramètres', keywords: 'claude github serveur apparence thème', icon: 'bi-gear' },
  { to: '/users', label: 'Utilisateurs', keywords: 'admin administrateurs invitations', icon: 'bi-people' },
];

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function hitUrl(h: SearchHit): string {
  switch (h.kind) {
    case 'PROJECT':
      return `/projects/${h.id}`;
    case 'SESSION':
      return `/sessions/${h.id}`;
    case 'TERMINAL':
      return `/terminals/${h.id}`;
    case 'TASK':
      return `/tasks/${h.id}`;
    case 'VAULT_ITEM':
      return h.projectId ? `/projects/${h.projectId}/vault?item=${h.id}` : `/vault?item=${h.id}`;
  }
}

function hitMeta(h: SearchHit): string {
  const parts: string[] = [];
  if (h.kind === 'SESSION') {
    if (h.status === 'running') parts.push(h.activity === 'busy' ? 'travaille' : 'attend vos instructions');
    else if (h.status === 'queued') parts.push("en file d'attente");
    else if (h.status === 'pending') parts.push('pas démarrée');
    else if (h.status) parts.push(h.status);
  } else if (h.kind === 'TERMINAL') parts.push(h.status === 'running' ? 'ouvert' : 'fermé');
  else if (h.kind === 'TASK') parts.push(h.status === 'in_progress' ? 'en cours' : h.status === 'todo' ? 'à faire' : h.status === 'done' ? 'terminée' : 'annulée');
  parts.push(timeAgo(h.updatedAt));
  if (h.detail && h.kind !== 'SESSION' && h.kind !== 'TASK') parts.push(h.detail);
  return parts.join(' · ');
}

type Row = { key: string; to: string; icon: string; title: string; meta: string; tags: string[]; dot?: string } | { key: string; header: string; count?: number; more?: () => void; moreLabel?: string };

function Palette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('ALL');
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 150);
    return () => clearTimeout(t);
  }, [text]);
  const kinds = filter === 'ALL' || filter === 'PAGES' ? null : [filter];
  const limit = filter === 'ALL' ? (query ? 6 : 5) : expanded ? 50 : 15;
  const { data, previousData, loading } = useQuery<{ search: { groups: { kind: Kind; total: number; hits: SearchHit[] }[] } }>(SEARCH, { variables: { query, kinds, limit }, skip: filter === 'PAGES', fetchPolicy: 'cache-and-network', nextFetchPolicy: 'cache-first' });
  const groups = (data ?? previousData)?.search.groups ?? [];
  const pages = useMemo(() => {
    if (!query && filter !== 'PAGES') return [];
    const words = normalize(query).split(/\s+/).filter(Boolean);
    return PAGES.filter((p) => words.every((w) => normalize(`${p.label} ${p.keywords}`).includes(w)));
  }, [query, filter]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (filter !== 'PAGES') {
      for (const g of groups) {
        const label = KIND_LABELS[g.kind];
        const more = g.total > g.hits.length ? () => (filter === g.kind ? setExpanded(true) : setFilter(g.kind)) : undefined;
        out.push({ key: `h:${g.kind}`, header: query ? label.many : `${label.many} récents`, count: g.total, more, moreLabel: more ? `${g.total - g.hits.length} de plus — tout afficher` : undefined });
        for (const h of g.hits) {
          out.push({
            key: `${h.kind}:${h.id}`,
            to: hitUrl(h),
            icon: label.icon,
            title: h.title,
            meta: hitMeta(h),
            tags: [...(h.outsideProjects ? ['non membre'] : []), ...(h.projectName && h.kind !== 'PROJECT' ? [h.projectName] : []), ...(h.worksessionBranch ? [h.worksessionBranch] : [])],
            dot: h.kind === 'SESSION' ? (h.status === 'running' ? (h.activity === 'busy' ? 'busy' : 'idle') : h.status === 'queued' ? 'pending' : h.status === 'failed' ? 'failed' : h.status === 'completed' ? 'done' : 'stopped') : undefined,
          });
        }
      }
    }
    if (pages.length) {
      out.push({ key: 'h:pages', header: 'Pages' });
      for (const p of pages) out.push({ key: `page:${p.to}`, to: p.to, icon: p.icon, title: p.label, meta: p.keywords, tags: [] });
    }
    return out;
  }, [groups, pages, query, filter]);
  const items = rows.filter((r): r is Extract<Row, { to: string }> => 'to' in r);
  useEffect(() => setSelected(0), [rows.length, query, filter]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.sp-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const go = (to: string) => {
    onClose();
    navigate(to);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Home') setSelected(0);
    else if (e.key === 'End') setSelected(items.length - 1);
    else if (e.key === 'Enter') {
      const it = items[selected];
      if (it) go(it.to);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const i = FILTERS.indexOf(filter);
      setFilter(FILTERS[(i + (e.shiftKey ? -1 : 1) + FILTERS.length) % FILTERS.length]);
      setExpanded(false);
    } else if (e.key === 'Escape') onClose();
  };

  let index = -1;
  return (
    <Modal show onHide={onClose} animation={false} dialogClassName="sp-dialog" contentClassName="sp-content">
      <div className="sp-head">
        <i className="bi bi-search" />
        <input autoFocus={canAutoFocus()} className="sp-input" placeholder="Rechercher un projet, une session, une tâche, un élément du coffre…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
        {loading && <Spinner size="sm" />}
      </div>
      <div className="sp-filters" role="tablist">
        {FILTERS.map((f) => (
          <button key={f} type="button" role="tab" aria-selected={filter === f} className={`sp-filter${filter === f ? ' active' : ''}`} onClick={() => { setFilter(f); setExpanded(false); }}>
            {f === 'ALL' ? 'Tout' : f === 'PAGES' ? 'Pages' : KIND_LABELS[f].many}
          </button>
        ))}
      </div>
      <div className="sp-list" ref={listRef}>
        {rows.map((r) => {
          if ('header' in r) {
            return (
              <div key={r.key} className="sp-group">
                <span>
                  {r.header}
                  {r.count !== undefined && <span className="sp-count">{r.count}</span>}
                </span>
                {r.more && (
                  <button type="button" className="sp-more" onClick={r.more}>
                    {r.moreLabel}
                  </button>
                )}
              </div>
            );
          }
          index += 1;
          const i = index;
          return (
            <button key={r.key} type="button" className={`sp-row${i === selected ? ' active' : ''}`} onMouseEnter={() => setSelected(i)} onClick={() => go(r.to)}>
              {r.dot ? <span className={`wb-dot ${r.dot}`} /> : <i className={`bi ${r.icon}`} />}
              <span className="sp-main">
                <span className="sp-title">{r.title}</span>
                <span className="sp-meta">{r.meta}</span>
              </span>
              <span className="sp-tags">
                {r.tags.map((t) => (
                  <span key={t} className="sp-tag">
                    {t}
                  </span>
                ))}
              </span>
            </button>
          );
        })}
        {rows.length === 0 && <div className="sp-empty">{query ? `Rien ne correspond à « ${query} »${filter !== 'ALL' && filter !== 'PAGES' ? ` dans ${KIND_LABELS[filter].many.toLowerCase()}` : ''}.` : 'Rien pour le moment.'}</div>}
      </div>
      <div className="sp-foot d-none d-md-flex">
        <span><kbd>Entrée</kbd> ouvrir</span>
        <span><kbd>Échap</kbd> fermer</span>
        <span><kbd>↑↓</kbd> naviguer</span>
        <span><kbd>Tab</kbd> filtrer</span>
      </div>
    </Modal>
  );
}

/** Palette de recherche globale (⌘K). */
export function SearchPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openSearch = useCallback(() => setOpen(true), []);
  useShortcut({ id: 'search.toggle', keys: ['mod+k'], label: 'Ouvrir la recherche', scope: 'global' }, () => setOpen((v) => !v));
  const value = useMemo(() => ({ openSearch }), [openSearch]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {open && <Palette onClose={() => setOpen(false)} />}
    </Ctx.Provider>
  );
}
