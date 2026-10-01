export type Priority = 'A' | 'B' | 'C' | 'D';
export const PRIORITIES: Priority[] = ['A', 'B', 'C', 'D'];

export type PriorityInput = {
  websiteState: string | null;                 // none | needs_improvement | fine | unknown | exists
  auditStatus: string | null;                  // NO_WEBSITE | UNREACHABLE | ANALYZED
  websiteScore: number | null;                 // 0–100 (100 = sehr gut); null ohne Website
  salesOpportunity: number | null;
  hasPhone: boolean; hasEmail: boolean; closed: boolean; active: boolean; localIndustry: boolean;
  clearWeaknesses: number; hasDemo: boolean; dataQuality: number | null; blocked: boolean;
};
export type PriorityCfg = { base: number; A: number; B: number; C: number; factors: Record<string, number>; badWebsiteBelow: number; veryBadWebsiteBelow: number; goodWebsiteAbove: number; highOpportunityAt: number; mediumOpportunityAt: number; lowOpportunityBelow: number; uncertainBelow: number };
export type PriorityResult = { priority: Priority; score: number; reason: string; plus: string[]; minus: string[] };

/** Einfache, nachvollziehbare Einstufung aus bestehenden Fakten. Jeder Faktor steht in config/pipeline.json; die Begründung nennt, was den Ausschlag gab. */
export function computePriority(i: PriorityInput, c: PriorityCfg): PriorityResult {
  const F = c.factors; let score = c.base; const plus: string[] = [], minus: string[] = [];
  const up = (n: number, why: string) => { score += n; plus.push(why); }, down = (n: number, why: string) => { score += n; minus.push(why); };
  const so = i.salesOpportunity;
  if (i.closed) down(F.closed, 'Betrieb geschlossen');
  if (i.blocked) down(F.closed, 'Kontakt gesperrt');
  if (i.websiteState === 'none') up(F.noWebsite, 'keine Website');
  else if (i.auditStatus === 'UNREACHABLE' || i.websiteState === 'unknown') down(F.unreachable, 'Website nicht erreichbar/prüfbar');
  else if (i.websiteScore !== null) {
    if (i.websiteScore < c.veryBadWebsiteBelow) up(F.veryBadWebsite, `sehr schlechte Website (${i.websiteScore}/100)`);
    else if (i.websiteScore < c.badWebsiteBelow) up(F.badWebsite, `schwache Website (${i.websiteScore}/100)`);
    else if (i.websiteScore >= c.goodWebsiteAbove) down(F.goodWebsite, `sehr gute Website (${i.websiteScore}/100)`);
  }
  if (so !== null) {
    if (so >= c.highOpportunityAt) up(F.highOpportunity, `hohe Verkaufschance ${so}/100`);
    else if (so >= c.mediumOpportunityAt) up(F.mediumOpportunity, `Verkaufschance ${so}/100`);
    else if (so < c.lowOpportunityBelow) down(F.lowOpportunity, `sehr geringe Verkaufschance ${so}/100`);
  }
  if (i.hasPhone) up(F.phone, 'Telefonnummer vorhanden');
  if (i.hasEmail) up(F.email, 'geschäftliche E-Mail vorhanden');
  if (!i.hasPhone && !i.hasEmail) down(F.noContact, 'keine brauchbaren Kontaktdaten');
  if (i.active) up(F.active, 'Unternehmen aktiv');
  if (i.localIndustry) up(F.localIndustry, 'geeignete lokale Branche');
  if (i.clearWeaknesses >= 3 && i.websiteState !== 'none') up(F.clearWeaknesses, `${i.clearWeaknesses} klare digitale Schwächen`);
  if (i.hasDemo) up(F.demo, 'Demo vorhanden');
  if (i.dataQuality !== null && i.dataQuality < c.uncertainBelow) down(F.uncertainData, 'Daten unsicher');
  score = Math.max(0, Math.min(100, Math.round(score)));
  const priority: Priority = i.closed || i.blocked ? 'D' : score >= c.A ? 'A' : score >= c.B ? 'B' : score >= c.C ? 'C' : 'D';
  const first = (a: string[]) => a.slice(0, 4).join(', ');
  const reason = `${priority} – ${plus.length ? first(plus) : 'keine positiven Faktoren'}${minus.length ? `; dagegen: ${first(minus)}` : ''}.`.replace(/^(.)(.*)$/, (_, a, b) => a + b);
  return { priority, score, reason, plus, minus };
}
