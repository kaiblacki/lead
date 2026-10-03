import type { SessionUser } from '../team/rules.ts';
import { homeFor, ROLE_LABEL } from '../team/rules.ts';
import { activeGroup, activeHref, autoCrumbs, navFor, type Crumb } from './nav.ts';
import { html, raw, Safe, esc } from './html.ts';
import { STAGE_LABEL, type Status } from '../core/status.ts';

/** Anzeigetexte für technische Statuswerte (nie rohe Enum-Namen im Dashboard zeigen). */
export const ORDER_LABEL: Record<string, string> = { PAYMENT_PENDING: 'Anzahlung offen', DEPOSIT_PAID: 'Anzahlung bezahlt', IN_PRODUCTION: 'In Produktion', QA: 'Qualitätsprüfung', CUSTOMER_REVIEW: 'Kundenfreigabe', APPROVED: 'Freigegeben', FINAL_PAYMENT_PENDING: 'Restzahlung offen', FULLY_PAID: 'Vollständig bezahlt', DEPLOYED: 'Veröffentlicht', MAINTENANCE_ACTIVE: 'Wartung aktiv' };
export const PLAN_LABEL: Record<string, string> = { ACTIVE: 'Aktiv', PAUSED: 'Pausiert', CANCELED: 'Gekündigt' };
export const PAY_STATE_LABEL: Record<string, string> = { pending: 'offen', paid: 'bezahlt', failed: 'fehlgeschlagen', expired: 'abgelaufen', refunded: 'erstattet' };
export const eur = (cents: number | null | undefined) => (cents === null || cents === undefined ? '–' : new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(cents / 100));
export const fmt = (d: unknown) => (d ? new Date(d as string).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Berlin' }) : '–');
export const fmtDate = (d: unknown) => (d ? new Date(d as string).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' }) : '–');
export const pct = (n: number | null | undefined) => (n === null || n === undefined ? '–' : `${String(n).replace('.', ',')} %`);

export const CSS = `
.tbl{width:100%;border-collapse:collapse}.tbl th,.tbl td{text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;font-size:14px}
:root{--bg:#f4f5f7;--card:#fff;--ink:#14181f;--mute:#5b6472;--line:#e3e6eb;--brand:#0b5cad;--ok:#1e7f3a;--warn:#b25e09;--bad:#c92a2a;--hot:#d6336c}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1000px;margin:0 auto;padding:12px 12px 90px;overflow-wrap:anywhere}h1{font-size:24px;margin:8px 0 12px}h2{font-size:19px;margin:0 0 8px}h3{font-size:16px;margin:12px 0 4px}p{margin:6px 0}
a{color:var(--brand)}small,.mute{color:var(--mute)}code{background:#eef0f3;padding:1px 5px;border-radius:5px;overflow-wrap:anywhere}
header.top{position:sticky;top:0;z-index:20;background:#101826;color:#fff}.top .bar{max-width:1000px;margin:0 auto;display:flex;align-items:center;gap:6px;padding:0 8px}
.top nav{display:flex;gap:2px;overflow-x:auto;flex:1;min-width:0;scrollbar-width:none}.top nav::-webkit-scrollbar{display:none}
.top .mainnav,.top .subnav{max-width:1000px;margin:0 auto;padding:0 8px}.top .subnav{background:#18253a}.top .ng{display:flex;flex:none}.top .bar{flex-wrap:wrap}.top a.home{color:#fff;text-decoration:none;padding:0 10px;min-height:44px;display:inline-flex;align-items:center;border:1px solid #3a4b68;border-radius:8px;white-space:nowrap}.top .who{color:#b8c6de;font-size:13px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.top a.brand{color:#fff;text-decoration:none;display:inline-flex;align-items:center;min-height:44px}
.big{font-size:18px}.btn.big,button.big{min-height:56px;font-size:18px;padding:0 22px}.telbtn{min-height:56px;font-size:20px}.startbtn{display:flex;justify-content:center;min-height:64px;font-size:20px;font-weight:700;margin-top:10px}.daylist{list-style:none;padding:0;margin:0 0 8px;font-size:18px}.daylist li{padding:4px 0}.callhead{border-left:5px solid #2f6fdb}
.crumbs{margin:6px 0 0}.crumbs ol{list-style:none;display:flex;flex-wrap:wrap;gap:2px;margin:0;padding:0;font-size:14px}.crumbs li+li::before{content:'›';margin:0 6px;color:var(--mute)}.crumbs a,.crumbs span{display:inline-flex;align-items:center;min-height:44px}.crumbs span{color:var(--mute)}
a.back{display:inline-flex;align-items:center;min-height:44px;padding:0 4px;font-weight:600;text-decoration:none}
.top nav a{color:#dbe3f0;text-decoration:none;padding:0 12px;min-height:48px;display:inline-flex;align-items:center;white-space:nowrap;border-bottom:3px solid transparent}
.top nav a.on{color:#fff;border-bottom-color:#5aa9ff;font-weight:600}.brand{font-weight:700;padding:0 6px;white-space:nowrap}
.top form{margin:0}.top button{min-height:44px;padding:0 12px}
.banner{padding:8px 12px;font-size:14px;text-align:center}.banner.mock{background:#fff3cd;color:#664d03}.banner.kill{background:#c92a2a;color:#fff;font-weight:700}
.card{background:var(--card);border-radius:12px;padding:12px 14px;margin:10px 0;box-shadow:0 1px 2px #0002}.card.flat{box-shadow:none;border:1px solid var(--line)}
.tabs{display:flex;gap:4px;overflow-x:auto;margin:8px 0;scrollbar-width:thin}.tabs a{padding:0 14px;min-height:44px;display:inline-flex;align-items:center;white-space:nowrap;border:1px solid #c8d0dc;border-radius:10px;text-decoration:none;color:inherit;background:#fff}.tabs a.on{background:#1a3a6b;color:#fff;border-color:#1a3a6b;font-weight:600}
.tabpane[hidden]{display:none}.tabpane[hidden]:has(:target){display:block}.quick{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}.quick .btn{min-height:48px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.grow{flex:1 1 auto}.stack>*+*{margin-top:8px}
.grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}.kpi{background:var(--card);border-radius:12px;padding:10px 12px;box-shadow:0 1px 2px #0002}.kpi b{font-size:26px;display:block;line-height:1.1}.kpi span{color:var(--mute);font-size:13px}
button,select,input,textarea,.btn{font:inherit;color:inherit;min-height:44px;padding:8px 12px;border-radius:10px;border:1px solid #b9c0cb;background:#fff}
textarea{width:100%;min-height:88px}input[type=checkbox],input[type=radio]{min-height:auto;width:22px;height:22px;padding:0;accent-color:var(--brand);vertical-align:middle}
button,.btn{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;text-decoration:none;font-weight:600;min-width:44px;background:#fff}
button.primary,.btn.primary{background:var(--brand);border-color:var(--brand);color:#fff}button.ok{background:var(--ok);border-color:var(--ok);color:#fff}button.danger,.btn.danger{background:var(--bad);border-color:var(--bad);color:#fff}button.warn{background:#fff3cd;border-color:#e0b84c}
button:disabled{opacity:.5;cursor:not-allowed}label{display:block;font-size:14px;color:var(--mute)}label input,label select,label textarea{display:block;width:100%;margin-top:2px;color:var(--ink)}label.inline{display:inline-flex;gap:8px;align-items:center;color:var(--ink);font-size:16px;min-height:44px;margin-right:14px}table.nowrap th,table.nowrap td{white-space:nowrap}label.inline input{display:inline-block;width:22px;margin:0}
fieldset{border:1px solid var(--line);border-radius:10px;margin:8px 0;padding:8px 12px}legend{font-size:14px;color:var(--mute);padding:0 6px}
.attrib{max-width:1000px;margin:0 auto;padding:4px 12px 80px;font-size:13px;color:var(--mute)}.facts{display:grid;grid-template-columns:max-content 1fr;gap:2px 10px;margin:6px 0;font-size:14px}.facts dt{color:var(--mute)}.facts dd{margin:0;overflow-wrap:anywhere}
.badge{display:inline-block;font-size:12px;font-weight:700;padding:3px 9px;border-radius:99px;background:#e6e9ee;color:#2b323d;max-width:100%;overflow-wrap:anywhere}
.b-HOT{background:var(--hot);color:#fff}.b-HIGH-POTENTIAL{background:#e8590c;color:#fff}.b-MEDIUM{background:#ffd43b}.b-LOW{background:#dee2e6}.b-IGNORE,.b-UNRATED{background:#ced4da}
.b-ok{background:#d3f9d8;color:#0b5d1e}.b-warn{background:#fff3bf;color:#7a4d00}.b-bad{background:#ffe3e3;color:#a61e1e}.b-mock{background:#fff3cd;color:#664d03}.b-info{background:#dbe4ff;color:#2b3a8c}
.prio{font-weight:800;font-size:18px;width:32px;height:32px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;background:#e6e9ee}.prio.A{background:var(--hot);color:#fff}.prio.B{background:#e8590c;color:#fff}.prio.C{background:#ffd43b}
.bar{height:8px;border-radius:5px;background:#e6e9ee;overflow:hidden}.bar i{display:block;height:100%;background:var(--brand)}
.flash{border-radius:10px;padding:10px 12px;margin:8px 0}.flash.ok{background:#d3f9d8}.flash.err{background:#ffe3e3}
.warnbox{background:#fff3cd;border-radius:10px;padding:8px 12px;margin:8px 0}.errbox{background:#ffe3e3;border-radius:10px;padding:8px 12px;margin:8px 0}.note{background:#eef4ff;border-radius:10px;padding:8px 12px;margin:8px 0}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;overflow-wrap:anywhere}th{font-size:13px;color:var(--mute);font-weight:600}
.items>li{list-style:none;margin:0;padding:10px 0;border-bottom:1px solid var(--line)}.items{padding:0;margin:0}.items>li:last-child{border-bottom:0}
details>summary{cursor:pointer;min-height:44px;display:flex;align-items:center;font-weight:600}
.stepper{display:flex;gap:4px;flex-wrap:wrap;margin:6px 0}.step{font-size:12px;padding:4px 8px;border-radius:8px;background:#e6e9ee;color:#4a5361}.step.done{background:#d3f9d8;color:#0b5d1e}.step.now{background:var(--brand);color:#fff;font-weight:700}
.sticky-actions{position:sticky;bottom:0;background:var(--card);padding:8px 0;border-top:1px solid var(--line);margin-top:8px}
.resgrid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.resgrid button{min-height:52px}
.tel{font-size:20px;font-weight:700;display:inline-flex;align-items:center;min-height:48px}
@media(max-width:719px){header.top{position:static}}
@media(min-width:720px){.resgrid{grid-template-columns:repeat(4,1fr)}main{padding-top:20px}}
`;

export type NavKey = string;

export type Flash = { kind: 'ok' | 'err'; text: string } | null;

export function layout(o: { title: string; nav: NavKey; body: Safe; csrf: string; killSwitch: boolean; mock: boolean; flash?: Flash; hostingMock?: boolean; attribution?: string; liveData?: boolean; user?: SessionUser; path?: string; search?: string; crumbs?: Crumb[]; back?: [string, string] | null }): Safe {
  const user: SessionUser = o.user ?? { id: null, name: 'Administrator', role: 'ADMIN' }; const path = o.path ?? '/'; const search = o.search ?? '';
  const home = homeFor(user.role); const homeLabel = user.role === 'SALES' ? '🏠 Mein Tag' : '🏠 Startseite'; const nv = navFor(user.role); const ag = nv.groups.length ? activeGroup(user.role, path, search) : null;
  const auto = autoCrumbs(path, o.title, search); const crumbs = o.crumbs ?? (user.role === 'SALES' ? null : auto.crumbs); const back = o.back === undefined ? (user.role === 'SALES' ? null : auto.back) : o.back;
  const flatAct = nv.flat ? activeHref(nv.flat, path, search) : null; const sub = nv.groups.find((g) => g.group === ag); const subAct = sub ? activeHref(sub.items, path, search) : null;
  return html`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${o.title} – Agency OS</title><style>${raw(CSS)}</style></head><body>
<header class="top"><div class="bar"><a class="brand" href="${home}">Agency OS</a><a class="home" href="${home}">${homeLabel}</a>
<span class="who" title="${ROLE_LABEL[user.role]}">${user.name} · ${ROLE_LABEL[user.role]}</span>${user.role === 'ADMIN' ? html`<a class="home" href="/menu">Alle Seiten</a>` : ''}
${user.role === 'ADMIN' ? html`<form method="post" action="/killswitch"><input type="hidden" name="csrf" value="${o.csrf}"><input type="hidden" name="on" value="${o.killSwitch ? '0' : '1'}"><button class="${o.killSwitch ? 'ok' : 'danger'}" title="${o.killSwitch ? 'Automatisierung wieder erlauben' : 'Alle automatischen Läufe stoppen'}">${o.killSwitch ? 'Fortsetzen' : 'STOP'}</button></form>` : ''}</div>
${nv.flat ? html`<nav aria-label="Hauptnavigation" class="mainnav">${nv.flat.map((i) => html`<a href="${i.href}" class="${flatAct === i.href ? 'on' : ''}">${i.label}</a>`)}</nav>`
  : html`<nav aria-label="Hauptnavigation" class="mainnav">${nv.groups.map((g) => html`<div class="ng" role="group" aria-label="${g.group}"><a href="${g.items[0].href}" class="${ag === g.group ? 'on' : ''}">${g.group}</a></div>`)}</nav>
${sub ? html`<nav aria-label="Bereich ${sub.group}" class="subnav">${sub.items.map((i) => html`<a href="${i.href}" class="${subAct === i.href ? 'on' : ''}">${i.label}</a>`)}</nav>` : ''}`}
${o.killSwitch ? html`<div class="banner kill">KILL SWITCH AKTIV – keine Suchläufe, Analysen oder Wartungsprüfungen</div>` : ''}
${o.mock ? (o.liveData ? html`<div class="banner mock"><b>DEMO-MODUS</b> · ECHTE FIRMENDATEN (öffentlich, OpenStreetMap) – Web-Enrichment, KI, Zahlung, E-Mail und WhatsApp können deaktiviert bzw. Mock sein: es wird nichts gesendet oder bezahlt</div>` : html`<div class="banner mock"><b>DEMO-MODUS</b> · MOCK-MODUS – Testdaten, keine echten Unternehmen, Zahlungen oder Nachrichten</div>`) : ''}</header>
<main>${crumbs ? html`<nav class="crumbs" aria-label="Brotkrumen"><ol>${crumbs.map(([label, href], i) => html`<li>${href && i < crumbs.length - 1 ? html`<a href="${href}">${label}</a>` : html`<span aria-current="page">${label}</span>`}</li>`)}</ol></nav>` : ''}${back ? html`<a class="back" href="${back[1]}">${back[0]}</a>` : ''}${o.flash ? html`<div class="flash ${o.flash.kind}" role="status">${o.flash.text}</div>` : ''}<h1>${o.title}</h1>${o.body}</main>${o.attribution ? html`<footer class="attrib">${o.attribution} · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">openstreetmap.org/copyright</a></footer>` : ''}</body></html>`;
}

export const postForm = (csrf: string, action: string, inner: Safe | string, o: { cls?: string; style?: string } = {}) =>
  html`<form method="post" action="${action}" class="${o.cls ?? ''}" style="${o.style ?? 'display:inline'}"><input type="hidden" name="csrf" value="${csrf}">${typeof inner === 'string' ? raw(inner) : inner}</form>`;
export const postBtn = (csrf: string, action: string, label: string, o: { cls?: string; hidden?: Record<string, string>; confirm?: boolean } = {}) =>
  postForm(csrf, action, html`${Object.entries(o.hidden ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<button class="${o.cls ?? ''}">${label}</button>`);

export const categoryBadge = (c: string | null | undefined) => html`<span class="badge b-${String(c ?? 'UNRATED').replace(/\s/g, '-')}">${c ?? 'nicht bewertet'}</span>`;
export const statusBadge = (s: string) => html`<span class="badge b-info">${STAGE_LABEL[s as Status] ?? s}</span>`;
export const readinessBadge = (r: string | null | undefined) => {
  const m: Record<string, [string, string]> = { READY_FOR_MANUAL_CALL: ['ok', 'Bereit für Anruf'], EMAIL_PERMISSION_REQUIRED: ['warn', 'E-Mail: Einwilligung nötig'], WHATSAPP_OPT_IN_REQUIRED: ['warn', 'WhatsApp: Opt-in nötig'], MANUAL_REVIEW: ['warn', 'Manuell prüfen'], DO_NOT_CONTACT: ['bad', 'Nicht kontaktieren'] };
  const [cls, label] = m[r ?? ''] ?? ['info', 'unbekannt'];
  return html`<span class="badge b-${cls}">${label}</span>`;
};
export const mockBadge = html`<span class="badge b-mock" title="Fiktiver Testdatensatz">MOCK</span>`;
export const scoreBar = (v: number | null | undefined) => (v === null || v === undefined ? html`<small>–</small>` : html`<div class="bar" role="img" aria-label="${v} von 100"><i style="width:${Math.max(2, Math.min(100, v))}%"></i></div>`);
export const prioBadge = (p: string | null | undefined) => html`<span class="prio ${p ?? ''}" title="Priorität">${p ?? '–'}</span>`;
export const STATE_TEXT: Record<string, string> = { measured: 'gemessen', implied: 'abgeleitet', unavailable: 'nicht verfügbar', unreliable: 'nicht zuverlässig ermittelbar' };
export { html, raw, Safe, esc };
