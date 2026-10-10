import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Modal } from 'react-bootstrap';
import { displayCombo, shortcuts, type ShortcutScope } from '../lib/shortcuts';
import { useShortcut } from '../lib/useShortcut';

interface State {
  openHelp: () => void;
}
const Ctx = createContext<State | null>(null);

export function useShortcutsHelp(): State {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useShortcutsHelp doit être utilisé dans un ShortcutsHelpProvider');
  return ctx;
}

const SCOPE_LABELS: Record<ShortcutScope, string> = { global: 'Partout', page: 'Sur une page', context: 'Dans un contexte' };

/** Aide des raccourcis clavier, générée depuis le registre (touche ? ou bouton ⌨ de la sidebar). */
export function ShortcutsHelpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openHelp = useCallback(() => setOpen(true), []);
  useShortcut({ id: 'help.open', keys: ['?'], label: "Afficher l'aide des raccourcis", scope: 'global', focus: 'outside-editable', anyShift: true }, () => setOpen((v) => !v));
  const value = useMemo(() => ({ openHelp }), [openHelp]);
  const defs = open ? shortcuts.list() : [];
  const groups = (['global', 'page', 'context'] as ShortcutScope[]).map((scope) => {
    const inScope = defs.filter((d) => d.scope === scope);
    const areas = [...new Set(inScope.map((d) => d.area ?? ''))];
    return { scope, areas: areas.map((area) => ({ area, defs: inScope.filter((d) => (d.area ?? '') === area) })) };
  });
  return (
    <Ctx.Provider value={value}>
      {children}
      <Modal show={open} onHide={() => setOpen(false)} centered scrollable>
        <Modal.Header closeButton>
          <Modal.Title className="h6">Raccourcis clavier</Modal.Title>
        </Modal.Header>
        <Modal.Body className="shortcuts-help">
          {groups
            .filter((g) => g.areas.length)
            .map((g) => (
              <div key={g.scope} className="mb-3">
                <div className="fw-semibold mb-1">{SCOPE_LABELS[g.scope]}</div>
                {g.areas.map((a) => (
                  <div key={a.area} className="mb-2">
                    {a.area && <div className="small text-secondary mb-1">{a.area}</div>}
                    {a.defs.map((d) => (
                      <div key={d.id} className="d-flex justify-content-between align-items-center py-1">
                        <span>{d.label}</span>
                        <span className="shortcut-keys">
                          {displayCombo(d.keys[0]).map((cap, i) => (
                            <kbd key={i}>{cap}</kbd>
                          ))}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          <div className="small text-secondary">Les raccourcis d'onglets sont sur Alt (Option sur Mac) : Ctrl/⌘+W et +T appartiennent au navigateur.</div>
        </Modal.Body>
      </Modal>
    </Ctx.Provider>
  );
}
