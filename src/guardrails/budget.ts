export type Limits = {
  maxLeadsPerRun: number;
  maxAuditsPerRun: number;
  maxAiRequestsPerLead: number;
  maxDailyCents: number;
  maxMonthlyCents: number;
  maxPlacesRequestsPerRun: number;
  maxCrawlPagesPerRun: number;
};
export const DEFAULT_LIMITS: Limits = { maxLeadsPerRun: 500, maxAuditsPerRun: 500, maxAiRequestsPerLead: 3, maxDailyCents: 500, maxMonthlyCents: 5000, maxPlacesRequestsPerRun: 20, maxCrawlPagesPerRun: 4000 };
export const LIMIT_LABELS: Record<keyof Limits, string> = {
  maxLeadsPerRun: 'Max. Leads pro Lauf', maxAuditsPerRun: 'Max. Website-Analysen pro Lauf', maxAiRequestsPerLead: 'Max. KI-Anfragen pro Lead', maxDailyCents: 'Max. KI-Budget pro Tag (Cent)',
  maxMonthlyCents: 'Max. KI-Budget pro Monat (Cent)', maxPlacesRequestsPerRun: 'Max. Places-/Verzeichnis-Anfragen pro Lauf', maxCrawlPagesPerRun: 'Max. Seitenabrufe (Crawler) pro Lauf',
};

export class BudgetExceeded extends Error {}
export class KillSwitchActive extends Error {}

/** Zählt pro Lauf. Jeder teure Schritt ruft vorher `take...` auf; bei Überschreitung wird abgebrochen. */
export class Budget {
  leads = 0; audits = 0; placesRequests = 0; crawlPages = 0; dailyCents: number; monthlyCents: number;
  private aiPerLead = new Map<string, number>();
  killSwitch = false;
  readonly limits: Limits;
  constructor(limits: Limits = DEFAULT_LIMITS, used = { dailyCents: 0, monthlyCents: 0 }) {
    this.limits = limits;
    this.dailyCents = used.dailyCents; this.monthlyCents = used.monthlyCents;
  }
  private guard() { if (this.killSwitch) throw new KillSwitchActive('Kill Switch ist aktiv'); }
  takeLead() { this.guard(); if (this.leads >= this.limits.maxLeadsPerRun) throw new BudgetExceeded('MAX LEADS / RUN erreicht'); this.leads++; }
  takeAudit() { this.guard(); if (this.audits >= this.limits.maxAuditsPerRun) throw new BudgetExceeded('MAX WEBSITE ANALYSES / RUN erreicht'); this.audits++; }
  takePlaces(n = 1) { this.guard(); if (this.placesRequests + n > this.limits.maxPlacesRequestsPerRun) throw new BudgetExceeded('MAX PLACES REQUESTS / RUN erreicht'); this.placesRequests += n; }
  takeCrawl(n = 1) { this.guard(); if (this.crawlPages + n > this.limits.maxCrawlPagesPerRun) throw new BudgetExceeded('MAX CRAWL PAGES / RUN erreicht'); this.crawlPages += n; }
  takeAi(leadId: string, estCents: number) {
    this.guard();
    const n = this.aiPerLead.get(leadId) ?? 0;
    if (n >= this.limits.maxAiRequestsPerLead) throw new BudgetExceeded('MAX AI REQUESTS / LEAD erreicht');
    if (this.dailyCents + estCents > this.limits.maxDailyCents) throw new BudgetExceeded('MAX DAILY AI BUDGET erreicht');
    if (this.monthlyCents + estCents > this.limits.maxMonthlyCents) throw new BudgetExceeded('MAX MONTHLY AI BUDGET erreicht');
    this.aiPerLead.set(leadId, n + 1); this.dailyCents += estCents; this.monthlyCents += estCents;
  }
}
