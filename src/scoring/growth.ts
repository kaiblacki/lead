/** Scoring-Dimensionen und Handlungspriorität (rein regelbasiert, ohne KI). Jede Zahl 0–100, jede Zeile mit Begründung. */
export type GrowthWeights = {
  weights: Record<'salesOpportunity' | 'digitalNeed' | 'contactability' | 'dataConfidence' | 'partnerPotential' | 'engagement', number>;
  bonus: Record<'dueTask' | 'callbackDue' | 'demoReady' | 'offerOpen' | 'hotInterest', number>;
  penalty: Record<'dataNeeded' | 'noContact' | 'closed', number>;
  bands: { high: number; medium: number };
};

export type GrowthInput = {
  status: string; work_status: string | null; contactability: string | null; website_state: string | null;
  website_quality: number | null;              // 0–100, höher = besser
  sales_opportunity: number | null; digital_need: number | null; data_quality: number | null;
  official_website_verified: boolean | null; has_phone: boolean; has_email: boolean;
  website_potential: string | null; partnership_potential: string | null; needs_analysis_potential: string | null;
  partner_status: string | null; call_count: number; interest: boolean; demo_stage: string | null;
  offer_open: boolean; callback_due: boolean; due_tasks: number; paused: boolean;
};

export type GrowthScores = {
  digitalNeed: number; websiteQuality: number | null; contactability: number; dataConfidence: number; salesOpportunity: number;
  partnerPotential: number; engagement: number; actionPriority: number; band: 'HOCH' | 'MITTEL' | 'NIEDRIG'; reasons: string[];
};

const POT: Record<string, number> = { HIGH: 90, MEDIUM: 55, LOW: 20 };
const CONTACT: Record<string, number> = { READY: 100, PHONE_ONLY: 85, EMAIL_ONLY: 60, WEB_FORM_ONLY: 40, SOCIAL_ONLY: 30, NO_CONTACT: 0 };
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const CLOSED = new Set(['IGNORED', 'LOST', 'CUSTOMER', 'DELIVERED', 'MAINTENANCE_ACTIVE']);

export function computeGrowthScores(i: GrowthInput, cfg: GrowthWeights): GrowthScores {
  const reasons: string[] = [];
  const digitalNeed = clamp(i.digital_need ?? (i.website_state === 'none' ? 90 : i.website_quality === null ? 50 : 100 - i.website_quality));
  const websiteQuality = i.website_state === 'none' ? 0 : i.website_quality === null ? null : clamp(i.website_quality);
  const contactability = clamp(CONTACT[i.contactability ?? ''] ?? (i.has_phone ? 85 : i.has_email ? 60 : 0));
  const dataConfidence = clamp((i.data_quality ?? 50) * 0.7 + (i.official_website_verified ? 20 : 0) + (i.has_phone ? 5 : 0) + (i.has_email ? 5 : 0));
  const salesOpportunity = clamp(i.sales_opportunity ?? digitalNeed * 0.6 + contactability * 0.4);
  const partnerPotential = clamp(i.partner_status && ['ACTIVE_PARTNER', 'PARTNER_APPROVED'].includes(i.partner_status) ? 100 : POT[i.partnership_potential ?? ''] ?? 25);
  let engagement = 0;
  if (i.call_count > 0) engagement += 25;
  if (i.interest) engagement += 40;
  if (['DEMO_SHOWN', 'DEMO_SENT'].includes(i.demo_stage ?? '')) engagement += 20;
  if (i.offer_open) engagement += 25;
  engagement = clamp(engagement);

  const w = cfg.weights;
  let p = salesOpportunity * w.salesOpportunity + digitalNeed * w.digitalNeed + contactability * w.contactability + dataConfidence * w.dataConfidence + partnerPotential * w.partnerPotential + engagement * w.engagement;
  reasons.push(`Basis aus Verkaufschance ${salesOpportunity}, Digitalbedarf ${digitalNeed}, Kontaktierbarkeit ${contactability}, Datensicherheit ${dataConfidence}, Partnerpotenzial ${partnerPotential}, Engagement ${engagement}`);
  if (i.due_tasks > 0) { p += cfg.bonus.dueTask; reasons.push(`+${cfg.bonus.dueTask} fällige Aufgabe`); }
  if (i.callback_due) { p += cfg.bonus.callbackDue; reasons.push(`+${cfg.bonus.callbackDue} Rückruf fällig`); }
  if (i.demo_stage === 'DEMO_READY') { p += cfg.bonus.demoReady; reasons.push(`+${cfg.bonus.demoReady} Demo fertig – anrufen`); }
  if (i.offer_open) { p += cfg.bonus.offerOpen; reasons.push(`+${cfg.bonus.offerOpen} Angebot offen`); }
  if (i.interest) { p += cfg.bonus.hotInterest; reasons.push(`+${cfg.bonus.hotInterest} Interesse geäußert`); }
  if (i.work_status === 'DATA_NEEDED') { p -= cfg.penalty.dataNeeded; reasons.push(`−${cfg.penalty.dataNeeded} Daten fehlen (erst beschaffen)`); }
  if (contactability === 0) { p -= cfg.penalty.noContact; reasons.push(`−${cfg.penalty.noContact} keine Kontaktmöglichkeit`); }
  if (CLOSED.has(i.status) || i.paused) { p -= cfg.penalty.closed; reasons.push('abgeschlossen oder pausiert – keine Handlung nötig'); }
  const actionPriority = clamp(p);
  const band = actionPriority >= cfg.bands.high ? 'HOCH' : actionPriority >= cfg.bands.medium ? 'MITTEL' : 'NIEDRIG';
  return { digitalNeed, websiteQuality, contactability, dataConfidence, salesOpportunity, partnerPotential, engagement, actionPriority, band, reasons };
}
