export type Lead = {
  id: string;
  companyName: string;
  industry?: string;
  address?: string;
  city?: string;
  region?: string;
  phone?: string;
  websiteUrl?: string;
  socials?: { platform: string; url: string; lastActivityAt?: string }[];
  source: string;
  sourceUrl?: string;
  mapsUrl?: string;
  openingHours?: string;
  description?: string;
};

export type Severity = 'low' | 'medium' | 'high';
export type FindingCategory = 'technical' | 'mobile' | 'content' | 'conversion' | 'design' | 'trust' | 'social';

/** Ein belegter Befund. Nur Befunde dürfen später in Verkaufsargumenten auftauchen. */
export type Finding = {
  code: string;
  category: FindingCategory;
  severity: Severity;
  summary: string;
  evidence: string;
};

export type Scores = Record<'website' | 'mobile' | 'design' | 'content' | 'conversion' | 'technical' | 'trust' | 'social', number>;

export type FetchResult = {
  ok: boolean;
  finalUrl?: string;
  status?: number;
  loadMs?: number;
  html?: string;
  error?: string;
};

export type AuditResult = {
  leadId: string;
  status: 'NO_WEBSITE' | 'UNREACHABLE' | 'ANALYZED';
  findings: Finding[];
  scores: Scores | null;
  auditedAt: string;
};
