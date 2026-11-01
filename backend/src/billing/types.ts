/**
 * Facturation d'une cellule Skipper (une cellule par client). Trois postes, en euros hors taxes :
 * - l'abonnement : forfait de la taille de la cellule, N projets inclus, puis un prix par projet supplémentaire ;
 * - l'usage des agents, exprimé en crédits (et en équivalent jours-homme) : le client ne voit jamais le coût
 *   des modèles (usage_ledger, en USD au tarif API) ni le taux de conversion, réservés au super administrateur ;
 * - le temps passé par un CTO Toolso, saisi par un super administrateur et facturé au tarif journalier.
 */
export interface BillingSettings {
  /** Nom de l'offre affiché au client (ex. « Cellule M »). */
  planName: string;
  /** Forfait mensuel de la cellule. */
  baseMonthlyEur: number;
  /** Projets compris dans le forfait. */
  includedProjects: number;
  /** Prix mensuel d'un projet au-delà des projets compris. */
  extraProjectEur: number;
  /** Prix d'un crédit d'usage des agents. */
  creditPriceEur: number;
  /** Crédits décomptés pour 1 USD de coût des modèles (réservé au super administrateur). */
  creditsPerUsd: number;
  /** Crédits qui valent un jour-homme, pour l'équivalent affiché à côté des crédits. */
  creditsPerManDay: number;
  /** Tarif journalier du CTO Toolso. */
  ctoDailyRateEur: number;
  /** Heures qui font une journée de CTO. */
  ctoHoursPerDay: number;
  /** Taux de change USD → EUR, pour le coût réel et la marge vus du super administrateur. */
  usdToEur: number;
}

export const defaultBillingSettings: BillingSettings = {
  planName: 'Cellule',
  baseMonthlyEur: 0,
  includedProjects: 0,
  extraProjectEur: 0,
  creditPriceEur: 1,
  creditsPerUsd: 1,
  creditsPerManDay: 500,
  ctoDailyRateEur: 0,
  ctoHoursPerDay: 7,
  usdToEur: 0.92,
};

export interface CtoTimeEntry {
  id: string;
  /** AAAA-MM-JJ. */
  day: string;
  hours: number;
  projectId: string | null;
  projectName: string | null;
  description: string;
  createdByName: string | null;
  createdAt: Date;
}

export interface CtoTimeEntryInput {
  day: string;
  hours: number;
  projectId?: string | null;
  description?: string | null;
}

/** Données brutes d'un mois, lues en base, que `computeStatement` met en forme. */
export interface BillingInputs {
  /** Premier jour du mois (minuit, heure du serveur). */
  monthStart: Date;
  /** Instant de calcul. */
  now: Date;
  /** Projets (hors espaces personnels) existant à la fin du mois, ou maintenant pour le mois courant. */
  projectCount: number;
  /** Coût des modèles par projet sur le mois, en USD. */
  usageByProject: { projectId: string | null; projectName: string | null; usd: number }[];
  /** Coût des modèles par jour du mois, en USD (jours vides compris, jusqu'à aujourd'hui). */
  usageByDay: { day: string; usd: number }[];
  /** Coût des modèles des 7 derniers jours (mois précédent compris) : le rythme de la projection. */
  recentUsd: number;
  ctoEntries: CtoTimeEntry[];
}

export interface BillingStatement {
  /** AAAA-MM. */
  month: string;
  configured: boolean;
  /** Le mois est en cours : les montants sont provisoires et une projection est calculée. */
  inProgress: boolean;
  daysInMonth: number;
  /** Jours écoulés (fractionnaires) du mois au moment du calcul. */
  daysElapsed: number;
  plan: Omit<BillingSettings, 'creditsPerUsd' | 'usdToEur'>;
  subscription: { projects: number; extraProjects: number; baseEur: number; extraEur: number; totalEur: number };
  usage: {
    credits: number;
    eur: number;
    manDays: number;
    projectedCredits: number;
    projectedEur: number;
    projectedManDays: number;
    byProject: { projectId: string | null; projectName: string | null; credits: number; eur: number; manDays: number }[];
    byDay: { day: string; credits: number }[];
  };
  cto: { hours: number; days: number; eur: number; entries: CtoTimeEntry[] };
  totalEur: number;
  projectedTotalEur: number;
  /** Coût réel et marge : renseigné pour un super administrateur seulement. */
  operator: { creditsPerUsd: number; usdToEur: number; costUsd: number; costEur: number; projectedCostEur: number; projectedMarginEur: number } | null;
}
