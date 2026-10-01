import { createHash } from 'node:crypto';
import type { AuditCheck } from '../audit/types.ts';
import type { Fact } from '../core/profile.ts';
import type { AnalysisConfig } from '../core/config.ts';
import { enrichment } from '../core/enrichment.ts';

export type WebsiteStatus = 'NO_WEBSITE' | 'ANALYZED' | 'BLOCKED' | 'UNREACHABLE' | 'NOT_VERIFIED';
export type Point = { code?: string; text: string; evidence?: string };
export type Concept = { site_structure: { page: string; sections: string[] }[]; conversion_concept: string[]; copy_samples: { section: string; text: string }[]; tone: string; individual_outreach: string; demo_preparation: string[] };

/** Strukturiertes Analyseergebnis. website_score (Qualität der Website, 100 = sehr gut) und sales_opportunity (Verkaufschance, 100 = sehr interessant) sind getrennte Werte. */
export type StructuredAnalysis = {
  website_status: WebsiteStatus; website_score: number | null; sales_opportunity: number | null; analysis_summary: string;
  positive_points: Point[]; weaknesses: Point[]; sales_reasons: Point[]; recommended_improvements: string[]; recommended_demo_features: string[]; recommended_contact_angle: string;
  telephone_talking_points: string[]; email_talking_points: string[]; missing_information: string[]; manual_checks: string[]; evidence: { code: string; status: string; evidence: string }[];
  sources: { source: string; url?: string; fields: string[] }[]; confidence: number; concept?: Concept | null;
};

export type StructInput = {
  companyName: string; subLabel?: string; features: string[]; websiteUrl?: string | null; auditStatus: string | null; auditNotes: string[]; renderDependent: boolean;
  websiteScore: number | null; salesOpportunity: number | null; coverage: number; dataQualityFactor: number; checks: AuditCheck[]; facts: Fact[];
  reasons: { code: string; text: string; evidence: string }[]; source?: string | null; phone?: string | null; email?: string | null; address?: string | null;
};

const SEV = { high: 0, medium: 1, low: 2 } as const;
const lc = (s: string) => s.replace(/\.$/, '');

export function websiteStatusOf(auditStatus: string | null, notes: string[], renderDependent: boolean): WebsiteStatus {
  if (auditStatus === 'NO_WEBSITE' || !auditStatus) return 'NO_WEBSITE';
  if (auditStatus === 'UNREACHABLE') return notes.some((n) => /blockiert/i.test(n)) ? 'BLOCKED' : 'UNREACHABLE';
  return renderDependent ? 'NOT_VERIFIED' : 'ANALYZED';
}

/** Regelbasierte Analyse (ohne KI, ohne Kosten) – jede Aussage stammt aus einem geprüften Befund oder einer gespeicherten Quelle. Grundlage für MASS und Rückfall für DEEP/PREMIUM. */
export function buildStructured(i: StructInput, cfg: AnalysisConfig, labelsOnly = false): StructuredAnalysis {
  void labelsOnly;
  const status = websiteStatusOf(i.auditStatus, i.auditNotes, i.renderDependent);
  const noSite = status === 'NO_WEBSITE';
  const bad = i.checks.filter((c) => c.status === 'fail' || c.status === 'warn').sort((a, b) => (a.status === b.status ? SEV[a.severity] - SEV[b.severity] : a.status === 'fail' ? -1 : 1));
  const good = i.checks.filter((c) => c.status === 'pass' && c.severity !== 'low').slice(0, 6);
  const unknown = i.checks.filter((c) => c.status === 'unknown');
  const en = enrichment({ phone: i.phone, website_url: i.websiteUrl, address: i.address, email: i.email, source: i.source });
  const labels = cfg.featureLabels;
  const factSources = (keys: string[]) => i.facts.filter((f) => keys.includes(f.key));

  const weaknesses: Point[] = bad.map((c) => ({ code: c.code, text: c.summary, evidence: c.evidence }));
  const positive: Point[] = good.map((c) => ({ code: c.code, text: c.summary, evidence: c.evidence }));
  const failedFeatureCodes = new Set(bad.map((c) => c.code));
  const improvements = noSite ? [...cfg.noWebsiteImprovements, ...i.features.filter((f) => ['booking', 'reservation', 'menu', 'gallery', 'quote', 'service_area'].includes(f)).map((f) => labels[f]).filter(Boolean)]
    : [...new Set(bad.map((c) => cfg.improvements[c.code]).filter(Boolean))].slice(0, 8);
  const demoFeatures = noSite ? i.features.map((f) => labels[f]).filter(Boolean) : [...new Set([...i.features.filter((f) => [...failedFeatureCodes].some((c) => c.toLowerCase().includes(f.slice(0, 4)))).map((f) => labels[f]), ...bad.slice(0, 4).map((c) => cfg.improvements[c.code])].filter(Boolean))].slice(0, 8);

  const top = bad.slice(0, 3);
  const phoneName = i.companyName;
  const telephone: string[] = [];
  if (noSite) { telephone.push(`Ich habe online keine eigene Website von ${phoneName} gefunden${i.source === 'osm' ? ' (nur ein Eintrag in OpenStreetMap)' : ''} – deshalb habe ich Ihnen unverbindlich einen Entwurf vorbereitet.`);
    if (improvements[1]) telephone.push(`Der Entwurf zeigt: ${improvements.slice(1, 3).map(lc).join('; ')}.`); }
  else if (status === 'ANALYZED' || status === 'NOT_VERIFIED') { for (const c of top) telephone.push(`Mir ist aufgefallen: ${lc(c.summary)}.${cfg.improvements[c.code] ? ` Hilfreich wäre: ${lc(cfg.improvements[c.code])}.` : ''}`); if (telephone.length) telephone.push('Ich habe dazu unverbindlich einen Entwurf vorbereitet, den ich Ihnen gern zeige.'); else telephone.push('Die Website wirkt in den geprüften Punkten solide – nur bei konkretem Anlass ansprechen.'); }
  else telephone.push('Die Website konnte nicht abgerufen werden – bitte zuerst selbst im Browser ansehen, bevor Sie anrufen.');
  const emailPts = telephone.slice(0, 2).map((t) => t.replace(/^Ich habe online/, 'Ich habe online'));

  const manual: string[] = unknown.slice(0, 8).map((c) => `Nicht festgestellt – manuell prüfen: ${lc(c.summary)}`);
  if (status === 'BLOCKED') manual.unshift('Website vorhanden, aber der Abruf wird blockiert – im Browser manuell ansehen.');
  if (status === 'UNREACHABLE') manual.unshift('Website beim Abruf nicht erreichbar – später erneut prüfen oder manuell ansehen.');
  if (noSite) manual.unshift('Prüfen, ob doch eine eigene Website existiert (Quelleneinträge können fehlen) – z. B. kurze Suche nach dem Firmennamen.');
  for (const n of i.auditNotes) if (/Browsertest|geschätzt/i.test(n)) manual.push(lc(n));

  const missing = [...en.missing, ...en.optional.map((x) => `${x} (nicht öffentlich ermittelt)`)];
  if (!i.facts.some((f) => f.key === ('contactPerson' as never))) missing.push('Ansprechpartner (nicht öffentlich ermittelt)');

  const summary = noSite
    ? `Für ${i.companyName} wurde keine eigene Website gefunden${i.source ? ` (Quelle: ${i.source === 'osm' ? 'OpenStreetMap' : i.source})` : ''}. Es gibt keinen Website-Score; die Verkaufschance stützt sich nur auf die vorhandenen Angaben (${[i.phone ? 'Telefon' : null, i.address ? 'Adresse' : null, i.email ? 'E-Mail' : null].filter(Boolean).join(', ') || 'wenige Daten'}).`
    : status === 'BLOCKED' || status === 'UNREACHABLE' ? `Die Website ${i.websiteUrl ?? ''} konnte nicht geprüft werden (${status === 'BLOCKED' ? 'Abruf blockiert' : 'nicht erreichbar'}). Es gibt keinen Website-Score.`
    : `Geprüft wurde ${i.websiteUrl}. Website-Score ${i.websiteScore ?? 'nicht verfügbar'}/100: ${weaknesses.length} Auffälligkeit(en), ${positive.length} positive Punkt(e), ${unknown.length} Punkt(e) nicht festgestellt.`;

  const angle = noSite ? 'Unverbindlichen Website-Entwurf anbieten: online wurde keine eigene Website gefunden.'
    : status === 'ANALYZED' && top.length ? `Konkrete Auffälligkeiten ansprechen (${top.map((c) => lc(c.summary)).join('; ')}) und einen unverbindlichen Entwurf anbieten.`
    : status === 'BLOCKED' || status === 'UNREACHABLE' ? 'Erst Website manuell prüfen, dann entscheiden.' : 'Website wirkt in den geprüften Punkten solide – geringe Priorität.';

  const sales: Point[] = [...i.reasons.filter((r) => r.code !== 'LOW_NEED').map((r) => ({ code: r.code, text: r.text, evidence: r.evidence }))];
  for (const w of weaknesses.slice(0, 3)) if (!sales.some((s) => s.code === w.code) && cfg.improvements[w.code!]) sales.push({ code: w.code, text: `${lc(w.text)} – mit einer neuen Website umsetzbar: ${lc(cfg.improvements[w.code!])}.`, evidence: w.evidence });

  const keyFacts = factSources(['name', 'phone', 'email', 'website', 'address', 'openingHours']);
  const srcMap = new Map<string, { source: string; url?: string; fields: Set<string> }>();
  for (const f of keyFacts) { const k = `${f.source}|${f.url ?? ''}`; const e = srcMap.get(k) ?? { source: f.source, url: f.url, fields: new Set<string>() }; e.fields.add(f.key); srcMap.set(k, e); }
  const confidence = Math.round(Math.max(0, Math.min(1, (noSite ? 0.7 : status === 'ANALYZED' ? Math.max(0.2, i.coverage) : 0.3) * (i.dataQualityFactor || 0.5))) * 1000) / 1000;

  return {
    website_status: status, website_score: noSite || status === 'BLOCKED' || status === 'UNREACHABLE' ? null : i.websiteScore, sales_opportunity: i.salesOpportunity, analysis_summary: summary,
    positive_points: positive, weaknesses, sales_reasons: sales, recommended_improvements: improvements, recommended_demo_features: demoFeatures, recommended_contact_angle: angle,
    telephone_talking_points: telephone, email_talking_points: emailPts, missing_information: missing, manual_checks: manual,
    evidence: i.checks.filter((c) => c.status !== 'pass').slice(0, 30).map((c) => ({ code: c.code, status: c.status, evidence: c.evidence })),
    sources: [...srcMap.values()].map((s) => ({ source: s.source, url: s.url, fields: [...s.fields] })), confidence,
  };
}

/** Fingerabdruck der Grundlage (Fakten + Prüfergebnis + Konfiguration): gleiche Grundlage → vorhandene Analyse wiederverwenden statt neu zu rechnen/zu bezahlen. */
export function contentHash(i: StructInput, extra: string): string {
  const base = { n: i.companyName, w: i.websiteUrl ?? null, a: i.auditStatus, s: i.websiteScore, o: i.salesOpportunity, c: i.checks.map((c) => `${c.code}:${c.status}`), f: i.facts.map((f) => `${f.key}=${JSON.stringify(f.value)}@${f.source}`).sort(), x: extra };
  return createHash('sha256').update(JSON.stringify(base)).digest('hex').slice(0, 32);
}

/** Konzept ohne KI (Rückfall für PREMIUM und Mock): Seitenstruktur und Conversion-Ideen aus den Branchen-Features; Texte nur als „Beispiel“. */
export function baseConcept(i: StructInput, cfg: AnalysisConfig, a: StructuredAnalysis): Concept {
  const L = cfg.featureLabels;
  const sections = ['Kopfbereich mit Name und Hauptaktion', ...i.features.map((f) => L[f]).filter(Boolean), 'Kontakt'];
  return {
    site_structure: [{ page: 'Startseite', sections: sections.slice(0, 6) }, { page: 'Leistungen', sections: ['Leistungsübersicht (nur belegte Leistungen)'] }, { page: 'Kontakt', sections: ['Telefon', 'Adresse und Karte', 'Öffnungszeiten', 'Impressum und Datenschutz verlinkt'] }],
    conversion_concept: [`Hauptaktion oben auf jeder Seite: ${i.features.includes('booking') ? 'Termin anfragen' : i.features.includes('reservation') ? 'Tisch reservieren' : i.features.includes('quote') ? 'Angebot anfragen' : 'Anrufen'}`, 'Telefonnummer immer sichtbar und per Tipp anrufbar', ...a.recommended_improvements.slice(0, 3)],
    copy_samples: [{ section: 'Überschrift', text: `Beispiel: ${i.companyName} – ${i.subLabel ?? 'Ihr Betrieb vor Ort'}` }, { section: 'Einleitung', text: 'Beispiel: Hier folgt später ein kurzer, vom Betrieb bestätigter Text.' }],
    tone: 'freundlich, klar, lokal', individual_outreach: a.recommended_contact_angle, demo_preparation: ['Nur bestätigte Unternehmensdaten übernehmen', 'Bilder und Texte als Beispiel kennzeichnen', ...(a.recommended_demo_features.length ? [`Funktionen einplanen: ${a.recommended_demo_features.join(', ')}`] : [])],
  };
}
