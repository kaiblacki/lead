import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appSetup, skip, enablePhone, quickSearch, leadsWhere, type App } from './helpers.ts';

const OWNER = '00000000-0000-0000-0000-0000000000f1';
let app: App;
before(async () => { if (skip) return; app = await appSetup(OWNER, { cfgDir: 'config.mock' }); await enablePhone(app); await quickSearch(app, 'Völklingen + 30 km + Nagelstudios'); await quickSearch(app, 'Saarbrücken + 15 km + Friseure'); });
after(async () => { if (!skip) await app.close(); });

const flash = async (r: Response) => app.text(await app.follow(r));
const one = async (where: string) => (await leadsWhere(app, where))[0];

test('Lead-Liste: Suche, Filter (Status, Kategorie, Kontakt, Website, Priorität, Score), Sortierung, Paging – ohne Abstürze bei Unsinn', { skip }, async () => {
  const total = (await leadsWhere(app)).length; assert.ok(total >= 10, `${total} Leads`);
  const rows = async (qs: string) => { const r = await app.get('/leads' + qs); assert.equal(r.status, 200, qs); return app.text(await r.text()); };
  const count = (t: string) => Number(/(\d+) Leads/.exec(t)![1]);
  assert.equal(count(await rows('')), total);
  const named = (await leadsWhere(app))[0].company_name as string;
  assert.ok(count(await rows('?q=' + encodeURIComponent(named.split(' ')[0]))) >= 1);
  assert.equal(count(await rows('?q=zzzxxyy')), 0); assert.match(await rows('?q=zzzxxyy'), /Keine Leads für diese Filter/);
  for (const qs of ['?status=QUALIFIED', '?category=HOT', '?readiness=READY_FOR_MANUAL_CALL', '?website=none', '?priority=A', '?minScore=60', '?sort=distance', '?sort=digital_need', '?sort=recent', '?offset=5', '?offset=-3', '?minScore=abc', '?status=FOO', '?q=%27%3B%20drop%20table%20leads%3B--', '?q=%3Cscript%3E'])
    await rows(qs);
  const hot = count(await rows('?category=HOT')), all = count(await rows(''));
  assert.ok(hot <= all);
  const page = await rows('?status=QUALIFIED&sort=distance');
  assert.ok(!/undefined|NaN|\[object/.test(page));
  // Sortierung nach Sales Opportunity absteigend
  const html = await (await app.get('/leads?status=QUALIFIED')).text();
  const scores = [...html.matchAll(/<b>(\d{1,3})<\/b> <span class="badge/g)].map((m) => Number(m[1]));
  assert.deepEqual([...scores].sort((a, b) => b - a), scores);
});

test('Lead-Detail: alle Abschnitte, Quellenangaben, Nicht-verfügbar-Hinweise, keine erfundenen Werte', { skip }, async () => {
  const l = await one("website_state='none'"); assert.ok(l);
  const page = app.text(await (await app.get(`/leads/${l.id}`)).text());
  for (const s of ['Warum ist dieser Lead interessant', 'Verkaufsgrundlage', 'Kontaktstrategie', 'Pipeline', 'Demo', 'Dimensionen', 'Profil', 'Audit', 'Verlauf']) assert.ok(page.includes(s), s);
  assert.match(page, /Nicht verfügbar/); assert.match(page, /mock-google-places/);
  assert.doesNotMatch(page, /undefined|NaN|\[object/);
  const audited = await one("website_state in ('needs_improvement','exists')");
  if (audited) { const p2 = app.text(await (await app.get(`/leads/${audited.id}`)).text()); assert.match(p2, /✅|⚠️|❌/); }
});

test('Pausieren, Fortsetzen, Ablehnen, Neu analysieren, Tiefenprüfung, Statuswechsel', { skip }, async () => {
  const l = await one("status='QUALIFIED' and contact_readiness='READY_FOR_MANUAL_CALL'");
  assert.match(await flash(await app.post(`/leads/${l.id}/pause`)), /pausiert/);
  assert.equal((await one(`id='${l.id}'`)).paused, true);
  assert.ok(!(await app.ctx.calls.queue()).items.some((i: any) => i.id === l.id), 'pausierte Leads nicht in der Anrufliste');
  assert.match(await flash(await app.post(`/leads/${l.id}/resume`)), /fortgesetzt/);
  assert.equal((await one(`id='${l.id}'`)).paused, false);

  const n0 = (await app.pool.query('select count(*)::int n from score_snapshots where lead_id=$1', [l.id])).rows[0].n;
  assert.match(await flash(await app.post(`/leads/${l.id}/reanalyze`)), /neu analysiert/);
  assert.match(await flash(await app.post(`/leads/${l.id}/reanalyze`, { deep: '1' })), /Tiefenprüfung abgeschlossen/);
  assert.ok((await app.pool.query('select count(*)::int n from score_snapshots where lead_id=$1', [l.id])).rows[0].n >= n0, 'Snapshots bleiben erhalten (Learning Loop)');
  assert.equal((await one(`id='${l.id}'`)).status, 'QUALIFIED');

  // Statuswechsel: erlaubt vs. unbekannt vs. verboten
  assert.match(await flash(await app.post(`/leads/${l.id}/status`, { to: 'CONTACTED', reason: 'Erstkontakt' })), /Status: CONTACTED/);
  assert.match(await flash(await app.post(`/leads/${l.id}/status`, { to: 'BANANE' })), /Unbekannter Status/);
  assert.match(await flash(await app.post(`/leads/${l.id}/status`, { to: 'INTERESTED' })), /Ein Grund ist Pflicht/);
  assert.match(await flash(await app.post(`/leads/${l.id}/status`, { to: 'MAINTENANCE', reason: 'Abkürzung' })), /nicht erlaubt/);
  assert.equal((await one(`id='${l.id}'`)).status, 'CONTACTED');

  const r = await one("status='QUALIFIED'");
  assert.match(await flash(await app.post(`/leads/${r.id}/reject`)), /abgelehnt/);
  assert.equal((await one(`id='${r.id}'`)).status, 'IGNORED');
  assert.ok((await app.pool.query("select 1 from lead_outcomes where lead_id=$1 and kind='final' and value='LOST'", [r.id])).rowCount! >= 1);
});

test('Gesprächseinstieg: Bearbeitung hebt die Freigabe auf, neue Freigabe nötig', { skip }, async () => {
  const l = await one("status='QUALIFIED'");
  const sp = async () => (await app.pool.query('select opener, approved_at from sales_packages where lead_id=$1 order by created_at desc limit 1', [l.id])).rows[0];
  await app.post(`/leads/${l.id}/brief/approve`);
  assert.ok((await sp()).approved_at, 'freigegeben');
  assert.match(await flash(await app.post(`/leads/${l.id}/opener`, { opener: 'Guten Tag, ich habe Ihre Seite gesehen und hätte eine Idee.' })), /erneut freigeben/);
  const after = await sp(); assert.equal(after.approved_at, null); assert.match(after.opener, /Guten Tag, ich habe Ihre Seite/);
  await app.post(`/leads/${l.id}/brief/approve`); assert.ok((await sp()).approved_at);
});

test('Nachrichten: standardmäßig nichts senden – Kanal aus, dann Einwilligung, dann Plattformfreigabe; Mock-Versand nur protokolliert', { skip }, async () => {
  const withMail = (await app.pool.query("select l.id from leads l join lead_facts f on f.lead_id=l.id and f.key='email' where l.owner_id=$1 and l.status='QUALIFIED' and not l.contact_blocked limit 1", [OWNER])).rows[0];
  const l = withMail ?? null;
  if (!l) return;                                              // Fixtures ohne E-Mail: nichts zu prüfen
  const mail = app.ctx.registry.providers.email as any;
  const send = (text = 'Hallo, kurze Info zu Ihrer Website.') => app.post(`/leads/${l.id}/send`, { channel: 'EMAIL', text });
  // 1) Kanal standardmäßig aus
  assert.match(await flash(await send()), /Nicht gesendet.*(nicht aktiviert|nicht konfiguriert)/);
  assert.equal(mail.sent.length, 0);
  // 2) Kanal an, aber keine Einwilligung → blockiert
  await app.post('/settings/channels', { email_auto: '1', email_platform: '1', email_limit: '2', whatsapp_limit: '5' });
  assert.match(await flash(await send()), /Nicht gesendet.*Rechtsgrundlage/);
  assert.equal(mail.sent.length, 0);
  // 3) Einwilligung ohne Nachweis wird abgelehnt, mit Nachweis akzeptiert
  assert.match(await flash(await app.post(`/leads/${l.id}/consent`, { channel: 'EMAIL', note: '' })), /Nachweis/);
  assert.match(await flash(await app.post(`/leads/${l.id}/consent`, { channel: 'EMAIL', note: 'Einwilligung per Formular am 12.05.' })), /Einwilligung dokumentiert/);
  // 3b) Alles andere ist erlaubt – trotzdem kein Versand, solange der E-Mail-Status nicht „Rechtlich freigegeben“ ist
  assert.match(await flash(await send()), /Nicht gesendet.*Freigabestatus ist „Entwurf“/);
  assert.equal(mail.sent.length, 0);
  assert.match(await flash(await app.post(`/leads/${l.id}/email-status`, { to: 'legally_cleared' })), /nicht erlaubt/);           // Entwurf → freigegeben überspringt die Prüfung nicht
  await app.post(`/leads/${l.id}/email-status`, { to: 'review_required' });
  assert.match(await flash(await app.post(`/leads/${l.id}/email-status`, { to: 'legally_cleared' })), /rechtliche Grundlage/);       // ohne Bestätigung keine Freigabe
  assert.match(await flash(await app.post(`/leads/${l.id}/email-status`, { to: 'legally_cleared', confirm: '1' })), /Es wurde nichts gesendet/);
  assert.match(await flash(await send()), /Gesendet \(Mock – nur protokolliert\)/);
  assert.equal((await app.pool.query('select email_send_status s from leads where id=$1', [l.id])).rows[0].s, 'sent');
  assert.equal(mail.sent.length, 1);
  assert.equal((await app.pool.query("select result from contact_history where lead_id=$1 and channel='EMAIL' and direction='outbound'", [l.id])).rows[0].result, 'MOCK_RECORDED');
  // 4) Tageslimit (2) greift
  const clear = async () => { await app.post(`/leads/${l.id}/email-status`, { to: 'review_required' }); await app.post(`/leads/${l.id}/email-status`, { to: 'legally_cleared', confirm: '1' }); };
  assert.match(await flash(await send('ohne neue Freigabe')), /Freigabestatus ist „Gesendet“/);     // auch ein Follow-up braucht wieder Prüfung + Freigabe
  await clear(); await send('zweite'); await clear(); assert.match(await flash(await send('dritte')), /Tageslimit/);
  assert.equal(mail.sent.length, 2);
  // 5) Sperrliste hat Vorrang vor jeder Einwilligung
  const addr = (await app.pool.query("select value from lead_facts where lead_id=$1 and key='email' limit 1", [l.id])).rows[0].value as string;
  await app.post('/settings/suppression', { kind: 'email', value: addr, reason: 'Opt-out per Mail' });
  await clear().catch(() => null);
  assert.match(await flash(await send('nach opt-out')), /Nicht gesendet.*(gesperrt|Sperrliste)/);
  assert.equal(mail.sent.length, 2);
  // ungültiger Kanal / leerer Text
  assert.match(await flash(await app.post(`/leads/${l.id}/send`, { channel: 'SMS', text: 'x' })), /Ungültiger Kanal/);
  await app.post('/settings/channels', { email_limit: '20', whatsapp_limit: '20' });
});

test('Fremde Lead-IDs und manipulierte Formulare verändern nichts', { skip }, async () => {
  const other = '00000000-0000-0000-0000-0000000000f2';
  const b = await appSetup(other, { cfgDir: 'config.mock' });
  try {
    await enablePhone(b); await quickSearch(b, 'Völklingen + 30 km + Nagelstudios');
    const theirs = (await leadsWhere(b))[0];
    // Besitzer A darf Lead von B weder sehen noch ändern (Mandantentrennung im Repo + RLS)
    assert.equal((await app.get(`/leads/${theirs.id}`)).status, 404);
    await app.post(`/leads/${theirs.id}/reject`).catch(() => null);
    assert.notEqual((await leadsWhere(b, `id='${theirs.id}'`))[0].status, 'IGNORED');
    assert.equal((await app.get(`/orders/${theirs.id}`)).status, 404);
  } finally { await b.close(); }
});
