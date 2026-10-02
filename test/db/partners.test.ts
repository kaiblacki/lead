import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { seededApp, skip, type App } from './helpers.ts';

/** Phase A: Partnerstatus, geprüfte Weitergabe (Referrals), Kontaktstrategie. Nichts wird gesendet oder automatisch weitergegeben. */
const apps: App[] = []; after(async () => { for (const a of apps) await a.close(); });
const page = async (app: App, path: string) => app.text(await (await app.get(path)).text());
const callable = async (app: App) => (await app.ctx.leads.list({ limit: 100 })).rows.filter((l: any) => l.work_status === 'CONTACTABLE' && l.phone);

test('Partner-Lebenszyklus: Kandidat aus Lead (idempotent), Voraussetzungen für Stadien, Statusverlauf, aktiver Partner mit Startdatum; gesperrte Leads nie', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000471'); apps.push(app);
  const [a, b] = await callable(app);
  const r1 = await app.post(`/leads/${a.id}/partner/candidate`, {}); assert.equal(r1.status, 303);
  const p = await app.ctx.partners.forLead(a.id); assert.ok(p); assert.equal(p.status, 'PARTNER_CANDIDATE'); assert.equal(p.company_name, a.company_name);
  assert.equal((await app.ctx.partners.fromLead(a.id)).created, false, 'idempotent');
  assert.equal(await app.ctx.partners.statusForLead(a.id), 'PARTNER_CANDIDATE'); assert.equal(await app.ctx.partners.statusForLead(b.id), 'NONE');
  await assert.rejects(app.ctx.partners.setStatus(p.id, 'ACTIVE_PARTNER'), /nicht vorgesehen/);
  await app.ctx.partners.setStatus(p.id, 'PARTNER_DISCUSSION', 'Erstes Gespräch');
  await assert.rejects(app.ctx.partners.setStatus(p.id, 'PARTNER_APPROVED'), /Voraussetzung fehlt/);
  await app.ctx.partners.setCriteria(p.id, { conversation_held: true, referral_willingness: true }); await app.ctx.partners.setStatus(p.id, 'PARTNER_APPROVED');
  await assert.rejects(app.ctx.partners.setStatus(p.id, 'ACTIVE_PARTNER'), /Kooperationsvereinbarung/);
  await app.ctx.partners.setCriteria(p.id, { conversation_held: true, referral_willingness: true, agreement: true, contact_person_known: true }); await app.ctx.partners.setStatus(p.id, 'ACTIVE_PARTNER');
  const act = await app.ctx.partners.get(p.id); assert.equal(act.status, 'ACTIVE_PARTNER'); assert.ok(act.started_at);
  assert.equal((await app.ctx.partners.log(p.id)).length, 4); await app.ctx.partners.setStatus(p.id, 'PAUSED_PARTNER'); await app.ctx.partners.setStatus(p.id, 'ACTIVE_PARTNER');
  // gesperrter Lead
  await app.pool.query('update leads set contact_blocked=true where id=$1', [b.id]); await assert.rejects(app.ctx.partners.fromLead(b.id), /gesperrt/);
  // Seiten
  assert.match(await page(app, '/partners'), /Partner/); const prof = await page(app, `/partners/${p.id}`); for (const t of ['Partnerstatus', 'Kriterien einer Kooperation', 'Leads übermittelt', 'Verlauf']) assert.ok(prof.includes(t), t);
  assert.ok(!/versicher/i.test(prof.replace(/nicht: Versicherungsabschluss/g, '').replace(/weder von einem Versicherungsabschluss/g, '')), 'Partnerprofil enthält keine Versicherungskriterien');
  assert.match(await page(app, `/leads/${a.id}`), /Partnerprofil öffnen/);
});

test('Referral: Vorschlag → Prüfung/Bestätigung mit Rechtsgrundlage → manuell weitergegeben → Ergebnis; nie automatisch, Kontaktwege nur ausdrücklich, Sperren und Nicht-Aktive blockiert', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000472'); apps.push(app);
  const [a, b, c] = await callable(app);
  const pid = await app.ctx.partners.create({ company_name: 'Elektro Meier', industry: 'elektriker', region: a.city, contact_person: 'Herr Meier', lead_industries: [a.sub_industry] });
  await assert.rejects(app.ctx.partners.proposeOutgoing(a.id, pid), /aktive Partner/);
  await app.ctx.partners.setCriteria(pid, { conversation_held: true, referral_willingness: true, agreement: true, contact_person_known: true });
  for (const to of ['PARTNER_DISCUSSION', 'PARTNER_APPROVED', 'ACTIVE_PARTNER'] as const) await app.ctx.partners.setStatus(pid, to);
  const m = await app.ctx.partners.matchesForLead(a.id); assert.equal(m.length, 1); assert.equal(m[0].id, pid);
  assert.match(await page(app, `/leads/${a.id}`), /Passender Partner vorhanden/); assert.match(await page(app, `/leads/${a.id}`), /weiterleiten/);
  const res = await app.post(`/leads/${a.id}/referral`, { partner: pid }); assert.equal(res.status, 303); const refId = res.headers.get('location')!.split('/').pop()!;
  const ref0 = await app.ctx.partners.referralById(refId); assert.equal(ref0.status, 'PROPOSED'); assert.deepEqual(ref0.shared_fields, {}, 'noch nichts übermittelt');
  const conf = await page(app, `/referrals/${refId}`); for (const t of ['Weitergabe prüfen und bestätigen', 'Elektro Meier', 'Rechtsgrundlage', 'nichts automatisch gesendet']) assert.ok(conf.includes(t), t);
  const raw = await (await app.get(`/referrals/${refId}`)).text(); assert.match(raw, /value="company_name" checked/); assert.doesNotMatch(raw, /value="phone" checked/); assert.doesNotMatch(raw, /value="email" checked/);
  await assert.rejects(app.ctx.partners.confirm(refId, { fields: ['company_name', 'city'], legalBasis: '', reviewed: true }), /Rechtsgrundlage/);
  await assert.rejects(app.ctx.partners.confirm(refId, { fields: ['company_name'], legalBasis: 'Zustimmung des Inhabers im Telefonat', reviewed: false }), /geprüft/);
  await assert.rejects(app.ctx.partners.confirm(refId, { fields: ['city'], legalBasis: 'Zustimmung des Inhabers im Telefonat', reviewed: true }), /Firmenname/);
  await assert.rejects(app.ctx.partners.markSent(refId), /bestätigtes/);
  const out = await app.ctx.partners.confirm(refId, { fields: ['company_name', 'industry', 'city'], legalBasis: 'Zustimmung des Inhabers im Telefonat am 12.10.', reviewed: true, note: 'Sucht Elektriker' });
  assert.equal(out.containsContact, false); const ref1 = await app.ctx.partners.referralById(refId); assert.equal(ref1.status, 'CONFIRMED'); assert.equal(ref1.shared_fields.company_name, a.company_name); assert.equal(ref1.shared_fields.note, 'Sucht Elektriker'); assert.equal(ref1.shared_fields.phone, undefined);
  await assert.rejects(app.ctx.partners.setOutcome(refId, { contacted: true }), /nach der Weitergabe/);
  await app.ctx.partners.markSent(refId); await app.ctx.partners.setOutcome(refId, { accepted: true, contacted: true, converted: true, estimatedValueCents: 150000, notes: 'Auftrag erhalten' }); await app.ctx.partners.close(refId);
  const st = await app.ctx.partners.stats(pid); assert.equal(st.outgoing, 1); assert.equal(st.conversations, 1); assert.equal(st.converted, 1); assert.equal(st.value_cents, 150000);
  const done = await page(app, `/referrals/${refId}`); assert.match(done, /Übermittelte Daten/); assert.match(done, /Zustimmung des Inhabers/);
  // Kontaktwege nur ausdrücklich
  const ref2 = await app.ctx.partners.proposeOutgoing(b.id, pid); const o2 = await app.ctx.partners.confirm(ref2, { fields: ['company_name', 'phone'], legalBasis: 'Einwilligung liegt schriftlich vor', reviewed: true }); assert.equal(o2.containsContact, true);
  assert.equal((await app.ctx.partners.referralById(ref2)).shared_fields.phone, b.phone);
  // gesperrt / Nicht-Aktive / Abbruch
  await app.pool.query('update leads set contact_blocked=true where id=$1', [c.id]); await assert.rejects(app.ctx.partners.proposeOutgoing(c.id, pid), /Gesperrter Lead/);
  assert.equal((await app.ctx.partners.matchesForLead(c.id)).length, 0);
  const ref3 = await app.ctx.partners.proposeOutgoing(a.id, pid); await app.ctx.partners.setStatus(pid, 'PAUSED_PARTNER'); await assert.rejects(app.ctx.partners.confirm(ref3, { fields: ['company_name'], legalBasis: 'Einwilligung liegt vor (Datum)', reviewed: true }), /kein aktiver Partner/);
  await app.ctx.partners.cancel(ref3); assert.equal((await app.ctx.partners.referralById(ref3)).status, 'CANCELLED');
  // eingehende Empfehlung
  await app.ctx.partners.recordIncoming(pid, { companyName: 'Bäckerei Schmitt', notes: 'Kennt uns durch Herrn Meier', estimatedValueCents: 79000 }); assert.equal((await app.ctx.partners.stats(pid)).incoming, 1);
  assert.equal((await app.pool.query('select count(*)::int n from outbox')).rows[0].n, 0, 'nichts gesendet');
  assert.match(await page(app, '/referrals'), /Referrals/);
});

test('Keine Versicherungs-Kopplung: Partnernotizen und Referral-Notizen mit Rabatt-/Versicherungsbezug werden abgelehnt', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000473', { n: 6 }); apps.push(app);
  const pid = await app.ctx.partners.create({ company_name: 'Muster GmbH' });
  await assert.rejects(app.ctx.partners.update(pid, { notes: 'Gibt 50 % Website-Rabatt bei Versicherungsabschluss' }), /Kopplung/);
  await assert.rejects(app.ctx.partners.recordIncoming(pid, { companyName: 'X', notes: 'Rabatt, wenn er eine Versicherung abschließt' }), /Kopplung/);
  await app.ctx.partners.update(pid, { notes: 'Gegenseitige Empfehlungen im Bereich Handwerk' }); assert.equal((await app.ctx.partners.get(pid)).notes, 'Gegenseitige Empfehlungen im Bereich Handwerk');
});

test('Kontaktstrategie: Empfehlung des Systems, Kai entscheidet (setzen/zurücksetzen); steuert „Heute anrufen“ (CALL ja, NO_CONTACT/EMAIL_DRAFT nein, CALL_AND_DEMO erst mit Demo); E-Mail-Entwurf wird angezeigt, nichts gesendet', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000474'); apps.push(app);
  const rows = await callable(app); const [a, b, c, d] = rows; for (const l of [a, b, c, d]) await app.ctx.copilot.ensure(l.id, { force: true });
  const lead = async (id: string) => (await app.pool.query('select contact_strategy, recommended_contact_strategy, conversation_strategy from leads where id=$1', [id])).rows[0];
  const l0 = await lead(a.id); assert.ok(l0.recommended_contact_strategy && l0.conversation_strategy); assert.equal(l0.contact_strategy, null, 'ohne Entscheidung nur Empfehlung');
  assert.equal((await app.post(`/leads/${a.id}/strategy`, { strategy: 'EMAIL_DRAFT' })).status, 303); assert.equal((await lead(a.id)).contact_strategy, 'EMAIL_DRAFT');
  const pg = await page(app, `/leads/${a.id}`); for (const t of ['Kontaktstrategie', 'von dir gewählt', 'E-Mail-Entwurf', 'Betreff:', 'nichts gesendet', 'Empfehlung des Systems übernehmen', 'Gesprächsstrategie']) assert.ok(pg.includes(t), t);
  await assert.rejects(app.ctx.copilot.setContactStrategy(a.id, 'SPAM'), /Unbekannte/);
  const q1 = await app.ctx.calls.queue(); const inQ = (id: string) => q1.items.some((x: any) => x.id === id);
  // Standard (null) und CALL erscheinen, EMAIL_DRAFT / NO_CONTACT / MANUAL_RESEARCH / DEMO_FIRST nicht, CALL_AND_DEMO erst mit Demo
  await app.ctx.copilot.setContactStrategy(b.id, 'CALL'); await app.ctx.copilot.setContactStrategy(c.id, 'NO_CONTACT'); await app.ctx.copilot.setContactStrategy(d.id, 'CALL_AND_DEMO');
  const q2 = await app.ctx.calls.queue(); const has = (id: string) => q2.items.some((x: any) => x.id === id);
  assert.ok(!has(a.id), 'EMAIL_DRAFT nicht in „Heute anrufen“'); assert.ok(has(b.id), 'CALL'); assert.ok(!has(c.id), 'NO_CONTACT'); assert.ok(!has(d.id), 'CALL_AND_DEMO ohne Demo');
  await app.ctx.docs.demoFor(d.id, 'auto'); const q3 = await app.ctx.calls.queue(); assert.ok(q3.items.some((x: any) => x.id === d.id), 'CALL_AND_DEMO mit Demo');
  void inQ; await app.ctx.copilot.setContactStrategy(a.id, null); assert.equal((await lead(a.id)).contact_strategy, null); assert.ok((await app.ctx.calls.queue()).items.some((x: any) => x.id === a.id), 'Empfehlung gilt wieder');
  const calls = await page(app, '/calls'); assert.ok(calls.includes('Hauptstrategie') && calls.includes('Websiteargumente'), 'Telefonansicht zeigt Hauptstrategie und Argumente');
  assert.equal((await app.pool.query('select count(*)::int n from outbox')).rows[0].n, 0, 'nichts gesendet');
});
