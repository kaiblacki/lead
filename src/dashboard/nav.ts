import type { Role } from '../team/rules.ts';

/** Navigation: Gruppen mit Unterpunkten je Rolle, Breadcrumbs und logische Zurück-Links (kein Browser-Verlauf). */
export type NavItem = { label: string; href: string; admin?: boolean };
export type NavGroup = { group: string; items: NavItem[] };

export const ADMIN_NAV: NavGroup[] = [
  { group: 'START', items: [{ label: 'Übersicht', href: '/' }, { label: 'Heute', href: '/today' }, { label: 'Aufgaben', href: '/tasks' }, { label: 'Neue Suche', href: '/search', admin: true }] },
  { group: 'LEADS', items: [{ label: 'Alle Leads', href: '/leads' }, { label: 'Jetzt bearbeiten', href: '/leads?quick=now_work' }, { label: 'Heute anrufen', href: '/leads?quick=call_today' }, { label: 'Daten beschaffen', href: '/leads?quick=data_needed' }, { label: 'Demo empfohlen', href: '/leads?quick=demo_recommended' }, { label: 'Daten (Anreicherung)', href: '/enrichment', admin: true }] },
  { group: 'SALES', items: [{ label: 'Rückrufe', href: '/leads?quick=later' }, { label: 'Interessiert', href: '/leads?quick=interested' }, { label: 'Demos', href: '/leads?quick=demo_exists' }, { label: 'Angebote', href: '/offers', admin: true }, { label: 'Aufträge', href: '/orders', admin: true }, { label: 'Pipeline', href: '/pipeline' }] },
  { group: 'TEAM', items: [{ label: 'Mitarbeiter', href: '/team' }, { label: 'Lead-Zuweisung', href: '/team/assign' }, { label: 'Kampagnen', href: '/team/campaigns' }, { label: 'Team-Aktivität', href: '/team/activity' }, { label: 'Übergaben', href: '/team/handoffs' }, { label: 'Tagesziele', href: '/team/goals' }] },
  { group: 'PARTNER', items: [{ label: 'Kandidaten', href: '/partners?f=candidates' }, { label: 'Aktive Partner', href: '/partners?f=active' }, { label: 'Referrals', href: '/referrals' }, { label: 'Community', href: '/community', admin: true }] },
  { group: 'KUNDEN', items: [{ label: 'Kunden', href: '/customers', admin: true }, { label: 'Produktion', href: '/production', admin: true }, { label: 'Wartung', href: '/maintenance', admin: true }, { label: 'Änderungswünsche', href: '/customers/requests', admin: true }] },
  { group: 'ANALYTICS', items: [{ label: 'Übersicht', href: '/analytics' }, { label: 'Funnel', href: '/analytics?view=funnel' }, { label: 'Branchen', href: '/analytics?view=industries' }, { label: 'Regionen', href: '/analytics?view=regions' }, { label: 'Mitarbeiter', href: '/analytics?view=team' }, { label: 'Partner', href: '/analytics?view=partners' }, { label: 'Umsatz', href: '/analytics?view=revenue', admin: true }] },
  { group: 'SYSTEM', items: [{ label: 'Einstellungen', href: '/settings', admin: true }, { label: 'Kosten', href: '/analytics?view=costs', admin: true }, { label: 'Datenquellen', href: '/settings#datenquellen', admin: true }] },
];
export const SALES_NAV: NavItem[] = [{ label: 'MEIN TAG', href: '/work' }, { label: 'MEINE LEADS', href: '/work/leads' }, { label: 'RÜCKRUFE', href: '/work/leads?f=callbacks' }, { label: 'AUFGABEN', href: '/work/tasks' }, { label: 'ÜBERGABEN', href: '/work/handoffs' }, { label: 'TRAINING', href: '/work/training' }];

export function navFor(role: Role): { groups: NavGroup[]; flat?: NavItem[] } {
  if (role === 'SALES') return { groups: [], flat: SALES_NAV };
  const groups = ADMIN_NAV.map((g) => ({ group: g.group, items: g.items.filter((i) => role === 'ADMIN' || !i.admin) })).filter((g) => g.items.length && (role === 'ADMIN' || g.group !== 'SYSTEM'));
  return { groups };
}
const bare = (h: string) => h.split('#')[0];
/** Aktiver Eintrag: exakte Übereinstimmung inkl. Query, sonst längster Pfad-Präfix ohne Query. */
export function activeHref(items: NavItem[], path: string, search: string): string | null {
  const full = path + search; let best: string | null = null; let bestLen = -1;
  for (const i of items) {
    const h = bare(i.href); const [hp, hq] = h.split('?');
    if (h === full) return i.href;
    if (!hq && (path === hp || (hp !== '/' && path.startsWith(hp + '/')) ) && hp.length > bestLen) { best = i.href; bestLen = hp.length; }
  }
  return best;
}
export function activeGroup(role: Role, path: string, search: string): string | null {
  const { groups } = navFor(role); const exact = groups.find((g) => g.items.some((i) => bare(i.href) === path + search));
  if (exact) return exact.group; let best: string | null = null; let len = -1;
  for (const g of groups) { const a = activeHref(g.items, path, search); if (a) { const l = bare(a).split('?')[0].length; if (l > len) { len = l; best = g.group; } } }
  return best;
}

export type Crumb = [string, string?];
type Rule = { re: RegExp; crumbs: (m: RegExpExecArray, title: string) => Crumb[]; back?: (m: RegExpExecArray) => [string, string] };
const H: Crumb = ['Startseite', '/'];
const RULES: Rule[] = [
  { re: /^\/$/, crumbs: () => [['Startseite']] },
  { re: /^\/today$/, crumbs: () => [H, ['Heute']] }, { re: /^\/tasks$/, crumbs: () => [H, ['Aufgaben']] }, { re: /^\/search/, crumbs: () => [H, ['Neue Suche']] },
  { re: /^\/leads$/, crumbs: () => [H, ['Leads']] },
  { re: /^\/leads\/[0-9a-f-]{36}$/, crumbs: (_m, t) => [H, ['Leads', '/leads'], [t]], back: () => ['← Zur Leadliste', '/leads'] },
  { re: /^\/leads\/([0-9a-f-]{36})\/.+/, crumbs: (m, t) => [H, ['Leads', '/leads'], ['Lead', `/leads/${m[1]}`], [t]], back: (m) => ['← Zum Lead', `/leads/${m[1]}`] },
  { re: /^\/calls/, crumbs: () => [H, ['Leads', '/leads'], ['Anrufliste']] }, { re: /^\/enrichment/, crumbs: () => [H, ['Leads', '/leads'], ['Daten']] },
  { re: /^\/pipeline/, crumbs: () => [H, ['Sales'], ['Pipeline']] },
  { re: /^\/offers$/, crumbs: () => [H, ['Sales'], ['Angebote']] }, { re: /^\/offers\/[0-9a-f-]{36}$/, crumbs: (_m, t) => [H, ['Sales'], ['Angebote', '/offers'], [t]], back: () => ['← Zu den Angeboten', '/offers'] },
  { re: /^\/orders$/, crumbs: () => [H, ['Sales'], ['Aufträge']] }, { re: /^\/orders\/[0-9a-f-]{36}/, crumbs: (_m, t) => [H, ['Sales'], ['Aufträge', '/orders'], [t]], back: () => ['← Zu den Aufträgen', '/orders'] },
  { re: /^\/production$/, crumbs: () => [H, ['Kunden'], ['Produktion']] },
  { re: /^\/customers$/, crumbs: () => [H, ['Kunden']] }, { re: /^\/customers\/requests$/, crumbs: () => [H, ['Kunden', '/customers'], ['Änderungswünsche']], back: () => ['← Zur Kundenliste', '/customers'] },
  { re: /^\/customers\/[0-9a-f-]{36}$/, crumbs: (_m, t) => [H, ['Kunden', '/customers'], [t]], back: () => ['← Zur Kundenliste', '/customers'] },
  { re: /^\/maintenance$/, crumbs: () => [H, ['Kunden'], ['Wartung']] }, { re: /^\/maintenance\/[0-9a-f-]{36}/, crumbs: (_m, t) => [H, ['Kunden'], ['Wartung', '/maintenance'], [t]], back: () => ['← Zur Wartung', '/maintenance'] },
  { re: /^\/community$/, crumbs: () => [H, ['Partner'], ['Community']] },
  { re: /^\/partners$/, crumbs: () => [H, ['Partner']] }, { re: /^\/partners\/[0-9a-f-]{36}$/, crumbs: (_m, t) => [H, ['Partner', '/partners'], [t]], back: () => ['← Zur Partnerliste', '/partners'] },
  { re: /^\/referrals$/, crumbs: () => [H, ['Partner', '/partners'], ['Referrals']] }, { re: /^\/referrals\/[0-9a-f-]{36}$/, crumbs: (_m, t) => [H, ['Partner', '/partners'], ['Referrals', '/referrals'], [t]], back: () => ['← Zu den Referrals', '/referrals'] },
  { re: /^\/analytics$/, crumbs: () => [H, ['Analytics']] },
  { re: /^\/team$/, crumbs: () => [H, ['Team']] },
  { re: /^\/team\/(assign|campaigns|activity|handoffs|goals|new|audit)$/, crumbs: (m, t) => [H, ['Team', '/team'], [t || m[1]]], back: () => ['← Zum Team', '/team'] },
  { re: /^\/team\/campaigns\/[0-9a-f-]{36}$/, crumbs: (_m, t) => [H, ['Team', '/team'], ['Kampagnen', '/team/campaigns'], [t]], back: () => ['← Zu den Kampagnen', '/team/campaigns'] },
  { re: /^\/team\/([0-9a-f-]{36})$/, crumbs: (_m, t) => [H, ['Team', '/team'], [t]], back: () => ['← Zum Team', '/team'] },
  { re: /^\/team\/([0-9a-f-]{36})\/leads$/, crumbs: (m, t) => [H, ['Team', '/team'], ['Mitarbeiter', `/team/${m[1]}`], [t]], back: (m) => ['← Zu Mitarbeiter', `/team/${m[1]}`] },
  { re: /^\/team\/lead\/([0-9a-f-]{36})$/, crumbs: (_m, t) => [H, ['Team', '/team'], [t]], back: () => ['← Zu Mitarbeiter', '/team'] },
  { re: /^\/settings/, crumbs: () => [H, ['System'], ['Einstellungen']] }, { re: /^\/social/, crumbs: (_m, t) => [H, ['Leads', '/leads'], [t]] }, { re: /^\/menu$/, crumbs: () => [H, ['Alle Seiten']] },
];
/** Standard-Breadcrumbs und Zurück-Link aus dem Pfad; Seiten können beides überschreiben. */
export function autoCrumbs(path: string, title: string, search = ''): { crumbs: Crumb[]; back: [string, string] | null } {
  for (const r of RULES) { const m = r.re.exec(path); if (m) {
    let crumbs = r.crumbs(m, title);
    if (path === '/analytics') { const v = new URLSearchParams(search).get('view'); if (v && v !== 'funnel') crumbs = [H, ['Analytics', '/analytics'], [title]]; }
    const back = r.back ? r.back(m) : path === '/analytics' && new URLSearchParams(search).get('view') && new URLSearchParams(search).get('view') !== 'funnel' ? ['← Zu Analytics', '/analytics'] as [string, string] : null; return { crumbs, back }; } }
  return { crumbs: [H, [title]], back: null };
}
