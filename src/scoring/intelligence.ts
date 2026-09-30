import type { AuditReport, AuditCheck } from '../audit/types.ts';
import type { SocialResult } from '../providers/types.ts';
import { bestFact, factValue, findConflicts, type Fact } from '../core/profile.ts';
import { normPhone } from '../core/text.ts';
import { createHash } from 'node:crypto';

/** Kurzer Fingerabdruck der Scoring-Konfiguration (für den Learning Loop: mit welchen Gewichten wurde bewertet?). */
export const hashConfig = (cfg: unknown) => createHash('sha1').update(JSON.stringify(cfg)).digest('hex').slice(0, 8);

export type DimKey = 'websiteNeed' | 'mobileNeed' | 'designNeed' | 'conversionNeed' | 'technicalNeed' | 'contentNeed' | 'socialOpportunity' | 'businessPotential' | 'contactability' | 'upsellPotential' | 'dataQuality';
export const DIM_LABELS: Record<DimKey, string> = {
  websiteNeed: 'Website Need', mobileNeed: 'Mobile Need', designNeed: 'Design Need', conversionNeed: 'Conversion Need', technicalNeed: 'Technical Need', contentNeed: 'Content Need',
  socialOpportunity: 'Social Opportunity', businessPotential: 'Business Potential', contactability: 'Contactability', upsellPotential: 'Upsell Potential', dataQuality: 'Data Quality',
};
export const DIM_ORDER = Object.keys(DIM_LABELS) as DimKey[];
/** measured = gemessen, implied = abgeleitet (z. B. „keine Website → keine mobile Darstellung“), unreliable = vorhanden, aber nicht belastbar, unavailable = nicht verfügbar */
export type DimState = 'measured' | 'implied' | 'unavailable' | 'unreliable';
export type Reason = { text: string; points?: number };
export type Dimension = { key: DimKey; label: string; value: number | null; state: DimState; reasons: Reason[] };
export type Category = 'HOT' | 'HIGH POTENTIAL' | 'MEDIUM' | 'LOW' | 'IGNORE' | 'UNRATED';
export type WebsiteState = 'none' | 'exists' | 'needs_improvement' | 'fine' | 'unknown';

export type ScoringConfig = {
  version: number;
  digitalNeedWeights: Record<string, number>; salesWeights: Record<string, number>;
  dataQuality: { minFactor: number; weights: Record<string, number>; qualityValue: Record<string, number>; conflictPenalty: number };
  thresholds: { HOT: number; HIGH_POTENTIAL: number; MEDIUM: number; LOW: number };
  websiteNeedsImprovementAt: number; mobileProblemAt: number; socialActiveDays: number; socialRecentDays: number; unreliableBelowWeight: number;
  employeeBucketValue: Record<string, number>; chainPenalty: number;
};
export type Upsell = { key: string; label: string; oneTimeCents: number; monthlyCents: number; weight: number; when: string };

export type Contribution = { key: string; label: string; value: number; weight: number; points: number; state: DimState };
export type Analysis = {
  dimensions: Record<DimKey, Dimension>;
  digitalNeed: { value: number | null; state: 'ok' | 'unreliable' | 'unavailable'; coverage: number; contributions: Contribution[]; note: string };
  salesOpportunity: { value: number | null; category: Category; contributions: Contribution[]; dataQualityFactor: number; note: string };
  websiteState: WebsiteState;
  why: Reason[];                 // „Warum ist dieser Lead interessant?“
  missing: string[];             // „Nicht verfügbar“ / „nicht zuverlässig ermittelbar“
  upsells: (Upsell & { reason: string })[];
  configVersion: number;
};

export function categorize(score: number, t: ScoringConfig['thresholds']): Exclude<Category, 'UNRATED'> {
  if (score >= t.HOT) return 'HOT';
  if (score >= t.HIGH_POTENTIAL) return 'HIGH POTENTIAL';
  if (score >= t.MEDIUM) return 'MEDIUM';
  if (score >= t.LOW) return 'LOW';
  return 'IGNORE';
}

export type AnalysisInput = {
  facts: Fact[]; audit: AuditReport; social: SocialResult | null; bookingRelevant?: boolean; upsells: Upsell[]; now: Date;
  /** Quellen, die nach einer Website befragt wurden (für die Beleg-Zeile „keine Website hinterlegt“). */
  websiteSources?: string[];
};

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const DAY = 86400000;
const icon = (c: AuditCheck) => (c.status === 'fail' ? '❌' : c.status === 'warn' ? '⚠️' : '✅');
const topProblems = (audit: AuditReport, cats: string[], n = 3) => audit.checks.filter((c) => cats.includes(c.category) && (c.status === 'fail' || c.status === 'warn')).sort((a, b) => (a.status === b.status ? 0 : a.status === 'fail' ? -1 : 1)).slice(0, n);

export function analyzeLead(input: AnalysisInput, cfg: ScoringConfig): Analysis {
  const { facts, audit, social, now } = input;
  const dims = {} as Record<DimKey, Dimension>;
  const set = (key: DimKey, value: number | null, state: DimState, reasons: Reason[]) => { dims[key] = { key, label: DIM_LABELS[key], value: value === null ? null : clamp(value), state, reasons }; };
  const noSite = audit.status === 'NO_WEBSITE', unreachable = audit.status === 'UNREACHABLE';
  const socialFacts = facts.filter((f) => f.key === 'social');
  const hasSocialOnlyWebsite = noSite && socialFacts.some((f) => f.note?.includes('nur ein Social-Media-Profil'));
  const sources = input.websiteSources?.length ? input.websiteSources.join(', ') : 'Datenquellen';

  // ---------- Bedarf (Need) ----------
  const siteBased = (key: DimKey, cats: Record<string, number>, impliedText: string, noSiteState: 'implied' | 'unavailable', unavailText: string) => {
    if (noSite) return noSiteState === 'implied' ? set(key, 100, 'implied', [{ text: impliedText }]) : set(key, null, 'unavailable', [{ text: unavailText }]);
    if (unreachable) return set(key, null, 'unavailable', [{ text: 'Website nicht erreichbar – nicht zuverlässig ermittelbar.' }]);
    let w = 0, acc = 0;
    for (const [c, weight] of Object.entries(cats)) { const q = audit.quality[c as keyof AuditReport['quality']]; if (q !== null && q !== undefined) { w += weight; acc += weight * q; } }
    if (!w) return set(key, null, 'unavailable', [{ text: 'Keine belastbaren Prüfpunkte – nicht zuverlässig ermittelbar.' }]);
    const probs = topProblems(audit, Object.keys(cats), 3);
    const reasons: Reason[] = probs.map((p) => ({ text: `${icon(p)} ${p.summary}` }));
    if (!probs.length) reasons.push({ text: '✅ Keine Auffälligkeiten bei den geprüften Punkten.' });
    if (key === 'mobileNeed' && !audit.renderSource) reasons.push({ text: 'Ohne Browsertest nur aus dem HTML geschätzt.' });
    if (key === 'mobileNeed' && audit.renderSource?.estimated) reasons.push({ text: 'Werte aus dem HTML geschätzt (kein echter Browsertest).' });
    set(key, 100 - acc / w, 'measured', reasons);
  };
  if (noSite) set('websiteNeed', 100, 'measured', [{ text: `In den Datenquellen (${sources}) ist keine eigene Website hinterlegt.` }, ...(hasSocialOnlyWebsite ? [{ text: 'Im Website-Feld steht nur ein Social-Media-Profil.' }] : []), { text: 'Nicht ausgeschlossen, dass eine Website existiert, die in den Quellen fehlt.' }]);
  else if (unreachable) set('websiteNeed', null, 'unreliable', [{ text: `Website bei der Prüfung nicht erreichbar (${audit.checks[0]?.evidence ?? 'unbekannt'}).` }, { text: 'Nicht zuverlässig beurteilbar – Prüfung später wiederholen.' }]);
  else if (audit.overallQuality === null) set('websiteNeed', null, 'unavailable', [{ text: 'Keine belastbaren Prüfpunkte.' }]);
  else {
    const probs = audit.checks.filter((c) => c.status === 'fail' || c.status === 'warn').sort((a, b) => (a.status === b.status ? 0 : a.status === 'fail' ? -1 : 1)).slice(0, 3);
    // Mischung aus Durchschnitt und schwächster Kategorie: ein gravierender Mangel (z. B. nicht mobil) darf nicht im Durchschnitt untergehen.
    const worst = Math.max(...(['technical', 'mobile', 'design', 'content', 'conversion'] as const).map((c) => (audit.quality[c] === null ? 0 : 100 - audit.quality[c]!)));
    let v = 0.5 * (100 - audit.overallQuality) + 0.5 * worst;
    const reasons: Reason[] = [...probs.map((p) => ({ text: `${icon(p)} ${p.summary}` })), ...(probs.length ? [] : [{ text: '✅ Website ohne nennenswerte Auffälligkeiten.' }])];
    const severe = audit.checks.filter((c) => c.status === 'fail' && c.severity === 'high');
    if (severe.length && v < 45) { v = 45; reasons.push({ text: `Schwerwiegende Mängel (${severe.map((c) => c.code).join(', ')}) – Website Need mindestens 45.` }); }
    set('websiteNeed', v, 'measured', reasons);
  }
  siteBased('mobileNeed', { mobile: 1 }, 'Ohne Website gibt es keine mobile Darstellung.', 'implied', '');
  siteBased('designNeed', { design: 1 }, '', 'unavailable', 'Keine Website – Design nicht bewertbar.');
  siteBased('conversionNeed', { conversion: 1 }, 'Ohne Website gibt es keinen Online-Kontaktweg und keine Handlungsaufforderung.', 'implied', '');
  siteBased('technicalNeed', { technical: 0.7, seo: 0.3 }, '', 'unavailable', 'Keine Website – Technik nicht bewertbar.');
  siteBased('contentNeed', { content: 0.8, trust: 0.2 }, 'Ohne Website sind Leistungen, Öffnungszeiten und Kontakt online nicht auffindbar.', 'implied', '');

  // ---------- Social Opportunity ----------
  const profiles = socialFacts.map((f) => f.value as { platform: string; url: string; lastPostAt?: string });
  const lastPost = profiles.map((p) => (p.lastPostAt ? Date.parse(p.lastPostAt) : NaN)).filter((t) => !Number.isNaN(t)).sort((a, b) => b - a)[0];
  const daysSince = lastPost === undefined ? null : Math.round((now.getTime() - lastPost) / DAY);
  let socialKind: 'unknown' | 'none' | 'active' | 'sporadic' | 'inactive' | 'nodata' = 'unknown';
  if (!social) set('socialOpportunity', null, 'unavailable', [{ text: 'Social-Media-Daten nicht verfügbar (keine Abfrage durchgeführt).' }]);
  else if (!profiles.length) {
    if (social.complete) { socialKind = 'none'; set('socialOpportunity', 55, 'measured', [{ text: `Kein Social-Media-Profil gefunden (Quelle: ${social.source}).` }]); }
    else set('socialOpportunity', null, 'unreliable', [{ text: 'Kein Profil gefunden, die Quelle konnte das aber nicht zuverlässig prüfen – nicht zuverlässig ermittelbar.' }]);
  } else if (daysSince === null) { socialKind = 'nodata'; set('socialOpportunity', 55, 'unreliable', [{ text: `${profiles.length} Profil(e) bekannt (${[...new Set(profiles.map((p) => p.platform))].join(', ')}), Aktivität nicht ermittelbar.` }]); }
  else if (daysSince <= cfg.socialRecentDays) { socialKind = 'active'; set('socialOpportunity', 40, 'measured', [{ text: `Aktives Profil (letzter Beitrag vor ${daysSince} Tagen) – Bedarf teilweise gedeckt, Potenzial bei Reichweite und Website-Verknüpfung.` }]); }
  else if (daysSince <= cfg.socialActiveDays) { socialKind = 'sporadic'; set('socialOpportunity', 65, 'measured', [{ text: `Profil wird unregelmäßig gepflegt (letzter Beitrag vor ${daysSince} Tagen).` }]); }
  else { socialKind = 'inactive'; set('socialOpportunity', 80, 'measured', [{ text: `Profil vorhanden, aber seit ${daysSince} Tagen ohne Beitrag – Potenzial für einen Content-Service.` }]); }
  if (dims.socialOpportunity.value !== null && !noSite && !unreachable && profiles.length) {
    const linked = audit.checks.find((c) => c.code === 'SOCIAL_LINKS');
    if (linked?.status === 'warn') { dims.socialOpportunity.value = clamp(dims.socialOpportunity.value + 5); dims.socialOpportunity.reasons.push({ text: 'Die Website verlinkt die vorhandenen Profile nicht.', points: 5 }); }
  }

  // ---------- Business Potential ----------
  {
    const parts: { w: number; v: number; text: string }[] = [];
    const emp = factValue<string>(facts, 'employeeBucket');
    const revs = factValue<number>(facts, 'reviewCount'), rating = factValue<number>(facts, 'rating');
    const locs = factValue<number>(facts, 'locationsCount'), founded = factValue<number>(facts, 'foundedYear');
    const chain = factValue<boolean>(facts, 'isChain');
    if (emp && cfg.employeeBucketValue[emp] !== undefined) parts.push({ w: 0.35, v: cfg.employeeBucketValue[emp], text: `Mitarbeitergröße ${emp}` });
    if (revs !== undefined) parts.push({ w: 0.25, v: revs >= 300 ? 95 : revs >= 100 ? 85 : revs >= 30 ? 65 : revs >= 10 ? 45 : 20, text: `${revs} Bewertungen (Aktivität/Bekanntheit)` });
    if (rating !== undefined) parts.push({ w: 0.15, v: rating >= 4.5 ? 85 : rating >= 4 ? 60 : rating >= 3.5 ? 40 : 30, text: `Bewertung Ø ${String(rating).replace('.', ',')}` });
    if (locs !== undefined) parts.push({ w: 0.1, v: locs >= 4 ? 40 : locs >= 2 ? 75 : 50, text: `${locs} Standort${locs > 1 ? 'e' : ''}` });
    if (founded !== undefined) { const age = now.getFullYear() - founded; parts.push({ w: 0.15, v: age >= 5 ? 75 : age >= 2 ? 55 : 40, text: `Gegründet ${founded} (${age} Jahre am Markt)` }); }
    const closed = factValue<string>(facts, 'businessStatus');
    if (closed && closed !== 'OPERATIONAL') set('businessPotential', 0, 'measured', [{ text: `Betriebsstatus laut Quelle: ${closed === 'CLOSED_PERMANENTLY' ? 'dauerhaft geschlossen' : 'vorübergehend geschlossen'}.` }]);
    else if (!parts.length) set('businessPotential', null, 'unavailable', [{ text: 'Keine Angaben zu Größe, Bewertungen oder Alter – nicht verfügbar.' }]);
    else {
      const w = parts.reduce((s, p) => s + p.w, 0);
      let v = parts.reduce((s, p) => s + p.w * p.v, 0) / w;
      const reasons: Reason[] = parts.map((p) => ({ text: p.text }));
      if (chain) { v -= cfg.chainPenalty; reasons.push({ text: 'Filialbetrieb/Kette – Entscheidungen oft zentral.', points: -cfg.chainPenalty }); }
      if (!emp) reasons.push({ text: 'Mitarbeitergröße: nicht verfügbar.' });
      set('businessPotential', v, w < 0.4 ? 'unreliable' : 'measured', reasons);
    }
  }

  // ---------- Contactability ----------
  {
    const reasons: Reason[] = [];
    let v = 0;
    const phone = bestFact(facts, 'phone');
    const digits = phone ? normPhone(String(phone.value)) : '';
    if (phone && digits.length >= 6) { const pts = phone.quality === 'low' ? 45 : 60; v += pts; reasons.push({ text: `Telefonnummer vorhanden (${phone.source}, Qualität ${phone.quality}).`, points: pts }); } else reasons.push({ text: 'Keine Telefonnummer verfügbar.' });
    if (bestFact(facts, 'email')) { v += 15; reasons.push({ text: 'E-Mail-Adresse bekannt.', points: 15 }); } else reasons.push({ text: 'E-Mail-Adresse: nicht verfügbar.' });
    const contactCheck = audit.checks.find((c) => c.code === 'CONTACT_OPTION' && c.status === 'pass');
    if (contactCheck) { v += 5; reasons.push({ text: 'Website bietet selbst einen Kontaktweg.', points: 5 }); }
    if (audit.checks.some((c) => c.code === 'WHATSAPP' && c.status === 'pass')) { v += 5; reasons.push({ text: 'WhatsApp-Kontakt auf der Website.', points: 5 }); }
    if (bestFact(facts, 'openingHours')) { v += 5; reasons.push({ text: 'Öffnungszeiten bekannt (passender Anrufzeitpunkt).', points: 5 }); }
    if (findConflicts(facts).some((c) => c.key === 'phone')) { v -= 10; reasons.push({ text: 'Rufnummern aus verschiedenen Quellen widersprechen sich.', points: -10 }); }
    set('contactability', v, 'measured', reasons);
  }

  // ---------- Upsell Potential ----------
  const matched: (Upsell & { reason: string })[] = [];
  {
    const sub = input.bookingRelevant !== false;
    const cond: Record<string, () => string | null> = {
      no_booking: () => (!sub ? null : noSite ? 'Ohne Website keine eigene Online-Terminbuchung.' : audit.checks.find((c) => c.code === 'ONLINE_BOOKING' && c.status === 'fail') ? 'Keine Online-Terminbuchung erkennbar.' : null),
      social_inactive_or_none: () => (socialKind === 'none' ? 'Kein Social-Media-Profil gefunden.' : socialKind === 'inactive' || socialKind === 'sporadic' ? `Profil wenig aktiv (${daysSince} Tage seit dem letzten Beitrag).` : null),
      seo_weak: () => (!noSite && !unreachable && audit.quality.seo !== null && audit.quality.seo < 75 ? 'Grundlegende SEO-Angaben fehlen oder sind schwach.' : null),
      stale_content: () => (audit.checks.find((c) => c.code === 'FRESHNESS' && (c.status === 'fail' || c.status === 'warn')) ? 'Inhalte wirken nicht aktuell.' : null),
      multi_location: () => ((factValue<number>(facts, 'locationsCount') ?? 1) >= 2 ? 'Mehrere Standorte bekannt.' : null),
    };
    for (const u of input.upsells) { const r = cond[u.when]?.(); if (r) matched.push({ ...u, reason: r }); }
    const known = !unreachable || !!social;
    if (!known) set('upsellPotential', null, 'unavailable', [{ text: 'Weder Website noch Social-Daten verfügbar.' }]);
    else set('upsellPotential', Math.min(100, matched.reduce((s, u) => s + u.weight, 0)), 'measured', matched.length ? matched.map((u) => ({ text: `${u.label}: ${u.reason}`, points: u.weight })) : [{ text: 'Keine zusätzlichen Leistungen aus den Daten ableitbar.' }]);
  }

  // ---------- Data Quality ----------
  {
    const dq = cfg.dataQuality;
    const checks: [string, boolean, Fact | undefined][] = [
      ['phone', true, bestFact(facts, 'phone')], ['address', true, bestFact(facts, 'address')],
      ['website', true, noSite ? (bestFact(facts, 'social') ?? undefined) : bestFact(facts, 'website')], ['email', true, bestFact(facts, 'email')],
      ['employeeBucket', true, bestFact(facts, 'employeeBucket')], ['openingHours', true, bestFact(facts, 'openingHours')],
      ['social', true, social?.complete ? (bestFact(facts, 'social') ?? ({ quality: 'medium' } as Fact)) : bestFact(facts, 'social')], ['rating', true, bestFact(facts, 'rating')],
    ];
    let v = 0; const reasons: Reason[] = [];
    for (const [k, , f] of checks) {
      const w = dq.weights[k] ?? 0;
      // "Keine Website" ist bei ≥1 befragter Quelle eine bekannte Information (nicht fehlend).
      const q = f ? dq.qualityValue[f.quality] ?? 0 : (k === 'website' && noSite ? dq.qualityValue.medium : 0);
      v += w * q * 100;
      if (!f && !(k === 'website' && noSite)) reasons.push({ text: `${FACT_TXT[k]}: nicht verfügbar.` });
      else if (f && f.quality === 'low') reasons.push({ text: `${FACT_TXT[k]}: Datenqualität niedrig.` });
    }
    const conflicts = findConflicts(facts);
    for (const c of conflicts) { v -= dq.conflictPenalty; reasons.push({ text: `Widerspruch zwischen Quellen bei ${FACT_TXT[c.key] ?? c.key}.`, points: -dq.conflictPenalty }); }
    const total = Object.values(dq.weights).reduce((a, b) => a + b, 0) || 1;
    set('dataQuality', (v / total), 'measured', reasons.length ? reasons : [{ text: 'Alle Kerndaten vorhanden.' }]);
  }

  // ---------- Digital Need ----------
  const needKeys: DimKey[] = ['websiteNeed', 'mobileNeed', 'designNeed', 'conversionNeed', 'technicalNeed', 'contentNeed'];
  const combine = (keys: { k: DimKey | 'digitalNeed'; w: number; d: { value: number | null; state: DimState } }[]) => {
    let wsum = 0, acc = 0; const contributions: Contribution[] = [];
    for (const { k, w, d } of keys) {
      if (d.value === null || d.state === 'unavailable') continue;
      const eff = d.state === 'unreliable' ? w * 0.5 : w;
      wsum += eff; acc += eff * d.value;
      contributions.push({ key: k, label: k === 'digitalNeed' ? 'Digital Need' : DIM_LABELS[k], value: d.value, weight: eff, points: 0, state: d.state });
    }
    for (const c of contributions) c.points = wsum ? Math.round((c.weight / wsum) * c.value * 10) / 10 : 0;
    return { wsum, value: wsum ? acc / wsum : null, contributions };
  };
  const dn = combine(needKeys.map((k) => ({ k, w: cfg.digitalNeedWeights[k] ?? 0, d: dims[k] })));
  const totalNeedW = needKeys.reduce((s, k) => s + (cfg.digitalNeedWeights[k] ?? 0), 0) || 1;
  const coverage = dn.wsum / totalNeedW;
  const dnValue = dn.value === null ? null : clamp(dn.value);
  const dnState: Analysis['digitalNeed']['state'] = dnValue === null ? 'unavailable' : coverage < cfg.unreliableBelowWeight ? 'unreliable' : 'ok';
  const digitalNeed = { value: dnValue, state: dnState, coverage: Math.round(coverage * 100) / 100, contributions: dn.contributions,
    note: dnValue === null ? 'Nicht zuverlässig ermittelbar – keine belastbaren Prüfdaten.' : dnState === 'unreliable' ? 'Nicht zuverlässig ermittelbar – nur wenige Bedarfsdimensionen konnten geprüft werden.' : noSite ? 'Kein Webauftritt: alle bewertbaren Bedarfsdimensionen sind maximal.' : 'Gewichteter Mittelwert der geprüften Bedarfsdimensionen.' };

  // ---------- Sales Opportunity ----------
  const sw = cfg.salesWeights;
  const so = combine([
    { k: 'digitalNeed', w: sw.digitalNeed, d: { value: dnValue, state: dnState === 'unavailable' ? 'unavailable' : dnState === 'unreliable' ? 'unreliable' : 'measured' } },
    { k: 'businessPotential', w: sw.businessPotential, d: dims.businessPotential }, { k: 'contactability', w: sw.contactability, d: dims.contactability },
    { k: 'upsellPotential', w: sw.upsellPotential, d: dims.upsellPotential }, { k: 'socialOpportunity', w: sw.socialOpportunity, d: dims.socialOpportunity },
  ]);
  const dqv = dims.dataQuality.value ?? 50;
  const dqFactor = Math.round((cfg.dataQuality.minFactor + (1 - cfg.dataQuality.minFactor) * (dqv / 100)) * 1000) / 1000;
  const closed = factValue<string>(facts, 'businessStatus');
  let salesValue: number | null = null, category: Category = 'UNRATED', note = '';
  if (closed === 'CLOSED_PERMANENTLY') { salesValue = 0; category = 'IGNORE'; note = 'Betrieb laut Datenquelle dauerhaft geschlossen.'; }
  else if (dnValue === null || so.value === null) { note = 'Nicht bewertbar: Für den Digital Need liegen keine belastbaren Daten vor (z. B. Website nicht erreichbar). Prüfung wiederholen.'; }
  else { salesValue = clamp(so.value * dqFactor); category = categorize(salesValue, cfg.thresholds); note = `Gewichtete Dimensionen × Datenqualitätsfaktor ${String(dqFactor).replace('.', ',')}.`; }
  for (const c of so.contributions) c.points = Math.round(c.points * dqFactor * 10) / 10;

  // ---------- Website-Status, Begründung, Lücken ----------
  const needsImprovement = dims.websiteNeed.value !== null && dims.websiteNeed.value >= cfg.websiteNeedsImprovementAt;
  const websiteState: WebsiteState = noSite ? 'none' : unreachable ? 'unknown' : dims.websiteNeed.value === null ? 'unknown' : needsImprovement ? 'needs_improvement' : 'fine';
  const why: Reason[] = [...so.contributions].sort((a, b) => b.points - a.points).slice(0, 5).filter((c) => c.points > 0).map((c) => {
    const d = c.key === 'digitalNeed' ? null : dims[c.key as DimKey];
    const first = c.key === 'digitalNeed' ? dims.websiteNeed.reasons[0]?.text ?? digitalNeed.note : d?.reasons[0]?.text ?? '';
    return { text: `${c.label} ${Math.round(c.value)}/100: ${first}`, points: c.points };
  });
  const missing: string[] = [];
  for (const k of DIM_ORDER) { const d = dims[k]; if (d.state === 'unavailable') missing.push(`${d.label}: nicht verfügbar – ${d.reasons[0]?.text ?? ''}`.trim()); else if (d.state === 'unreliable') missing.push(`${d.label}: nicht zuverlässig ermittelbar – ${d.reasons[0]?.text ?? ''}`.trim()); }
  for (const [k, label] of [['email', 'E-Mail'], ['employeeBucket', 'Mitarbeitergröße'], ['openingHours', 'Öffnungszeiten'], ['rating', 'Bewertungen']] as const) if (!bestFact(facts, k)) missing.push(`${label}: nicht verfügbar.`);
  if (audit.notes.length) missing.push(...audit.notes);

  return { dimensions: dims, digitalNeed, salesOpportunity: { value: salesValue, category, contributions: so.contributions, dataQualityFactor: dqFactor, note }, websiteState, why, missing: [...new Set(missing)], upsells: matched, configVersion: cfg.version };
}

const FACT_TXT: Record<string, string> = { phone: 'Telefon', address: 'Adresse', website: 'Website', email: 'E-Mail', employeeBucket: 'Mitarbeitergröße', openingHours: 'Öffnungszeiten', social: 'Social Media', rating: 'Bewertungen' };

/** Merkmale eines Leads zum Zeitpunkt der Bewertung – Grundlage für den Learning Loop (kein ML, nur saubere Daten). */
export function snapshotFeatures(facts: Fact[], audit: AuditReport, a: Analysis): Record<string, unknown> {
  const socialP = facts.filter((f) => f.key === 'social').map((f) => f.value as { platform: string });
  return {
    subIndustry: factValue(facts, 'subIndustry') ?? null, employeeBucket: factValue(facts, 'employeeBucket') ?? null, distanceKm: factValue(facts, 'distanceKm') ?? null,
    rating: factValue(facts, 'rating') ?? null, reviewCount: factValue(facts, 'reviewCount') ?? null, locationsCount: factValue(facts, 'locationsCount') ?? null,
    hasPhone: !!bestFact(facts, 'phone'), hasEmail: !!bestFact(facts, 'email'), websiteState: a.websiteState, auditStatus: audit.status,
    problemCodes: audit.checks.filter((c) => c.status === 'fail' || c.status === 'warn').map((c) => c.code), socialProfiles: socialP.length,
    dims: Object.fromEntries(DIM_ORDER.map((k) => [k, a.dimensions[k].value])),
  };
}
