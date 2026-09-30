export type CheckStatus = 'pass' | 'warn' | 'fail' | 'unknown';
export type CheckCategory = 'technical' | 'mobile' | 'design' | 'content' | 'conversion' | 'seo' | 'social' | 'trust';
export const CATEGORIES: CheckCategory[] = ['technical', 'mobile', 'design', 'content', 'conversion', 'seo', 'social', 'trust'];
export type Severity = 'low' | 'medium' | 'high';

/** Ein konkreter Prüfpunkt mit Beleg. Nie "Website schlecht", immer was genau und woran erkannt. */
export type AuditCheck = { code: string; category: CheckCategory; status: CheckStatus; severity: Severity; summary: string; evidence: string };

export type AuditReport = {
  status: 'NO_WEBSITE' | 'UNREACHABLE' | 'ANALYZED';
  websiteUrl?: string; finalUrl?: string; pagesAnalyzed: number; capturedAt: string; source: string;
  /** Inhalt wird vermutlich per JavaScript geladen – Textprüfungen sind dann "unknown". */
  renderDependent: boolean;
  renderSource?: { name: string; estimated: boolean };
  checks: AuditCheck[];
  /** 0–100, höher = besser. null = keine belastbare Prüfung. */
  quality: Record<CheckCategory, number | null>;
  overallQuality: number | null;
  /** Anteil der Prüfpunkte mit belastbarem Ergebnis (0–1). */
  coverage: number;
  notes: string[];
};

export const STATUS_ICON: Record<CheckStatus, string> = { pass: '✅', warn: '⚠️', fail: '❌', unknown: '❔' };
