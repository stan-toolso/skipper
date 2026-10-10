import { Activity, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, type Location } from 'react-router-dom';
import { useTabs } from './TabsContext';

/**
 * Les pages visitées restent montées mais cachées tant que leur onglet est ouvert : ce qu'on y tapait
 * (instruction, fichier, formulaire) se retrouve tel quel en y revenant. Une page cachée n'exécute aucun
 * effet (sondages, raccourcis, sockets arrêtés) ; ils repartent à l'affichage. Fermer l'onglet démonte la page.
 */
export default function TabPages({ render }: { render: (location: Location) => ReactNode }) {
  const location = useLocation();
  const { tabs, activeKey } = useTabs();
  const [visited, setVisited] = useState<string[]>([]);

  useEffect(() => {
    setVisited((prev) => (prev.includes(activeKey) ? prev : [...prev, activeKey]));
  }, [activeKey]);

  const open = useMemo(() => new Set(tabs.map((t) => t.key)), [tabs]);
  const kept = visited.filter((k) => open.has(k) || k === activeKey);
  const urlOf = (key: string) => tabs.find((t) => t.key === key)?.url ?? key;
  const locationFor = (key: string): Location => {
    const url = urlOf(key);
    const q = url.indexOf('?');
    return { pathname: q >= 0 ? url.slice(0, q) : url, search: q >= 0 ? url.slice(q) : '', hash: '', state: null, key: `tab:${key}` };
  };

  return (
    <>
      {kept.map((key) => (
        <Activity key={key} mode={key === activeKey ? 'visible' : 'hidden'}>
          {render(key === activeKey ? location : locationFor(key))}
        </Activity>
      ))}
    </>
  );
}
