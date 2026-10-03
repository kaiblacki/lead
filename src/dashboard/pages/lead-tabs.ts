import { html, postBtn, postForm, fmt, type Safe } from '../ui.ts';
import { ASSIGNMENT_STATUS_LABEL, CHANNEL_LABEL, CONTACT_STATUS_LABEL, resultIcon, resultLabel } from '../../team/rules.ts';

/** Lead-Detailseite in Reiter (serverseitig, ohne JavaScript). Alle Reiter bleiben im HTML; inaktive sind `hidden` und werden per :target (Anker) trotzdem sichtbar. */
export const LEAD_TABS: [string, string][] = [['uebersicht', 'ÜBERSICHT'], ['verkauf', 'VERKAUF'], ['website', 'WEBSITE'], ['demo', 'DEMO'], ['partner', 'PARTNER'], ['bedarf', 'BEDARFSANALYSE'], ['angebot', 'ANGEBOT'], ['verlauf', 'VERLAUF'], ['alle', 'ALLE']];
export const tabKey = (v: string | null): string => (LEAD_TABS.some(([k]) => k === v) ? (v as string) : 'uebersicht');

export const tabBar = (leadId: string, cur: string) => html`<nav class="tabs" aria-label="Lead-Bereiche">${LEAD_TABS.map(([k, label]) => html`<a href="/leads/${leadId}?tab=${k}" class="${cur === k ? 'on' : ''}" ${cur === k ? html`aria-current="page"` : ''}>${label}</a>`)}</nav>`;
export const pane = (key: string, cur: string, content: Safe | string) => html`<section class="tabpane" data-tab="${key}" ${cur === 'alle' || cur === key ? '' : html`hidden`}>${content}</section>`;

/** Schnellaktionen: nur Links zu den vorhandenen, bestätigungspflichtigen Bereichen – nichts wird hier ausgeführt oder gesendet. */
export const quickActions = (o: { leadId: string; phone: string | null; hasEmail: boolean }) => html`<div class="quick" role="group" aria-label="Schnellaktionen">
  ${o.phone ? html`<a class="btn primary" href="tel:${o.phone.replace(/[^\d+]/g, '')}">ANRUFEN</a>` : html`<a class="btn" href="/leads/${o.leadId}?tab=uebersicht#kontakt" title="Keine Telefonnummer bekannt">ANRUFEN (keine Nummer)</a>`}
  <a class="btn" href="/leads/${o.leadId}?tab=verkauf#vorlagen">E-MAIL ENTWURF</a><a class="btn" href="/leads/${o.leadId}?tab=demo#demo-stufe">DEMO</a><a class="btn" href="/leads/${o.leadId}?tab=uebersicht#kontakt">RÜCKRUF</a>
  <a class="btn" href="/leads/${o.leadId}?tab=angebot#angebot">ANGEBOT</a><a class="btn" href="/leads/${o.leadId}?tab=partner#partner">PARTNER</a></div>`;

/** Bedarfsanalyse: eigenständig, ohne Preise, Rabatte oder Verknüpfung mit Website/Partnerschaft. */
export const needsCard = (o: { csrf: string; leadId: string; na: { label: string; potential: string; reason: string; questions: string[]; note: string } | null; hasOpenTask: boolean }) => html`<div class="card" id="bedarfsanalyse"><h2>Bedarfsanalyse</h2>
  <p class="note">Eigenständiges Thema – <b>getrennt von Website und Partnerschaft</b>. Kein Rabatt, kein Partnerstatus und keine Community-Leistung hängt von einem Abschluss ab. Beratungsinhalte nur im persönlichen Gespräch, nichts wird automatisch versendet.</p>
  ${o.na ? html`<p>Potenzial: <b>${o.na.label}</b> (${o.na.potential}). ${o.na.reason}</p><b>Fragen zur Vorbereitung</b><ul>${o.na.questions.map((q) => html`<li>${q}</li>`)}</ul><small class="mute">${o.na.note}</small>` : html`<p class="mute">Noch keine Einschätzung – öffne den Verkaufsassistenten.</p>`}
  <div class="row">${o.hasOpenTask ? html`<span class="badge b-info">Termin-Aufgabe offen</span>` : postBtn(o.csrf, `/leads/${o.leadId}/needs-task`, 'Aufgabe „Termin Bedarfsanalyse“ anlegen', { cls: 'primary' })}</div></div>`;

/** Team: Zuweisung (Besitzer, Sperre) und lückenlose Kontakt-Historie je Lead – nur ergänzend, nichts wird überschrieben. */
export const teamCard = (o: { csrf: string; leadId: string; assign: any; users: any[]; attempts: any[]; canManage: boolean }) => html`<div class="card" id="zuweisung"><h2>Zuweisung</h2>
  <p>Besitzer: <b>${o.assign?.assignee ?? 'nicht zugewiesen'}</b> · ${ASSIGNMENT_STATUS_LABEL[o.assign?.assignment_status ?? 'UNASSIGNED']}${o.assign?.assigned_at ? html` · seit ${fmt(o.assign.assigned_at)} (${o.assign.assignment_source ?? ''}, von ${o.assign.assigned_by ?? '–'})` : ''} · Kontaktstatus: ${CONTACT_STATUS_LABEL[(o.assign?.contact_status ?? 'NOT_CONTACTED') as keyof typeof CONTACT_STATUS_LABEL]}</p>
  ${o.assign?.working_user_id && new Date(o.assign.lock_expires_at) > new Date() ? html`<p class="warnbox">Wird gerade bearbeitet (Sperre bis ${fmt(o.assign.lock_expires_at)}). ${o.canManage ? postBtn(o.csrf, `/team/leads/${o.leadId}/unlock`, 'Sperre lösen') : ''}</p>` : ''}
  ${o.canManage ? html`${postForm(o.csrf, `/team/leads/${o.leadId}/assign`, html`<div class="row"><select name="user">${o.users.filter((u) => u.status === 'ACTIVE').map((u) => html`<option value="${u.id}" ${o.assign?.assigned_to_user_id === u.id ? 'selected' : ''}>${u.name}</option>`)}</select><button class="primary">Zuweisen</button></div>`, { style: 'display:block' })}${o.assign?.assigned_to_user_id ? postBtn(o.csrf, `/team/leads/${o.leadId}/unassign`, 'Zuweisung aufheben') : ''}` : ''}</div>
  <div class="card" id="kontakthistorie"><h2>Kontakt-Historie (Mitarbeiter)</h2>${o.attempts.length ? html`<ul class="items">${o.attempts.map((a) => html`<li><small>${fmt(a.started_at)}</small> · <b>${a.user_name}</b><div>${resultIcon(a.result, a.channel)} ${CHANNEL_LABEL[a.channel] ?? a.channel} – ${resultLabel(a.result)}${a.status === 'DRAFT' ? ' (Entwurf, nicht versendet)' : a.status === 'SENT' ? ' (als versendet bestätigt)' : ''}</div>${a.note ? html`<div class="note">${a.note}</div>` : ''}${a.next_action ? html`<small class="mute">Danach: ${a.next_action}${a.next_action_at ? ' (' + fmt(a.next_action_at) + ')' : ''}</small>` : ''}</li>`)}</ul>` : html`<p class="mute">Noch kein Kontaktversuch erfasst.</p>`}</div>`;
