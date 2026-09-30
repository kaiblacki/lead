import type { AuditResult, FetchResult, Lead } from './core/types.ts';
import { buildAudit } from './auditor/analyze.ts';
import { scoreOpportunity, type Opportunity, type ScoringConfig } from './scoring/opportunity.ts';
import { buildSalesPackage, type Pricing, type SalesPackage } from './ai/sales.ts';
import { Budget } from './guardrails/budget.ts';

export type LeadReport = { lead: Lead; audit: AuditResult; opportunity: Opportunity; sales: SalesPackage | null };

export async function runPipeline(
  leads: Lead[],
  deps: { fetchSite: (url: string) => Promise<FetchResult>; scoring: ScoringConfig; pricing: Pricing; budget: Budget; now?: Date },
): Promise<{ reports: LeadReport[]; stoppedReason?: string }> {
  const reports: LeadReport[] = [];
  for (const lead of leads) {
    try {
      deps.budget.takeLead();
      let fetched: FetchResult | null = null;
      if (lead.websiteUrl) { deps.budget.takeAudit(); fetched = await deps.fetchSite(lead.websiteUrl); }
      const audit = buildAudit(lead, fetched, deps.now);
      const opportunity = scoreOpportunity(lead, audit, deps.scoring, deps.now);
      reports.push({ lead, audit, opportunity, sales: buildSalesPackage(lead, audit, opportunity, deps.pricing) });
    } catch (e) {
      return { reports, stoppedReason: e instanceof Error ? e.message : String(e) };
    }
  }
  return { reports };
}
