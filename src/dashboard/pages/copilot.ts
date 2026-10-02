import { html, raw, fmt, postForm, type Safe } from '../ui.ts';
import { CONTACT_STRATEGIES, CONTACT_STRATEGY_HELP, CONTACT_STRATEGY_LABEL, STRATEGY_LABEL, type ContactStrategy } from '../../sales/copilot.ts';
import { DEMO_STAGES, DEMO_STAGE_HELP, DEMO_STAGE_LABEL, type DemoStage } from '../../demo/stage.ts';
import type { EmailDraft } from '../../sales/email-draft.ts';
import { PARTNER_LABEL, REFERRAL_STATUS_LABEL, type PartnerStatus } from '../../partners/model.ts';
import { NEXT_ACTION_LABEL, POTENTIAL_LABEL, NEEDS_LABEL, type Copilot, type Potential } from '../../sales/copilot.ts';
import { TOPICS, TOPIC_LABEL } from '../../calls/service.ts';
import type { StoredCopilot } from '../../sales/copilot-service.ts';

const pcls = (p: string | null | undefined) => (p === 'HIGH' ? 'b-ok' : p === 'MEDIUM' ? 'b-info' : p === 'UNKNOWN' ? 'b-warn' : '');
const sub = 'border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:10px 0';
const ul = (xs: string[]) => (xs.length ? html`<ul>${xs.map((x) => html`<li>${x}</li>`)}</ul>` : html`<p class="mute">nicht verfügbar</p>`);
const NEEDS_SHORT: Record<string, string> = { HIGH: 'INTERESSANT', MEDIUM: 'SPÄTER', LOW: 'SPÄTER', UNKNOWN: 'UNKLAR' };

/** Kleine Kennzeichen für Listen: 🌐 Website · 🛡 Bedarfsanalyse · 🤝 Kooperation. */
export function potentialBadges(l: { website_potential?: string | null; needs_analysis_potential?: string | null; partnership_potential?: string | null }): Safe {
  if (!l.website_potential && !l.needs_analysis_potential && !l.partnership_potential) return html``;
  const b = (icon: string, name: string, v?: string | null) => html`<span class="badge ${pcls(v)}" title="${name}-Potenzial: ${v ? POTENTIAL_LABEL[v as Potential] : 'nicht bewertet'}">${icon} ${name}: ${v ?? '–'}</span>`;
  return html`<div class="row" style="margin-top:4px">${b('🌐', 'Website', l.website_potential)}${b('🛡', 'Bedarfsanalyse', l.needs_analysis_potential)}${b('🤝', 'Kooperation', l.partnership_potential)}</div>`;
}

/** Zusatzfelder der Anruf-Erfassung: nächster Schritt und Themen (für „Mehrere Themen interessant“). */
export function callExtras(): Safe {
  return html`<label>Nächster Schritt<input name="next_step" maxlength="300" placeholder="z. B. Demo zeigen am Dienstag, Bedarfsanalyse-Termin, Info per E-Mail (nur mit Einwilligung)"></label>
    <div class="row" style="margin-top:4px"><small class="mute">Themen (nur für „Mehrere Themen interessant“, mind. zwei):</small>${TOPICS.map((t) => html`<label class="inline"><input type="checkbox" name="topic" value="${t}"> ${TOPIC_LABEL[t]}</label>`)}</div>`;
}

export function copilotCard(d: any, s: StoredCopilot | null, o: { csrf: string; leadId: string; eligible: boolean; aiAvailable: boolean }): Safe {
  const c = s?.mass as Copilot | null | undefined;
  if (!c) return html`<div class="card" id="verkaufsassistent"><h2>Verkaufsassistent</h2>
    <p class="mute">Für diesen Lead wurde noch keine Gesprächsvorbereitung erzeugt. Automatisch entsteht sie für Priorität A/B, hohe Verkaufschance oder empfohlene Demo${o.eligible ? '' : ' – dieser Lead gehört (noch) nicht dazu'}. Die regelbasierte Fassung ist kostenlos.</p>
    ${postForm(o.csrf, `/leads/${o.leadId}/copilot`, html`<button class="primary">Verkaufsassistent erzeugen</button>`, { style: 'display:block' })}</div>`;
  const deep = s?.deep;
  const summary = deep?.summary30 ?? c.summary30, opener = deep?.opener ?? c.opener.text;
  return html`<div class="card" id="verkaufsassistent"><div class="row"><h2 class="grow" style="margin:0">Verkaufsassistent</h2><small class="mute">${s?.createdAt ? `Stand ${fmt(s.createdAt)} · ` : ''}${deep ? 'vertieft (DEEP)' : 'regelbasiert (MASS, kostenlos)'}</small></div>
    <div class="note"><b>Dieser Lead in 30 Sekunden</b><br>${summary}</div>

    <div style="${sub}"><div class="row"><h3 class="grow" style="margin:0">Ziel dieses Gesprächs</h3><span class="badge ${c.nextAction.code === 'NO_ACTION' ? 'b-bad' : c.nextAction.code === 'MANUAL_RESEARCH' ? 'b-warn' : 'b-ok'}" title="recommended_next_action">Nächste Aktion: ${NEXT_ACTION_LABEL[c.nextAction.code]}</span></div>
      <p><b>${c.goal.text}</b></p><small class="mute">${c.nextAction.reason}<br>${c.goal.note}</small></div>

    <div style="${sub}"><h3 style="margin:0">Persönlicher Gesprächseinstieg</h3><p>${opener}</p>
      ${deep ? html`<small class="mute">KI-formuliert aus denselben Fakten (DEEP). Regelfassung: ${c.opener.text}</small>` : ''}
      <details><summary>So kannst du dich vorstellen</summary><p>${c.introduction}</p></details></div>

    <div style="${sub}"><h3 style="margin:0">A · Website / Digitalisierung <span class="badge ${pcls(c.website.potential)}">${c.website.label}</span></h3>
      <p>${c.website.reason}</p>
      ${c.website.problems.length ? html`<b>Erkennbare Probleme</b><ul>${c.website.problems.map((p) => html`<li>${p.text}${p.evidence ? html`<br><small class="mute">Beleg: ${p.evidence}</small>` : ''}</li>`)}</ul>` : ''}
      ${c.website.modules.length ? html`<b>Passende Module</b><ul>${c.website.modules.map((m) => html`<li>${m.label} <small class="mute">(${m.basis})</small></li>`)}</ul>` : ''}
      <p><b>Demo sinnvoll?</b> ${c.website.demoSensible.text}</p></div>

    <div style="${sub}"><h3 style="margin:0">B · Bedarfsanalyse (eigenständiges Thema) <span class="badge ${pcls(c.needsAnalysis.potential)}" title="needs_analysis_potential: ${c.needsAnalysis.potential}">${NEEDS_SHORT[c.needsAnalysis.potential]} · ${c.needsAnalysis.potential}</span></h3>
      <p>Potenzial für separate Bedarfsanalyse: <b>${NEEDS_LABEL[c.needsAnalysis.potential as Potential]}</b>. ${c.needsAnalysis.reason}</p>
      <b>Offene Fragen (nur vorbereiten, im Gespräch klären)</b>${ul(c.needsAnalysis.questions)}<small class="mute">${c.needsAnalysis.note}</small></div>

    <div style="${sub}"><h3 style="margin:0">C · Kooperation / Leadpartnerschaft <span class="badge ${pcls(c.partnership.potential)}">${c.partnership.potential}</span></h3>
      <p>${c.partnership.reason}</p>
      <b>Mögliche gemeinsame Kundengruppen</b>${ul(c.partnership.customerGroups)}<b>Mögliche Empfehlungsmöglichkeiten</b>${ul(c.partnership.referral)}
      <p><b>Gesprächsfrage:</b> „${c.partnership.question}“</p><small class="mute">${c.partnership.note}</small></div>

    <div style="${sub}"><h3 style="margin:0">Fragen im Gespräch</h3>
      <b>Unternehmen</b>${ul(c.questions.company)}<b>Online-Auftritt</b>${ul(c.questions.online)}<b>Absicherung (nur offene Analysefragen)</b>${ul(c.questions.safeguards)}<b>Kooperation</b>${ul(c.questions.cooperation)}</div>

    <div style="${sub}"><h3 style="margin:0">Deine stärksten Argumente (Website)</h3>
      ${c.arguments.length ? html`<ol>${c.arguments.map((a) => html`<li><b>${a.claim}</b><br><small><b>Beleg</b> (${a.basis}): ${a.evidence}</small><br><small><b>Nutzen:</b> ${a.benefit}</small></li>`)}</ol>` : html`<p class="mute">Aus den vorhandenen Daten ergeben sich keine belegten Argumente – im Gespräch Bedarf klären.</p>`}</div>

    <div style="${sub}"><h3 style="margin:0">So erklärst du die Demo</h3><p>${c.demoPitch.text}</p>
      ${c.demoPitch.points.length ? html`<ul>${c.demoPitch.points.map((p) => html`<li>${p}</li>`)}</ul>` : ''}<small class="mute">${c.demoPitch.note}</small></div>

    <details style="${sub}"><summary><b>Mögliche Einwände und Antworten</b></summary><ul>${c.objections.map((x) => html`<li><b>${x.objection}</b><br>${x.answer}</li>`)}</ul></details>
    <details style="${sub}"><summary><b>Empfohlener Gesprächsablauf</b></summary><ol>${c.flow.map((x) => html`<li>${x}</li>`)}</ol></details>
    <details style="${sub}"><summary><b>Datenlage und Unsicheres</b></summary>${ul(c.facts)}<b>Unsicher / manuell prüfen</b>${ul(c.uncertain)}</details>

    <div class="row">${postForm(o.csrf, `/leads/${o.leadId}/copilot`, html`<button>Neu berechnen</button>`, { style: 'display:inline' })}
      ${postForm(o.csrf, `/leads/${o.leadId}/copilot/deepen`, html`<button ${o.aiAvailable ? raw('') : raw('title="Keine KI konfiguriert – es entstehen keine Kosten, der Regeltext bleibt"')}>Verkaufsassistent vertiefen (DEEP)</button>`, { style: 'display:inline' })}
      <small class="mute">Vertiefen nutzt die KI nur für Einstieg und Zusammenfassung, mit Kostenprotokoll; gleiche Daten → kein erneuter Aufruf.</small></div>
  </div>`;
}

/** Kontaktstrategie prominent oben auf der Lead-Seite: Das System empfiehlt, Kai entscheidet. */
export function strategyCard(d: any, c: Copilot | null | undefined, o: { csrf: string; leadId: string; draft?: EmailDraft | null; hasEmail: boolean; emailStatus?: string }): Safe {
  const manual = d.lead.contact_strategy as ContactStrategy | null; const rec = (c?.contactStrategy.code ?? d.lead.recommended_contact_strategy) as ContactStrategy | null;
  const eff = manual ?? rec;
  return html`<div class="card" id="kontaktstrategie" style="border-left:6px solid var(--brand)"><div class="row"><h2 class="grow" style="margin:0">Kontaktstrategie</h2>
      <span class="badge ${eff === 'NO_CONTACT' ? 'b-bad' : eff === 'MANUAL_RESEARCH' ? 'b-warn' : 'b-ok'}" title="contact_strategy">${eff ? CONTACT_STRATEGY_LABEL[eff] : 'noch keine Empfehlung'}</span><small class="mute">${manual ? 'von dir gewählt' : 'Empfehlung des Systems'}</small></div>
    ${rec ? html`<p><b>Empfehlung:</b> ${CONTACT_STRATEGY_LABEL[rec]} – ${c?.contactStrategy.reason ?? ''}</p>` : ''}
    ${c ? html`<p><b>Gesprächsstrategie:</b> ${c.strategy.label} <small class="mute">(${c.strategy.reason})</small>${c.strategy.secondary.length ? html`<br><small>Nebenthemen: ${c.strategy.secondary.map((x) => `${x.topic === 'WEBSITE' ? 'Website' : x.topic === 'BEDARFSANALYSE' ? 'Bedarfsanalyse' : 'Partnerschaft'} – ${x.text}`).join(' · ')}</small>` : ''}</p>` : ''}
    ${postForm(o.csrf, `/leads/${o.leadId}/strategy`, html`<div class="resgrid">${CONTACT_STRATEGIES.map((s) => html`<button name="strategy" value="${s}" class="${manual === s ? 'primary' : ''}" title="${CONTACT_STRATEGY_HELP[s]}">${CONTACT_STRATEGY_LABEL[s]}</button>`)}</div>
      <p><button name="strategy" value="">Empfehlung des Systems übernehmen</button> <small class="mute">${eff ? CONTACT_STRATEGY_HELP[eff] : ''} Es wird nichts automatisch ausgeführt oder gesendet.</small></p>`, { style: 'display:block' })}
    ${eff === 'EMAIL_DRAFT' && o.draft ? html`<div class="note"><b>E-Mail-Entwurf</b> <small class="mute">(${o.hasEmail ? `E-Mail-Status: ${o.emailStatus ?? '–'}` : 'keine E-Mail-Adresse bekannt'})</small><br><b>Betreff:</b> ${o.draft.subject}<pre style="white-space:pre-wrap;font:inherit;margin:6px 0">${o.draft.body}</pre>${o.draft.notices.map((n) => html`<small class="mute">• ${n}</small><br>`)}</div>` : ''}
  </div>`;
}

/** Partner-Bereich auf der Lead-Seite: Status, passender aktiver Partner (nur Vorschlag), Weitergabe nur nach Bestätigung. */
export function partnerLeadCard(d: any, o: { csrf: string; leadId: string; partner: any | null; matches: any[]; referrals: any[]; talk: Copilot['partnerTalk'] }): Safe {
  return html`<div class="card" id="partner"><h2>Partner</h2>
    <p class="mute">Partnerschaft ist ein eigenständiges Kooperationsmodell – unabhängig von Website-Kauf und Bedarfsanalyse.</p>
    ${o.partner ? html`<p><b>Status:</b> <span class="badge b-info">${PARTNER_LABEL[o.partner.status as PartnerStatus]}</span> <a class="btn" href="/partners/${o.partner.id}">Partnerprofil öffnen</a></p>`
      : html`<p>Kein Partnerprofil. ${postForm(o.csrf, `/leads/${o.leadId}/partner/candidate`, html`<button>Als Partner-Kandidat vormerken</button>`)}</p>`}
    ${o.matches.length ? html`<div class="note"><b>Passender Partner vorhanden.</b> ${o.matches.map((m) => html`${m.company_name}`).join(', ')} (aktiver Partner, passende Branche/Region).<br>${o.matches.map((m) => postForm(o.csrf, `/leads/${o.leadId}/referral`, html`<input type="hidden" name="partner" value="${m.id}"><button class="primary">Lead an ${m.company_name} weiterleiten …</button>`))}<br><small class="mute">Es wird nichts automatisch weitergeleitet: Du prüfst Empfänger, Daten und Rechtsgrundlage und bestätigst.</small></div>` : html`<p class="mute">Kein passender aktiver Partner gefunden.</p>`}
    ${o.referrals.length ? html`<b>Referrals zu diesem Lead</b><ul>${o.referrals.map((r) => html`<li><a href="/referrals/${r.id}">${r.destination_name ?? r.source_name ?? 'Partner'}</a> – ${REFERRAL_STATUS_LABEL[r.status] ?? r.status}</li>`)}</ul>` : ''}
    ${o.talk ? html`<details open><summary>Partnergespräch (Vorschlag)</summary><p>${o.talk.intro}</p><b>Fragen</b><ul>${o.talk.questions.map((q) => html`<li>${q}</li>`)}</ul><small class="mute">${o.talk.note}</small></details>` : ''}
  </div>`;
}

/** Demo-Kategorie (Kai entscheidet) + schnelle Standard-Demo (nur nach deiner Bestätigung). */
export function demoStageCard(o: { csrf: string; leadId: string; stage: DemoStage; manual: string | null; hasDemo: boolean; families: { key: string; label: string; hint: string }[]; autoFamily: string; demoUrl?: string }): Safe {
  return html`<div class="card" id="demo-stufe"><div class="row"><h2 class="grow" style="margin:0">Demo</h2><span class="badge ${o.stage === 'NO_DEMO' ? '' : 'b-ok'}">${DEMO_STAGE_LABEL[o.stage]}</span>${o.demoUrl ? html`<a class="btn" href="${o.demoUrl}" target="_blank" rel="noopener noreferrer">Demo ansehen</a>` : ''}</div>
    <p class="mute">${DEMO_STAGE_HELP[o.stage]} Das System empfiehlt – du entscheidest.</p>
    ${postForm(o.csrf, `/leads/${o.leadId}/demo/stage`, html`<div class="resgrid">${DEMO_STAGES.filter((s) => s !== 'DEMO_CREATED').map((s) => html`<button name="stage" value="${s}" class="${o.manual === s ? 'primary' : ''}" ${s === 'DEMO_SHOWN' && !o.hasDemo ? raw('disabled title="Erst eine Demo erstellen"') : ''}>${DEMO_STAGE_LABEL[s]}</button>`)}</div>
      <p><button name="stage" value="">Empfehlung des Systems übernehmen</button></p>`, { style: 'display:block' })}
    ${o.hasDemo ? '' : html`<details><summary>Schnelle Standard-Demo</summary>
      <p class="mute">Hochwertiges Grundtemplate mit den Daten dieses Leads (Name, Branche, Telefon, Adresse, Öffnungszeiten, Leistungen soweit vorhanden) und passenden Bausteinen – in wenigen Sekunden: „So könnte Ihr Unternehmen online aussehen.“ Es wird nichts veröffentlicht oder gesendet.</p>
      ${postForm(o.csrf, `/leads/${o.leadId}/demo/quick`, html`<div class="stack">${o.families.map((f) => html`<label class="inline"><input type="radio" name="family" value="${f.key}" ${f.key === o.autoFamily ? raw('checked') : ''}> <b>${f.label}</b>${f.key === o.autoFamily ? ' (passt zur Branche)' : ''} <small class="mute">${f.hint}</small></label>`)}</div>
        <label class="inline"><input type="checkbox" name="confirm" value="1"> Ich bestätige: Standard-Demo für diesen Lead erstellen.</label><p><button class="primary">Standard-Demo erstellen</button></p>`, { style: 'display:block' })}</details>`}
  </div>`;
}
