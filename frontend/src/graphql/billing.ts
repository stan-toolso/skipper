import { gql } from '@apollo/client';

export interface CtoTimeEntry {
  id: string;
  day: string;
  hours: number;
  projectId: string | null;
  projectName: string | null;
  description: string;
  createdByName: string | null;
  createdAt: string;
}

export interface BillingPlan {
  planName: string;
  baseMonthlyEur: number;
  includedProjects: number;
  extraProjectEur: number;
  creditPriceEur: number;
  creditsPerManDay: number;
  ctoDailyRateEur: number;
  ctoHoursPerDay: number;
}

export interface BillingSettings extends BillingPlan {
  configured: boolean;
  creditsPerUsd: number;
  usdToEur: number;
}

export interface BillingStatement {
  month: string;
  configured: boolean;
  inProgress: boolean;
  daysInMonth: number;
  daysElapsed: number;
  plan: BillingPlan;
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
  operator: { creditsPerUsd: number; usdToEur: number; costUsd: number; costEur: number; projectedCostEur: number; projectedMarginEur: number } | null;
}

export const BILLING_STATEMENT = gql`
  query BillingStatement($month: String) {
    billingStatement(month: $month) {
      month
      configured
      inProgress
      daysInMonth
      daysElapsed
      plan {
        planName
        baseMonthlyEur
        includedProjects
        extraProjectEur
        creditPriceEur
        creditsPerManDay
        ctoDailyRateEur
        ctoHoursPerDay
      }
      subscription {
        projects
        extraProjects
        baseEur
        extraEur
        totalEur
      }
      usage {
        credits
        eur
        manDays
        projectedCredits
        projectedEur
        projectedManDays
        byProject {
          projectId
          projectName
          credits
          eur
          manDays
        }
        byDay {
          day
          credits
        }
      }
      cto {
        hours
        days
        eur
        entries {
          id
          day
          hours
          projectId
          projectName
          description
          createdByName
          createdAt
        }
      }
      totalEur
      projectedTotalEur
      operator {
        creditsPerUsd
        usdToEur
        costUsd
        costEur
        projectedCostEur
        projectedMarginEur
      }
    }
  }
`;


export const BILLING_SETTINGS = gql`
  query BillingSettings {
    billingSettings {
      configured
      planName
      baseMonthlyEur
      includedProjects
      extraProjectEur
      creditPriceEur
      creditsPerUsd
      creditsPerManDay
      ctoDailyRateEur
      ctoHoursPerDay
      usdToEur
    }
  }
`;

export const UPDATE_BILLING_SETTINGS = gql`
  mutation UpdateBillingSettings($input: BillingSettingsInput!) {
    updateBillingSettings(input: $input) {
      configured
      planName
      baseMonthlyEur
      includedProjects
      extraProjectEur
      creditPriceEur
      creditsPerUsd
      creditsPerManDay
      ctoDailyRateEur
      ctoHoursPerDay
      usdToEur
    }
  }
`;

export const ADD_CTO_TIME_ENTRY = gql`
  mutation AddCtoTimeEntry($input: CtoTimeEntryInput!) {
    addCtoTimeEntry(input: $input) {
      id
    }
  }
`;

export const DELETE_CTO_TIME_ENTRY = gql`
  mutation DeleteCtoTimeEntry($id: ID!) {
    deleteCtoTimeEntry(id: $id)
  }
`;
