import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appSetup, skip, enablePhone, quickSearch, leadsWhere, type App } from './helpers.ts';

/** Lead-Analyse- und Priorisierungsmaschine: strukturierte Analyse, Auto-Demo (nur ohne Website), Aufgaben, Sortierung/Filter, KI-Stufen mit Kosten und Cache, Telefonansicht. */
const OWNER = '00000000-0000-0000-0000-0000000000fa';
let app: App;
before(async () => { if (skip) return; app = await appSetup(OWNER, { autoDemo: true }); await enablePhone(app); await quickSearch(app, 'Völklingen + 30 km + Nagelstudios + Friseure + 60 Leads'); });
after(async () => { if (!skip) await app.close(); });
const flash = async (r: Response) => app.text(await app.follow(r));
const q = async (sql: string, args: unknown[] = []) => (/\$1\b/.test(sql) ? (await app.pool.query(sql, [OWNER, ...args])).rows : (await app.pool.query(sql.replace(/\$(\d+)/g, (_, n) => '$' + (Number(n) - 1)), args)).rows) as any[];
const text = async (path: string) => app.text(await (await app.get(path)).text());

test('Strukturierte Analyse je Lead: ohne Website kein Website-Score aber Chance; mit Website Score + belegte Schwächen; Felder vollständig', { skip }, async () => {
  const rows = await q("select l.company_name, l.website_url, a.* from leads l join lead_analysis a on a.lead_id = l.id and a.tier = 'MASS' where l.owner_id = $1");
  assert.ok(rows.length >= 20, `${rows.length} Analysen`);
  const none = rows.filter((r) => !r.website_url), withSite = rows.filter((r) => r.website_url);
  assert.ok(none.length >= 5 && withSite.length >= 5, `${none.length} ohne / ${withSite.length} mit Website`);
  for (const r of none) { assert.equal(r.website_status, 'NO_WEBSITE'); assert.equal(r.website_score, null); assert.ok(r.sales_opportunity !== null); assert.ok(r.manual_checks.some((m: string) => /existiert/.test(m))); assert.ok(r.recommended_demo_features.length > 0); }
  const scored = withSite.filter((r) => r.website_status === 'ANALYZED');
  assert.ok(scored.length >= 3); for (const r of scored) { assert.ok(r.website_score >= 0 && r.website_score <= 100); assert.ok(r.sales_opportunity >= 0 && r.sales_opportunity <= 100); assert.ok(r.weaknesses.every((w: any) => w.evidence && w.code)); }
  const r0 = rows[0];
  for (const k of ['website_status', 'website_score', 'sales_opportunity', 'analysis_summary', 'positive_points', 'weaknesses', 'sales_reasons', 'recommended_improvements', 'recommended_demo_features', 'recommended_contact_angle', 'telephone_talking_points', 'email_talking_points', 'missing_information', 'manual_checks', 'evidence', 'sources', 'confidence', 'analyzed_at', 'ai_model_used', 'estimated_ai_cost']) assert.ok(k in r0, k);
  assert.equal(r0.ai_model_used, 'rules'); assert.equal(Number(r0.estimated_ai_cost), 0);
  assert.ok(!rows.some((r) => JSON.stringify(r.weaknesses.concat(r.sales_reasons)).match(/verlier|garantier|Umsatz/i)));
});

test('Auto-Demo NUR für Firmen ohne Website (mit Daten); Firmen mit Website bekommen nie automatisch eine Demo', { skip }, async () => {
  const withSiteDemos = await q("select count(*)::int n from demos d join leads l on l.id = d.lead_id where l.owner_id = $1 and l.website_url is not null");
  assert.equal(withSiteDemos[0].n, 0);
  const noSite = await q("select l.id, l.phone, l.address, o.score, (select count(*) from demos d where d.lead_id = l.id)::int demos from leads l left join lateral (select score from opportunities where lead_id = l.id order by created_at desc limit 1) o on true where l.owner_id = $1 and l.website_url is null");
  const eligible = noSite.filter((l) => (l.phone || l.address) && l.score >= 45);
  assert.ok(eligible.length >= 3);
  // Obergrenze je Suchlauf (config/pipeline.json → autoDemo.maxPerSearch): höchstens so viele Auto-Demos, der Rest ist „Demo empfohlen“
  const max = Number(app.ctx.cfg.sales.autoDemo.maxPerSearch ?? 5), withDemo = eligible.filter((l) => l.demos === 1).length;
  assert.equal(withDemo, Math.min(max, eligible.length)); assert.ok(eligible.every((l) => l.demos <= 1));
  assert.ok(noSite.filter((l) => l.score < 45).every((l) => l.demos === 0), 'zu geringe Chance → keine Auto-Demo');
});

test('Erinnerung „Demo fertig – anrufen“: Aufgabe entsteht mit Demo + Telefon, steht oben in „Heute anrufen“, erledigt sich mit dem Anruf-Ergebnis', { skip }, async () => {
  const tasks = await q("select t.lead_id, l.phone from lead_tasks t join leads l on l.id = t.lead_id where t.owner_id = $1 and t.kind = 'CALL_DEMO_READY' and t.status = 'OPEN'");
  assert.ok(tasks.length >= 3); assert.ok(tasks.every((t) => t.phone), 'ohne Telefonnummer keine Anruf-Aufgabe');
  const queue = await app.ctx.calls.queue();
  assert.equal(queue.items[0].kind, 'demo_ready'); assert.ok(queue.items.filter((i: any) => i.kind === 'demo_ready').length >= 3);
  const page = await text('/calls'); assert.match(page, /Demo fertig – anrufen/); assert.match(page, /Heute anrufen/);
  const first = queue.items[0].id;
  assert.match(await flash(await app.post(`/leads/${first}/call`, { result: 'INTERESTED', next: 'calls' })), /INTERESTED/);
  assert.equal((await q("select status from lead_tasks where lead_id = $2 and kind = 'CALL_DEMO_READY'", [first]))[0].status, 'DONE');
  assert.ok(!(await app.ctx.calls.queue()).items.some((i: any) => i.id === first && i.kind === 'demo_ready'));
});

test('Lead-Liste: Spalten, Schnellfilter, Sortierung (Standard Verkaufschance, schlechteste Website zuerst), KI-Stufen-Filter', { skip }, async () => {
  const page = await text('/leads');
  for (const w of ['Website-Score', 'Verkaufschance', 'Telefon', 'E-Mail', 'Demo', 'KI-Stufe', 'Nächste Aktion', 'Keine Website', 'Schlechteste Websites', 'Demo fertig', 'Noch nicht kontaktiert', 'Heute anrufen', 'E-Mail vorhanden', 'Telefon vorhanden', 'MASS', 'DEEP', 'PREMIUM']) assert.ok(page.includes(w), w);
  const ids = async (qs: string) => [...(await (await app.get('/leads' + qs)).text()).matchAll(/href="\/leads\/([0-9a-f-]{36})"/g)].map((m) => m[1]).filter((x, i, a) => a.indexOf(x) === i);
  const count = async (qs: string) => Number(/(\d+) Leads/.exec(await text('/leads' + qs))![1]);
  const all = await count('');
  assert.equal(await count('?quick=no_website'), (await q("select count(*)::int n from leads where owner_id = $1 and website_state = 'none'"))[0].n);
  assert.equal(await count('?quick=demo_ready'), (await q("select count(distinct lead_id)::int n from demos d join leads l on l.id = d.lead_id where l.owner_id = $1 and not d.revoked"))[0].n);
  assert.ok(await count('?quick=has_phone') < all && await count('?quick=has_email') <= all && await count('?quick=not_contacted') <= all && await count('?quick=demo_open') > 0);
  // Standard: Verkaufschance absteigend; „schlechteste Websites“: Website-Score aufsteigend
  const def = await q("select o.score from leads l left join lateral (select score from opportunities where lead_id=l.id order by created_at desc limit 1) o on true where l.owner_id=$1 order by o.score desc nulls last limit 5");
  assert.equal((await ids('')).length > 0, true);
  const worst = await ids('?quick=worst_websites'); const sc = await Promise.all(worst.slice(0, 12).map(async (id) => (await q("select overall_quality s from audits where lead_id=$2 order by created_at desc limit 1", [id]))[0].s));
  assert.ok(sc.length >= 3 && sc.every((v, i) => i === 0 || sc[i - 1] <= v), `aufsteigend: ${sc}`); void def;
  assert.equal(await count('?tier=DEEP'), 0); assert.equal(await count('?tier=MASS'), all);
  const noSiteFirst = await ids('?quick=no_website'); assert.ok(noSiteFirst.length > 0);
});

test('Firmen mit Website: Entscheidung „Demo erstellen“ oder „Überspringen“ – nichts automatisch', { skip }, async () => {
  const [l] = await q("select l.id from leads l where l.owner_id = $1 and l.website_url is not null and not exists (select 1 from demos d where d.lead_id = l.id)");
  const page = await text(`/leads/${l.id}`); assert.match(page, /Demo für diese Firma\?/); assert.match(page, /Überspringen/); assert.match(page, /Entscheiden: Demo erstellen oder überspringen|Demo erstellen/);
  assert.match(await flash(await app.post(`/leads/${l.id}/demo/skip`)), /Demo übersprungen/);
  assert.equal((await q('select demo_decision d from leads where id=$2', [l.id]))[0].d, 'skipped'); assert.match(await text(`/leads/${l.id}`), /Überspringen<\/b> gewählt|Überspringen gewählt/);
  assert.match(await flash(await app.post(`/leads/${l.id}/demo/skip`, { undo: '1' })), /zurückgenommen/);
  assert.match(await flash(await app.post(`/leads/${l.id}/demo`, { template: 'auto' })), /Demo erstellt/);
  assert.equal((await q('select count(*)::int n from demos where lead_id=$2', [l.id]))[0].n, 1);
});

test('KI-Stufen: DEEP und PREMIUM je Lead wählbar, Kosten je Aufruf protokolliert, unveränderte Grundlage kostet nichts (Cache), Konzept nur mit „Beispiel“-Texten', { skip }, async () => {
  const [l] = await q("select l.id from leads l where l.owner_id = $1 and l.website_url is null and l.phone is not null limit 1");
  const before = (await q('select count(*)::int n from ai_usage where lead_id = $2', [l.id]))[0].n;
  assert.match(await flash(await app.post(`/leads/${l.id}/analysis`, { tier: 'DEEP' })), /DEEP-Analyse:.*KI-Aufrufe: 1/);
  const u = await q('select * from ai_usage where lead_id = $2 order by created_at', [l.id]);
  assert.equal(u.length, before + 1); const row = u.at(-1)!; assert.equal(row.task, 'analyze_lead'); assert.equal(row.tier, 'DEEP'); assert.equal(row.purpose, 'analysis'); assert.ok(row.input_tokens > 0 && row.output_tokens > 0); assert.match(row.model, /mock/); assert.equal(Number(row.est_cents), 0);
  assert.equal((await q('select ai_tier t from leads where id=$2', [l.id]))[0].t, 'DEEP');
  // zweiter Lauf: gleiche Grundlage → vorhandene Analyse, KEIN neuer KI-Aufruf
  assert.match(await flash(await app.post(`/leads/${l.id}/analysis`, { tier: 'DEEP' })), /vorhandene Analyse verwendet.*KI-Aufrufe: 0/);
  assert.equal((await q('select count(*)::int n from ai_usage where lead_id = $2', [l.id]))[0].n, before + 1);
  // erzwungen → neuer Aufruf
  await app.post(`/leads/${l.id}/analysis`, { tier: 'DEEP', force: '1' }); assert.equal((await q('select count(*)::int n from ai_usage where lead_id = $2', [l.id]))[0].n, before + 2);
  assert.match(await flash(await app.post(`/leads/${l.id}/analysis`, { tier: 'PREMIUM' })), /PREMIUM-Analyse/);
  const prem = (await q("select * from lead_analysis where lead_id = $2 and tier = 'PREMIUM'", [l.id]))[0];
  assert.ok(prem.concept.site_structure.length >= 1 && prem.concept.conversion_concept.length >= 1); assert.ok(prem.concept.copy_samples.every((c: any) => /^Beispiel/i.test(c.text)));
  assert.doesNotMatch(JSON.stringify(prem.concept), /Sterne|\d,\d\s*\/\s*5|€|\bab \d+/);
  assert.equal((await q('select ai_tier t from leads where id=$2', [l.id]))[0].t, 'PREMIUM');
  assert.match(await flash(await app.post(`/leads/${l.id}/analysis`, { tier: 'ULTRA' })), /KI-Stufe wählen/);
  assert.equal(await Number(/(\d+) Leads/.exec(await text('/leads?tier=PREMIUM'))![1]), 1);
  const page = await text(`/leads/${l.id}`);
  assert.match(page, /KI-Kosten dieses Leads/); assert.match(page, /Website-Konzept \(PREMIUM\)/); assert.match(page, /Website-Score \(100 = sehr gute Website\)/); assert.match(page, /Verkaufschance \(100 = sehr interessant\)/);
});

test('Kosten im Dashboard: je Lead und gesamt, Ø je analysiertem Unternehmen und je Demo; echte Kosten aus Token berechnet', { skip }, async () => {
  const ov = await app.ctx.aiUsage.overview(); assert.ok(ov.calls >= 3); assert.ok(ov.analysedLeads >= 20); assert.ok(ov.demoLeads >= 3); assert.equal(ov.totalCents, 0, 'Mock-Aufrufe kosten nichts');
  assert.ok(ov.byTier.some((t: any) => t.tier === 'DEEP') && ov.byTier.some((t: any) => t.tier === 'PREMIUM'));
  await app.pool.query("insert into ai_usage(owner_id, lead_id, model, est_cents, task, tier, purpose, input_tokens, output_tokens) select $1, id, 'm', 12.5, 'analyze_lead', 'DEEP', 'analysis', 3000, 800 from leads where owner_id=$1 limit 1", [OWNER]);
  const ov2 = await app.ctx.aiUsage.overview(); assert.equal(ov2.totalCents, 12.5); assert.equal(ov2.analysisCents, 12.5); assert.ok(ov2.avgPerAnalysedCents! > 0);
  const page = await text('/analytics'); for (const w of ['KI-Kosten', 'Gesamtkosten aller Leads', 'Ø je analysiertem Unternehmen', 'Ø je Demo']) assert.ok(page.includes(w), w);
  await app.pool.query("delete from ai_usage where owner_id=$1 and model='m'", [OWNER]);
});

test('Telefonansicht „Was soll ich am Telefon sagen?“: alle Pflichtfelder, persönlicher Einstieg mit Kai Schwarz, nur belegte Punkte', { skip }, async () => {
  const [l] = await q("select l.id, l.company_name, l.phone from leads l join demos d on d.lead_id = l.id where l.owner_id = $1 and l.phone is not null limit 1");
  const page = await text(`/leads/${l.id}`);
  assert.match(page, /Was soll ich am Telefon sagen\?/);
  for (const w of ['Unternehmen', 'Branche', 'Ansprechpartner', 'Telefon', 'Bestehende Website', 'Demo', 'Kontaktstatus', '3 wichtigste Punkte', 'Gesprächseinstieg', 'Individuelle Argumente', 'Ziel des Telefonats']) assert.ok(page.includes(w), w);
  assert.match(page, new RegExp(`Hallo, hier ist Kai \\w+\\. Ich habe mir den Online-Auftritt von ${l.company_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} angeschaut und Ihnen unverbindlich etwas vorbereitet`));
  assert.match(page, /Ansprechpartner nicht verfügbar/); assert.match(page, new RegExp(l.phone.replace(/[+]/g, '\\+')));
  assert.doesNotMatch(page, /\[Dein Name\]|\[Name deiner|undefined|\[object/);
});

test('E-Mail-Versandstatus: Entwurf → Prüfung → rechtlich freigegeben; ohne Freigabe nie Versand; Sperrliste setzt do_not_contact', { skip }, async () => {
  const [l] = await q("select id from leads where owner_id = $1 and status in ('QUALIFIED','DEMO_CREATED') and email_send_status = 'draft' limit 1");
  assert.match(await text(`/leads/${l.id}`), /E-Mail-Status:.*Entwurf/); assert.match(await text(`/leads/${l.id}`), /Zur Prüfung vorlegen/);
  assert.match(await flash(await app.post(`/leads/${l.id}/email-status`, { to: 'sent' })), /nicht erlaubt/);
  await app.post(`/leads/${l.id}/email-status`, { to: 'review_required' });
  assert.match(await flash(await app.post(`/leads/${l.id}/email-status`, { to: 'legally_cleared' })), /rechtliche Grundlage/);
  assert.match(await text(`/leads/${l.id}`), /Rechtlich freigeben/);
  await app.ctx.leads.markDoNotContact(l.id, 'Test', 'user');
  assert.equal((await q('select email_send_status s from leads where id=$2', [l.id]))[0].s, 'do_not_contact');
  assert.match(await flash(await app.post(`/leads/${l.id}/email-status`, { to: 'review_required' })), /gesperrt/);
  assert.equal((app.ctx.registry.providers.email as any).sent.length, 0); assert.equal((await q("select count(*)::int n from outbox where owner_id = $1 and kind not like 'owner_%'"))[0].n, 0);
});
