import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Alert, Button, Col, Form, Row, Table } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useDialogs } from '../components/Dialogs';
import PageLoading from '../components/PageLoading';
import { ADD_CTO_TIME_ENTRY, BILLING_SETTINGS, BILLING_STATEMENT, DELETE_CTO_TIME_ENTRY, UPDATE_BILLING_SETTINGS, type BillingSettings, type BillingStatement } from '../graphql/billing';
import { PROJECTS, type Project } from '../graphql/operations';
import { useElementWidth } from '../lib/useElementWidth';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';
import './dashboard.css';
import './billing.css';

const eur = (n: number) => n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: n >= 1000 ? 0 : 2 });
const num = (n: number, digits = 1) => n.toLocaleString('fr-FR', { maximumFractionDigits: digits });
const credits = (n: number) => `${num(n, n >= 100 ? 0 : 1)} crédit${n >= 2 ? 's' : ''}`;
const manDays = (n: number) => `${num(n, 1)} j/h`;

const monthLabel = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  const s = new Date(y, m - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const shiftMonth = (month: string, delta: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const currentMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const dayLabel = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

/**
 * Consommation de la cellule (administrateurs) : abonnement, usage des agents en crédits (et équivalent
 * jours-homme), temps du CTO Toolso, et facture estimée de fin de mois. Le coût réel des modèles, la
 * conversion en crédits et la marge ne sont visibles et réglables que par un super administrateur (Toolso).
 */
export default function BillingPage() {
  const { user } = useAuth();
  const isOperator = !!user?.isSuperAdmin;
  const [month, setMonth] = useState(currentMonth);
  useTabTitle('Consommation');
  const { data, loading, error } = usePollingQuery<{ billingStatement: BillingStatement }>(BILLING_STATEMENT, { variables: { month }, pollInterval: 60_000 });

  if (loading && !data) return <PageLoading />;
  if (error && !data) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  const s = data!.billingStatement;
  const isCurrent = month === currentMonth();

  return (
    <div className="billing-page">
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-3">
        <h1 className="h3 mb-0">Consommation</h1>
        <div className="d-flex align-items-center gap-1">
          <Button size="sm" variant="outline-secondary" onClick={() => setMonth(shiftMonth(month, -1))} title="Mois précédent" aria-label="Mois précédent">
            <i className="bi bi-chevron-left" />
          </Button>
          <span className="billing-month">{monthLabel(month)}</span>
          <Button size="sm" variant="outline-secondary" onClick={() => setMonth(shiftMonth(month, 1))} disabled={isCurrent} title="Mois suivant" aria-label="Mois suivant">
            <i className="bi bi-chevron-right" />
          </Button>
          {!isCurrent && (
            <Button size="sm" variant="link" onClick={() => setMonth(currentMonth())}>
              Ce mois
            </Button>
          )}
        </div>
      </div>

      {!s.configured && (
        <Alert variant="info" className="py-2 small">
          {isOperator ? "La facturation de cette cellule n'est pas encore configurée : renseignez l'offre plus bas." : "L'offre de cette cellule n'est pas encore renseignée par Toolso : les montants ci-dessous sont indicatifs."}
        </Alert>
      )}

      <div className="dash-tiles mb-4">
        <div className="dash-tile billing-total">
          <div className="dash-tile-label">
            <i className="bi bi-receipt" /> {s.inProgress ? 'Facture estimée fin de mois' : 'Facture du mois'}
          </div>
          <div className="dash-tile-value">{eur(s.inProgress ? s.projectedTotalEur : s.totalEur)}</div>
          <div className="dash-tile-sub">{s.inProgress ? `${eur(s.totalEur)} à ce jour · ${Math.floor(s.daysElapsed)} j sur ${s.daysInMonth}` : 'Montant définitif'} · HT</div>
        </div>
        <div className="dash-tile">
          <div className="dash-tile-label">
            <i className="bi bi-hdd-stack" /> Abonnement {s.plan.planName}
          </div>
          <div className="dash-tile-value">{eur(s.subscription.totalEur)}</div>
          <div className="dash-tile-sub">
            {s.subscription.projects} projet{s.subscription.projects > 1 ? 's' : ''}
            {s.subscription.extraProjects > 0 ? `, dont ${s.subscription.extraProjects} au-delà du forfait` : `, ${s.plan.includedProjects} compris`}
          </div>
        </div>
        <div className="dash-tile">
          <div className="dash-tile-label">
            <i className="bi bi-cpu" /> Travail des agents
          </div>
          <div className="dash-tile-value">
            {num(s.usage.credits, 0)}
            <small>crédits</small>
          </div>
          <div className="dash-tile-sub">
            ≈ {manDays(s.usage.manDays)} · {eur(s.usage.eur)}
            {s.inProgress && <> · fin de mois ≈ {credits(s.usage.projectedCredits)}</>}
          </div>
        </div>
        <div className="dash-tile">
          <div className="dash-tile-label">
            <i className="bi bi-person-workspace" /> Accompagnement CTO
          </div>
          <div className="dash-tile-value">
            {num(s.cto.days, 2)}
            <small>jour{s.cto.days >= 2 ? 's' : ''}</small>
          </div>
          <div className="dash-tile-sub">
            {num(s.cto.hours, 2)} h · {eur(s.cto.eur)}
          </div>
        </div>
      </div>

      <Row className="g-4">
        <Col lg={7}>
          <section className="dash-section">
            <h2 className="dash-section-title">
              <span>Détail de la facture</span>
              <span className="text-secondary">euros HT</span>
            </h2>
            <InvoiceTable s={s} />
          </section>

          <section className="dash-section">
            <h2 className="dash-section-title">
              <span>Travail des agents par jour</span>
              <span className="text-secondary">crédits</span>
            </h2>
            <div className="dash-list billing-chart-box">
              {s.usage.byDay.length ? <CreditsChart days={s.usage.byDay} /> : <div className="text-secondary small p-2">Aucun jour à afficher.</div>}
            </div>
          </section>

          <section className="dash-section">
            <h2 className="dash-section-title">
              <span>Travail des agents par projet</span>
            </h2>
            {s.usage.byProject.length === 0 ? (
              <ul className="dash-list">
                <li className="empty">Aucun travail d'agent ce mois-ci.</li>
              </ul>
            ) : (
              <Table size="sm" hover className="align-middle billing-table">
                <thead>
                  <tr>
                    <th>Projet</th>
                    <th className="num">Crédits</th>
                    <th className="num d-none d-sm-table-cell">Équiv. j/h</th>
                    <th className="num">Montant</th>
                  </tr>
                </thead>
                <tbody>
                  {s.usage.byProject.map((p) => (
                    <tr key={p.projectId ?? 'none'}>
                      <td>{p.projectId ? <Link to={`/projects/${p.projectId}`}>{p.projectName}</Link> : <span className="text-secondary">Projet supprimé</span>}</td>
                      <td className="num">{num(p.credits, 1)}</td>
                      <td className="num d-none d-sm-table-cell">{num(p.manDays, 2)}</td>
                      <td className="num">{eur(p.eur)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </section>
        </Col>

        <Col lg={5}>
          <CtoSection s={s} month={month} isOperator={isOperator} />
          <section className="dash-section">
            <h2 className="dash-section-title">
              <span>Votre offre</span>
            </h2>
            <ul className="dash-list billing-plan">
              <li><span className="main">Forfait {s.plan.planName}</span><span className="side">{eur(s.plan.baseMonthlyEur)} / mois</span></li>
              <li><span className="main">Projets compris</span><span className="side">{s.plan.includedProjects}</span></li>
              <li><span className="main">Projet supplémentaire</span><span className="side">{eur(s.plan.extraProjectEur)} / mois</span></li>
              <li><span className="main">Crédit d'agent</span><span className="side">{eur(s.plan.creditPriceEur)}</span></li>
              <li><span className="main">Équivalent jour-homme</span><span className="side">{num(s.plan.creditsPerManDay, 0)} crédits</span></li>
              <li><span className="main">Journée de CTO ({num(s.plan.ctoHoursPerDay, 1)} h)</span><span className="side">{eur(s.plan.ctoDailyRateEur)}</span></li>
            </ul>
            <p className="text-secondary small mt-2 mb-0">
              Les crédits mesurent le travail fourni par les agents (lecture, écriture et vérification de code, échanges). L'équivalent jour-homme est indicatif : il donne un ordre de grandeur du travail produit.
            </p>
          </section>
          {isOperator && s.operator && <OperatorSection s={s} />}
          {isOperator && <SettingsSection />}
        </Col>
      </Row>
    </div>
  );
}

function InvoiceTable({ s }: { s: BillingStatement }) {
  const showProjection = s.inProgress;
  return (
    <Table size="sm" className="align-middle billing-table">
      <thead>
        <tr>
          <th>Poste</th>
          <th className="num d-none d-sm-table-cell">Quantité</th>
          <th className="num">{showProjection ? 'À ce jour' : 'Montant'}</th>
          {showProjection && <th className="num">Fin de mois</th>}
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Forfait {s.plan.planName}</td>
          <td className="num d-none d-sm-table-cell">1 mois</td>
          <td className="num">{eur(s.subscription.baseEur)}</td>
          {showProjection && <td className="num">{eur(s.subscription.baseEur)}</td>}
        </tr>
        {s.subscription.extraProjects > 0 && (
          <tr>
            <td>Projets supplémentaires</td>
            <td className="num d-none d-sm-table-cell">{s.subscription.extraProjects} × {eur(s.plan.extraProjectEur)}</td>
            <td className="num">{eur(s.subscription.extraEur)}</td>
            {showProjection && <td className="num">{eur(s.subscription.extraEur)}</td>}
          </tr>
        )}
        <tr>
          <td>
            Travail des agents
            <div className="text-secondary small">≈ {manDays(showProjection ? s.usage.projectedManDays : s.usage.manDays)}{showProjection ? ' en fin de mois' : ''}</div>
          </td>
          <td className="num d-none d-sm-table-cell">{credits(s.usage.credits)}</td>
          <td className="num">{eur(s.usage.eur)}</td>
          {showProjection && <td className="num">{eur(s.usage.projectedEur)}</td>}
        </tr>
        <tr>
          <td>Accompagnement CTO</td>
          <td className="num d-none d-sm-table-cell">{num(s.cto.days, 2)} j</td>
          <td className="num">{eur(s.cto.eur)}</td>
          {showProjection && <td className="num">{eur(s.cto.eur)}</td>}
        </tr>
      </tbody>
      <tfoot>
        <tr className="fw-semibold">
          <td>Total HT</td>
          <td className="d-none d-sm-table-cell" />
          <td className="num">{eur(s.totalEur)}</td>
          {showProjection && <td className="num">{eur(s.projectedTotalEur)}</td>}
        </tr>
      </tfoot>
      {showProjection && (
        <caption className="small text-secondary">
          Fin de mois : le travail des agents est extrapolé au rythme des {Math.max(1, Math.floor(s.daysElapsed))} premiers jours ; l'accompagnement CTO est compté tel que saisi.
        </caption>
      )}
    </Table>
  );
}

function CreditsChart({ days }: { days: { day: string; credits: number }[] }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const height = 110;
  const padTop = 16;
  const padBottom = 14;
  const plotH = height - padTop - padBottom;
  const max = Math.max(...days.map((d) => d.credits), 0.01);
  const slot = width / Math.max(days.length, 1);
  const barW = Math.min(16, Math.max(3, slot - 2));
  const peak = days.reduce((a, b) => (b.credits > a.credits ? b : a), days[0]);
  return (
    <div ref={ref} className="dash-chart-wrap">
      {width > 0 && (
        <svg className="dash-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Crédits consommés par jour sur ${days.length} jours`}>
          <line x1={0} x2={width} y1={height - padBottom} y2={height - padBottom} />
          {days.map((d, i) => {
            const h = d.credits > 0 ? Math.max(2, (d.credits / max) * plotH) : 0;
            const x = i * slot + (slot - barW) / 2;
            const y = height - padBottom - h;
            return (
              <g key={d.day}>
                <rect x={x} y={y} width={barW} height={h} rx={Math.min(4, barW / 2)} className="bar" />
                <rect x={i * slot} y={0} width={slot} height={height} className="hit">
                  <title>{`${dayLabel(d.day)} : ${credits(d.credits)}`}</title>
                </rect>
                {d === peak && d.credits > 0 && (
                  <text x={Math.min(width - 4, Math.max(4, x + barW / 2))} y={Math.max(10, y - 3)} textAnchor={i < days.length / 4 ? 'start' : i > (days.length * 3) / 4 ? 'end' : 'middle'}>
                    {num(d.credits, 0)}
                  </text>
                )}
              </g>
            );
          })}
          <text x={2} y={height - 3}>{dayLabel(days[0].day)}</text>
          <text x={width - 2} y={height - 3} textAnchor="end">{dayLabel(days[days.length - 1].day)}</text>
        </svg>
      )}
    </div>
  );
}

function CtoSection({ s, month, isOperator }: { s: BillingStatement; month: string; isOperator: boolean }) {
  const { confirm, showError } = useDialogs();
  const refetch = { refetchQueries: ['BillingStatement'] };
  const [remove] = useMutation(DELETE_CTO_TIME_ENTRY, { ...refetch, onError: (e) => void showError(e) });
  return (
    <section className="dash-section">
      <h2 className="dash-section-title">
        <span>Accompagnement CTO Toolso</span>
        <span className="text-secondary">{num(s.cto.hours, 2)} h</span>
      </h2>
      {isOperator && <CtoForm month={month} />}
      <ul className="dash-list">
        {s.cto.entries.length === 0 && <li className="empty">Aucun temps saisi ce mois-ci.</li>}
        {s.cto.entries.map((e) => (
          <li key={e.id}>
            <span className="icon">
              <i className="bi bi-clock" />
            </span>
            <div className="main">
              <span className="title">{e.description || 'Accompagnement'}</span>
              <div className="meta">
                {dayLabel(e.day)}
                {e.projectName && <> · {e.projectId ? <Link to={`/projects/${e.projectId}`}>{e.projectName}</Link> : e.projectName}</>}
                {e.createdByName && <> · {e.createdByName}</>}
              </div>
            </div>
            <div className="side">{num(e.hours, 2)} h</div>
            {isOperator && (
              <Button
                size="sm"
                variant="link"
                className="text-secondary p-0"
                title="Supprimer cette saisie"
                aria-label="Supprimer cette saisie"
                onClick={async () => {
                  if (await confirm({ title: 'Supprimer cette saisie ?', message: `${num(e.hours, 2)} h le ${dayLabel(e.day)}`, confirmLabel: 'Supprimer', danger: true })) void remove({ variables: { id: e.id } });
                }}
              >
                <i className="bi bi-trash" />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CtoForm({ month }: { month: string }) {
  const { showError } = useDialogs();
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const defaultDay = todayIso.startsWith(month) ? todayIso : `${month}-01`;
  const [day, setDay] = useState(defaultDay);
  const [hours, setHours] = useState('');
  const [projectId, setProjectId] = useState('');
  const [description, setDescription] = useState('');
  useEffect(() => setDay(defaultDay), [defaultDay]);
  const { data } = useQuery<{ projects: Project[] }>(PROJECTS, { variables: { all: true } });
  const projects = (data?.projects ?? []).filter((p) => !p.isPersonal);
  const [add, { loading }] = useMutation(ADD_CTO_TIME_ENTRY, {
    refetchQueries: ['BillingStatement'],
    onCompleted: () => {
      setHours('');
      setDescription('');
    },
    onError: (e) => void showError(e),
  });
  const h = Number(hours.replace(',', '.'));
  return (
    <Form
      className="billing-cto-form mb-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (h > 0) void add({ variables: { input: { day, hours: h, projectId: projectId || null, description } } });
      }}
    >
      <Form.Control type="date" size="sm" value={day} onChange={(e) => setDay(e.target.value)} required aria-label="Date" />
      <Form.Control size="sm" inputMode="decimal" placeholder="Heures" value={hours} onChange={(e) => setHours(e.target.value)} required aria-label="Heures" />
      <Form.Select size="sm" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Projet">
        <option value="">Toute la cellule</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Form.Select>
      <Form.Control size="sm" placeholder="Description (atelier, revue d'architecture…)" value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Description" className="wide" />
      <Button size="sm" type="submit" disabled={loading || !(h > 0)}>
        Ajouter
      </Button>
    </Form>
  );
}

function OperatorSection({ s }: { s: BillingStatement }) {
  const o = s.operator!;
  return (
    <section className="dash-section">
      <h2 className="dash-section-title">
        <span>
          <i className="bi bi-eye-slash me-1" />
          Vue Toolso
        </span>
        <span className="text-secondary">invisible du client</span>
      </h2>
      <ul className="dash-list billing-plan">
        <li><span className="main">Coût réel des modèles (à ce jour)</span><span className="side">{o.costUsd.toLocaleString('fr-FR', { style: 'currency', currency: 'USD' })} ≈ {eur(o.costEur)}</span></li>
        <li><span className="main">Coût réel projeté</span><span className="side">{eur(o.projectedCostEur)}</span></li>
        <li><span className="main">Usage facturé projeté</span><span className="side">{eur(s.usage.projectedEur)}</span></li>
        <li><span className="main">Marge projetée sur l'usage</span><span className="side fw-semibold">{eur(o.projectedMarginEur)}</span></li>
        <li><span className="main">Conversion</span><span className="side">{num(o.creditsPerUsd, 3)} crédits / USD · 1 USD = {num(o.usdToEur, 3)} €</span></li>
      </ul>
    </section>
  );
}

const SETTINGS_FIELDS: { key: Exclude<keyof BillingSettings, 'configured' | 'planName'>; label: string; help?: string; step: string }[] = [
  { key: 'baseMonthlyEur', label: 'Forfait mensuel (€ HT)', step: '1' },
  { key: 'includedProjects', label: 'Projets compris', step: '1' },
  { key: 'extraProjectEur', label: 'Projet supplémentaire (€ HT / mois)', step: '1' },
  { key: 'creditPriceEur', label: 'Prix du crédit (€ HT)', step: '0.01' },
  { key: 'creditsPerUsd', label: 'Crédits pour 1 USD de coût modèle', help: 'Jamais montré au client : c’est ici que se fixe la marge.', step: '0.01' },
  { key: 'creditsPerManDay', label: 'Crédits pour un jour-homme', step: '1' },
  { key: 'ctoDailyRateEur', label: 'Journée de CTO (€ HT)', step: '1' },
  { key: 'ctoHoursPerDay', label: 'Heures par journée de CTO', step: '0.5' },
  { key: 'usdToEur', label: 'Taux USD → EUR', help: 'Pour le coût réel et la marge de la vue Toolso.', step: '0.001' },
];

function SettingsSection() {
  const { showError } = useDialogs();
  const { data } = useQuery<{ billingSettings: BillingSettings }>(BILLING_SETTINGS);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!data) return;
    const b = data.billingSettings;
    setForm({ planName: b.planName, ...Object.fromEntries(SETTINGS_FIELDS.map((f) => [f.key, String(b[f.key])])) });
  }, [data]);
  const [save, { loading }] = useMutation(UPDATE_BILLING_SETTINGS, {
    refetchQueries: ['BillingStatement', 'BillingSettings'],
    onCompleted: () => setSaved(true),
    onError: (e) => void showError(e),
  });
  if (!data) return null;
  return (
    <section className="dash-section">
      <h2 className="dash-section-title">
        <span>Réglages de facturation</span>
        <span className="text-secondary">super administrateurs</span>
      </h2>
      <Form
        className="dash-list p-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          const input: Record<string, string | number> = { planName: form.planName };
          for (const f of SETTINGS_FIELDS) input[f.key] = Number((form[f.key] ?? '').replace(',', '.'));
          void save({ variables: { input } });
        }}
      >
        <Form.Group className="mb-2">
          <Form.Label className="small mb-1">Nom de l'offre</Form.Label>
          <Form.Control size="sm" value={form.planName ?? ''} onChange={(e) => setForm({ ...form, planName: e.target.value })} placeholder="Cellule M" required />
        </Form.Group>
        <Row className="g-2">
          {SETTINGS_FIELDS.map((f) => (
            <Col sm={6} key={f.key}>
              <Form.Group>
                <Form.Label className="small mb-1">{f.label}</Form.Label>
                <Form.Control size="sm" type="number" min={0} step={f.step} value={form[f.key] ?? ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} required />
                {f.help && <Form.Text className="small">{f.help}</Form.Text>}
              </Form.Group>
            </Col>
          ))}
        </Row>
        <div className="d-flex align-items-center gap-2 mt-3">
          <Button size="sm" type="submit" disabled={loading}>
            Enregistrer
          </Button>
          {saved && <span className="small text-success">Enregistré</span>}
        </div>
      </Form>
    </section>
  );
}
