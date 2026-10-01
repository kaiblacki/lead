export type RecommendInput = {
  websiteState: string | null; websiteScore: number | null; salesOpportunity: number | null; contactable: boolean; dataQuality: number | null;
  localIndustry: boolean; industryLabel?: string; closed: boolean; blocked: boolean; hasPhone: boolean; hasEmail: boolean; auditStatus: string | null;
};
export type RecommendCfg = { minOpportunity: number; weakWebsiteBelow: number; minDataQuality: number };
export type Recommendation = { recommended: boolean; reason: string };

/** Lohnt sich eine Demo? Nur eine Empfehlung mit Begründung – erstellt wird nichts. */
export function recommendDemo(i: RecommendInput, c: RecommendCfg): Recommendation {
  const no = (reason: string): Recommendation => ({ recommended: false, reason });
  if (i.closed) return no('Betrieb dauerhaft geschlossen.');
  if (i.blocked) return no('Kontakt gesperrt (Do not contact).');
  const noSite = i.websiteState === 'none';
  if (!noSite && (i.auditStatus === 'UNREACHABLE' || i.websiteScore === null)) return no('Website nicht prüfbar – erst manuell ansehen.');
  if (!noSite && i.websiteScore !== null && i.websiteScore >= c.weakWebsiteBelow) return no(`Website bereits ordentlich (${i.websiteScore}/100).`);
  if (i.salesOpportunity === null || i.salesOpportunity < c.minOpportunity) return no(`Verkaufschance ${i.salesOpportunity ?? '–'}/100 unter ${c.minOpportunity}.`);
  if (!i.contactable) return no('Erst Kontaktdaten beschaffen (keine Telefonnummer, keine E-Mail).');
  if (i.dataQuality !== null && i.dataQuality < c.minDataQuality) return no('Datenqualität zu gering.');
  if (!i.localIndustry) return no('Branche nicht eindeutig zugeordnet.');
  const parts = [noSite ? 'Keine Website gefunden' : `Website schwach (${i.websiteScore}/100)`, i.hasPhone ? 'Telefonnummer vorhanden' : 'E-Mail vorhanden', i.industryLabel ? `lokale Branche: ${i.industryLabel}` : 'lokale Branche', `Verkaufschance ${i.salesOpportunity}/100`];
  return { recommended: true, reason: parts.join(', ') + '.' };
}
