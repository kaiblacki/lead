import type { Concept, StructuredAnalysis, Point } from './structured.ts';

/** Aussagen, die nicht belegbar sind: Zahlen/Prozente/Preise, Umsatz- und Kundenverlust-Behauptungen, Versprechen. */
export const FORBIDDEN = /garantier|umsatz|verlier|abwander|entgehen|mehr\s+kunden|platz\s*1|erste[rn]?\s+platz|%|€|\bEuro\b|kostenlos|gratis|sicher(?:lich)?\s+mehr/i;
const NO_FAKE_PROOF = /sterne|\b\d[.,]\d\s*\/\s*5\b|kundenstimme|bewertungen?\s+von\b|zertifiziert|ausgezeichnet|preis(?:e)?\s+ab\b|\bab\s+\d+/i;
const str = (v: unknown, max = 400): string | null => (typeof v === 'string' && v.trim().length >= 3 && v.length <= max && !FORBIDDEN.test(v) ? v.trim() : null);
const strs = (v: unknown, max = 8): string[] => (Array.isArray(v) ? v.map((x) => str(x)).filter((x): x is string => !!x).slice(0, max) : []);

export function parseJson(text: string): any | null { try { return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { return null; } }

/** DEEP-Antwort prüfen: nur Strings in sinnvoller Länge, keine verbotenen Aussagen; Schwächen/Gründe nur mit einem Code aus den echten Befunden. Rückgabe: übernehmbare Felder oder null. */
export function validateDeep(j: any, allowedCodes: string[]): { fields: Partial<StructuredAnalysis>; dropped: number } | null {
  if (!j || typeof j !== 'object') return null;
  let dropped = 0;
  const pts = (v: unknown): Point[] => (Array.isArray(v) ? v.map((x: any): Point | null => { const t = str(x?.text); const c = typeof x?.code === 'string' ? x.code : undefined; if (!t || (c && !allowedCodes.includes(c))) { dropped++; return null; } return { code: c, text: t, evidence: str(x?.evidence, 300) ?? undefined }; }).filter((x): x is Point => !!x).slice(0, 8) : []);
  const f: Partial<StructuredAnalysis> = {};
  const summary = str(j.analysis_summary, 900); if (summary) f.analysis_summary = summary; else if (j.analysis_summary) dropped++;
  const sales = pts(j.sales_reasons); if (sales.length) f.sales_reasons = sales;
  const imp = strs(j.recommended_improvements); if (imp.length) f.recommended_improvements = imp;
  const feat = strs(j.recommended_demo_features); if (feat.length) f.recommended_demo_features = feat;
  const angle = str(j.recommended_contact_angle, 500); if (angle) f.recommended_contact_angle = angle;
  const tel = strs(j.telephone_talking_points, 8); if (tel.length) f.telephone_talking_points = tel;
  const mail = strs(j.email_talking_points, 6); if (mail.length) f.email_talking_points = mail;
  const man = strs(j.manual_checks, 10); if (man.length) f.manual_checks = man;
  return Object.keys(f).length ? { fields: f, dropped } : null;
}

/** PREMIUM-Konzept prüfen: keine erfundenen Bewertungen/Referenzen/Preise, Texte müssen als „Beispiel“ beginnen. */
export function validateConcept(j: any): Concept | null {
  const c = j?.concept ?? j; if (!c || typeof c !== 'object') return null;
  const clean = (v: unknown) => str(v, 300) && !NO_FAKE_PROOF.test(String(v)) ? String(v).trim() : null;
  const structure = (Array.isArray(c.site_structure) ? c.site_structure : []).map((p: any) => ({ page: clean(p?.page), sections: (Array.isArray(p?.sections) ? p.sections : []).map(clean).filter((x: string | null): x is string => !!x).slice(0, 10) })).filter((p: any) => p.page && p.sections.length).slice(0, 8) as Concept['site_structure'];
  const copy = (Array.isArray(c.copy_samples) ? c.copy_samples : []).map((x: any) => { const t = clean(x?.text); const s = clean(x?.section); return t && s ? { section: s, text: /^beispiel/i.test(t) ? t : `Beispiel: ${t}` } : null; }).filter((x: any) => !!x).slice(0, 8) as Concept['copy_samples'];
  const conv = (Array.isArray(c.conversion_concept) ? c.conversion_concept : []).map(clean).filter((x: string | null): x is string => !!x).slice(0, 8);
  const demo = (Array.isArray(c.demo_preparation) ? c.demo_preparation : []).map(clean).filter((x: string | null): x is string => !!x).slice(0, 8);
  if (!structure.length || !conv.length) return null;
  return { site_structure: structure, conversion_concept: conv, copy_samples: copy, tone: clean(c.tone) ?? 'freundlich, klar', individual_outreach: clean(c.individual_outreach) ?? '', demo_preparation: demo };
}

export const DEEP_SYSTEM = 'Du bist Analyst für eine Website-Agentur. Du formulierst NUR auf Basis der übergebenen, geprüften Befunde (FACTS_JSON). Erfinde nichts: keine Zahlen, Prozente, Preise, Umsatz- oder Kundenverlust-Behauptungen, keine Versprechen. Wenn etwas nicht festgestellt wurde, schreibe „Nicht festgestellt – manuell prüfen“. Ton: sachlich, freundlich, nicht aggressiv. Antworte ausschließlich als JSON.';
export const deepPrompt = (facts: unknown) => ['Verfeinere die Analyse. Gib JSON mit den Feldern analysis_summary, sales_reasons[{code,text,evidence}], recommended_improvements[], recommended_demo_features[], recommended_contact_angle, telephone_talking_points[], email_talking_points[], manual_checks[] zurück. Jeder Eintrag in sales_reasons muss einen code aus den Befunden nennen.', 'FACTS_JSON:', JSON.stringify(facts)].join('\n');
export const premiumPrompt = (facts: unknown) => ['Entwirf ein individuelles Website-Konzept. Gib JSON {"concept": {site_structure:[{page,sections[]}], conversion_concept[], copy_samples:[{section,text}], tone, individual_outreach, demo_preparation[]}} zurück. Texte sind Beispiele und beginnen mit „Beispiel:“. Keine Bewertungen, Referenzen, Preise oder Zahlen erfinden.', 'FACTS_JSON:', JSON.stringify(facts)].join('\n');
