import type { AuditResult, Lead } from '../core/types.ts';

export type ScoringConfig = {
  weights: Record<string, number>;
  impliedByMissingWebsite: string[];
  thresholds: { HOT: number; HIGH_POTENTIAL: number; MEDIUM: number; LOW: number };
  socialActiveDays: number;
  highBenefitMinProblems: number;
};
export type Category = 'HOT' | 'HIGH POTENTIAL' | 'MEDIUM' | 'LOW' | 'IGNORE';
export type Factor = { key: string; points: number; reason: string; implied?: boolean };
export type Opportunity =
  | { scored: false; reason: string }
  | { scored: true; score: number; category: Category; factors: Factor[]; why: string };

export function categorize(score: number, t: ScoringConfig['thresholds']): Category {
  if (score >= t.HOT) return 'HOT';
  if (score >= t.HIGH_POTENTIAL) return 'HIGH POTENTIAL';
  if (score >= t.MEDIUM) return 'MEDIUM';
  if (score >= t.LOW) return 'LOW';
  return 'IGNORE';
}

export function scoreOpportunity(lead: Lead, audit: AuditResult, cfg: ScoringConfig, now = new Date()): Opportunity {
  if (audit.status === 'UNREACHABLE') return { scored: false, reason: 'Website nicht erreichbar – erneut prüfen, bevor bewertet wird.' };
  const w = cfg.weights;
  const factors: Factor[] = [];
  const codes = new Set(audit.findings.map((f) => f.code));
  const add = (key: string, applies: boolean, reason: string, implied = false) => {
    if (applies && w[key]) factors.push({ key, points: w[key], reason, implied });
  };
  const noSite = audit.status === 'NO_WEBSITE';
  const imp = (k: string) => noSite && cfg.impliedByMissingWebsite.includes(k);

  add('website_missing', noSite, 'Es ist keine Website hinterlegt.');
  add('website_outdated', imp('website_outdated') || ['OLD_TECH', 'STALE_COPYRIGHT', 'NO_HTTPS'].some((c) => codes.has(c)),
    noSite ? 'Ohne Website gibt es keinen modernen Webauftritt.' : 'Veraltete Technik, Copyright-Jahr oder fehlendes HTTPS festgestellt.', imp('website_outdated'));
  add('mobile_problems', imp('mobile_problems') || codes.has('NO_VIEWPORT') || codes.has('SLOW_LOAD'),
    noSite ? 'Ohne Website gibt es keine mobile Darstellung.' : 'Kein Viewport-Tag oder langsame Ladezeit.', imp('mobile_problems'));
  add('no_clear_conversion', imp('no_clear_conversion') || ['NO_CLEAR_CTA', 'NO_PHONE', 'NO_CONTACT_OPTION'].some((c) => codes.has(c)),
    noSite ? 'Ohne Website gibt es keinen Kontaktweg über das Web.' : 'Kein klarer Button, keine Telefonnummer oder kein Kontaktweg.', imp('no_clear_conversion'));
  add('no_online_booking', imp('no_online_booking') || codes.has('NO_ONLINE_BOOKING'),
    noSite ? 'Ohne Website ist keine Online-Terminbuchung möglich.' : 'Keine Online-Terminbuchung erkennbar.', imp('no_online_booking'));
  const cutoff = now.getTime() - cfg.socialActiveDays * 86400000;
  add('social_active', (lead.socials ?? []).some((s) => s.lastActivityAt && Date.parse(s.lastActivityAt) >= cutoff),
    `Social-Media-Aktivität in den letzten ${cfg.socialActiveDays} Tagen.`);
  add('local_business', Boolean(lead.address && lead.city), 'Lokales Geschäft mit Adresse.');
  const problemKeys = ['website_missing', 'website_outdated', 'mobile_problems', 'no_clear_conversion', 'no_online_booking'];
  add('high_obvious_benefit', factors.filter((f) => problemKeys.includes(f.key)).length >= cfg.highBenefitMinProblems,
    'Mehrere unabhängige Verbesserungsfelder.');

  const score = Math.min(100, factors.reduce((s, f) => s + f.points, 0));
  const category = categorize(score, cfg.thresholds);
  const why = factors.length
    ? factors.map((f) => `${f.reason} (+${f.points})`).join(' ')
    : 'Keine nennenswerten Verbesserungsfelder festgestellt.';
  return { scored: true, score, category, factors, why };
}
