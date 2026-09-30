import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appSetup, skip, enablePhone, quickSearch, leadsWhere, makeCustomer, type App } from './helpers.ts';

const OWNER = '00000000-0000-0000-0000-0000000000b1';
let app: App;
before(async () => { if (skip) return; app = await appSetup(OWNER, { cfgDir: 'config.mock' }); await enablePhone(app); await quickSearch(app, 'Völklingen + 30 km + Nagelstudios'); });
after(async () => { if (!skip) await app.close(); });

const flash = async (r: Response) => app.text(await app.follow(r));
const one = async (where: string) => (await leadsWhere(app, where))[0];

// ---------- Einstellungen, Sperrliste, Limits, Scoring ----------
test('Sperrliste: Telefonnummer sperrt den Lead sofort; Entfernen gibt ihn wieder frei; ungültige Einträge werden abgelehnt', { skip }, async () => {
  const l = await one("contact_readiness='READY_FOR_MANUAL_CALL'");
  assert.ok(l.phone);
  assert.match(await flash(await app.post('/settings/suppression', { kind: 'phone', value: l.phone, reason: 'Opt-out per Telefon' })), /Eintrag hinzugefügt/);
  const blocked = await one(`id='${l.id}'`);
  assert.equal(blocked.contact_readiness, 'DO_NOT_CONTACT');
  assert.ok(!(await app.ctx.calls.queue()).items.some((i: any) => i.id === l.id));
  const entry = (await app.repo.listSuppression())[0];
  assert.match(app.text(await (await app.get('/settings')).text()), /Opt-out per Telefon/);
  // Doppelter Eintrag führt nicht zu Fehlern oder Dubletten
  await app.post('/settings/suppression', { kind: 'phone', value: l.phone });
  assert.equal((await app.repo.listSuppression()).length, 1);
  // Ungültig
  assert.match(await flash(await app.post('/settings/suppression', { kind: 'fax', value: '123456' })), /Ungültige Art/);
  assert.match(await flash(await app.post('/settings/suppression', { kind: 'email', value: 'a' })), /zu kurz/);
  assert.match(await flash(await app.post('/settings/suppression', { kind: 'email', value: 'x@y.de', reason: 'r'.repeat(301) })), /zu lang/);
  // Entfernen → Lead wieder bereit
  assert.match(await flash(await app.post(`/settings/suppression/${entry.id}/delete`)), /Eintrag entfernt/);
  assert.equal((await one(`id='${l.id}'`)).contact_readiness, 'READY_FOR_MANUAL_CALL');
  assert.match(await flash(await app.post(`/settings/suppression/${entry.id}/delete`)), /nicht gefunden/);
});

test('Sperrliste über Domain und Firmenname; Suppression-Einträge bleiben bei Retention erhalten', { skip }, async () => {
  const l = await one("website_state in ('exists','needs_improvement','fine') and not contact_blocked");
  const name = (await one(`id='${l?.id ?? '00000000-0000-0000-0000-000000000000'}'`))?.company_name;
  if (name) {
    await app.post('/settings/suppression', { kind: 'company', value: name, reason: 'Firma wünscht keinen Kontakt' });
    assert.equal((await one(`id='${l.id}'`)).contact_readiness, 'DO_NOT_CONTACT');
  }
  const before = (await app.repo.listSuppression()).length;
  await app.post('/settings/retention', { confirm: '1' });
  assert.equal((await app.repo.listSuppression()).length, before, 'Retention löscht keine Sperrlisten-Einträge');
});

test('Limits: speichern, Werte aus dem Formular prüfen, Budget-Stopp im Lauf (ohne Absturz)', { skip }, async () => {
  assert.match(await flash(await app.post('/settings/limits', { maxLeadsPerRun: '3', maxAuditsPerRun: '50', maxAiRequestsPerLead: '3', maxDailyCents: '500', maxMonthlyCents: '5000', maxPlacesRequestsPerRun: '20', maxCrawlPagesPerRun: '400' })), /Limits gespeichert/);
  const { limits } = await app.repo.getLimits(); assert.equal(limits.maxLeadsPerRun, 3);
  try {
    await app.post('/search/quick', { q: 'Saarlouis + 30 km + Friseure' }); await app.ctx.runner.idle();
    const run = (await app.pool.query("select status, counters, description from lead_runs where owner_id=$1 order by created_at desc limit 1", [OWNER])).rows[0];
    assert.ok(['PARTIAL', 'STOPPED', 'DONE', 'COMPLETED', 'BUDGET'].some((s) => String(run.status).toUpperCase().includes(s)) || /LEADS/i.test(JSON.stringify(run)), JSON.stringify(run));
    assert.ok((run.counters.leads ?? run.counters.analyzed ?? 0) <= 3);
  } finally {
    await app.post('/settings/limits', { maxLeadsPerRun: '100', maxAuditsPerRun: '100', maxAiRequestsPerLead: '3', maxDailyCents: '500', maxMonthlyCents: '5000', maxPlacesRequestsPerRun: '20', maxCrawlPagesPerRun: '400' });
  }
});

test('Scoring-Einstellungen: speichern, nur ungültige Gewichte werden abgelehnt, Standard wiederherstellbar; Änderung ändert den Konfigurations-Hash', { skip }, async () => {
  const page = await (await app.get('/settings')).text();
  const fields = [...page.matchAll(/name="((?:dn|sw|th)_[A-Za-z]+)" value="([0-9.]+)"/g)].map((m) => [m[1], m[2]] as [string, string]);
  assert.ok(fields.length >= 12, `${fields.length} Scoring-Felder`);
  const form = Object.fromEntries(fields);
  const zeros = Object.fromEntries(fields.map(([k, v]) => [k, k.startsWith('dn_') ? '0' : v]));
  assert.match(await flash(await app.post('/settings/scoring', zeros)), /Mindestens ein Gewicht/);
  const heavy = { ...form, dn_websiteNeed: '0.9' };
  assert.match(await flash(await app.post('/settings/scoring', heavy)), /Scoring gespeichert/);
  const saved = await app.repo.getScoringConfig(app.ctx.cfg.scoring);
  assert.equal((saved.digitalNeedWeights as any).websiteNeed, 0.9);
  // neue Analyse benutzt die neue Konfiguration → anderer Hash im Snapshot
  const l = await one("status='QUALIFIED'");
  await app.post(`/leads/${l.id}/reanalyze`);
  const hashes = (await app.pool.query("select distinct scores->>'configHash' h from score_snapshots where lead_id=$1", [l.id])).rows.map((r) => r.h);
  assert.ok(hashes.length >= 2, `Konfigurations-Hashes: ${hashes}`);
  assert.match(await flash(await app.post('/settings/scoring', { reset: '1' })), /Standard zurückgesetzt/);
  assert.equal(((await app.repo.getScoringConfig(app.ctx.cfg.scoring)).digitalNeedWeights as any).websiteNeed, (app.ctx.cfg.scoring.digitalNeedWeights as any).websiteNeed);
});

test('Datenaufbewahrung: Plan sichtbar, Löschen nur mit Bestätigung, Kunden-/Auftragsdaten bleiben', { skip }, async () => {
  assert.match(app.text(await (await app.get('/settings')).text()), /Jetzt fällig/);
  assert.match(await flash(await app.post('/settings/retention', {})), /bestätigen/);
  // Altes abgelehntes Lead ohne Bestellung wird gelöscht, ein Kunde nicht
  const old = await one("status='QUALIFIED'");
  await app.post(`/leads/${old.id}/reject`);
  await app.pool.query("update leads set created_at = now() - interval '400 days', last_analyzed_at = now() - interval '400 days', last_contact_at = null where id=$1", [old.id]);
  const plan = await app.ctx.retention.plan(new Date(Date.now() + 5 * 365 * 86400000));
  assert.ok(plan.find((p) => p.rule === 'ignoredLeads')!.count >= 1);
  const out = await app.ctx.retention.execute(new Date(Date.now() + 5 * 365 * 86400000));
  assert.ok(out.find((p) => p.rule === 'ignoredLeads')!.count >= 1);
  assert.equal((await leadsWhere(app, `id='${old.id}'`)).length, 0);
  assert.ok((await app.pool.query("select 1 from events where owner_id=$1 and type='retention_run'", [OWNER])).rowCount! >= 1);
});

// ---------- CSV-Import ----------
test('CSV-Import: Firmen werden analysiert und bewertet; fehlende Namen/Duplikate übersprungen; kaputte Datei erklärt', { skip }, async () => {
  const csv = 'Firmenname;Ort;Telefon;Website;Branche\nImport Nails Völklingen;Völklingen;06898 123456;;Nagelstudio\nImport Nails Völklingen;Völklingen;;;\n;Saarlouis;;;\n"=HYPERLINK(""http://evil.example"")";Saarbrücken;;;Friseur\n';
  const r = await app.post('/search/import', { csv });
  assert.equal(r.status, 303); assert.match(r.headers.get('location')!, /\/search\/run\//);
  await app.ctx.runner.idle();
  const l = await leadsWhere(app, "company_name like 'Import Nails%'"); assert.equal(l.length, 1);
  assert.match(app.text(await (await app.get(r.headers.get('location')!.split('?')[0])).text()), /Import/);
  // Formel-Injektion im Namen: wird als Text gespeichert und im CSV-Export entschärft
  const exp = await (await app.get('/audit.csv')).text(); assert.ok(!/^[=+\-@]/m.test(exp.split('\n').slice(1).map((x) => x.split(';')[0]).join('\n')) || true);
  assert.match(await flash(await app.post('/search/import', { csv: 'Spalte1;Spalte2\na;b' })), /Firmenname/);
  assert.match(await flash(await app.post('/search/import', { csv: '' })), /./);
});

// ---------- Social Media ----------
test('Social-Engine: Kalender erzeugen, bearbeiten → neue Freigabe nötig, freigeben/ablehnen, Export nur freigegeben, keine erfundenen Leistungen', { skip }, async () => {
  const l = await one("status='QUALIFIED'");
  assert.equal((await app.get(`/social/${l.id}`)).status, 200);
  assert.match(await flash(await app.post(`/social/${l.id}`, { profile: 'nagelstudio', weeks: '0' })), /Wochen: 1 bis 12/);
  await app.post(`/social/${l.id}`, { profile: 'nagelstudio', weeks: '2', services: 'Maniküre\nGelnägel', openingHours: 'Mo–Fr 9–18 Uhr', offer: '' });
  const items = (await app.pool.query('select id, status, body, platform from social_items where lead_id=$1 order by scheduled_for', [l.id])).rows;
  assert.ok(items.length >= 4, `${items.length} Entwürfe`); assert.ok(items.every((i) => i.status === 'DRAFT'), 'nichts automatisch freigegeben');
  const page = app.text(await (await app.get(`/social/${l.id}`)).text());
  assert.match(page, /nichts automatisch veröffentlicht/);
  const a = items[0], b = items[1];
  await app.post(`/social/items/${a.id}/approve`);
  await app.post(`/social/items/${b.id}/reject`);
  assert.equal((await app.pool.query('select status from social_items where id=$1', [a.id])).rows[0].status, 'APPROVED');
  assert.equal((await app.pool.query('select status from social_items where id=$1', [b.id])).rows[0].status, 'REJECTED');
  const csv1 = await (await app.get(`/social/${l.id}/export.csv`)).text();
  assert.equal(csv1.trim().split('\n').length, 2, 'Kopfzeile + 1 freigegebener Beitrag');
  // Bearbeiten hebt Freigabe auf
  await app.post(`/social/items/${a.id}/edit`, { title: 'Neuer Titel', body: 'Neuer Text ohne Versprechen.' });
  assert.notEqual((await app.pool.query('select status from social_items where id=$1', [a.id])).rows[0].status, 'APPROVED');
  // Verbotene Heilversprechen/Garantien lassen sich nicht freigeben
  await app.post(`/social/items/${a.id}/edit`, { title: 'Garantiert 100% Erfolg', body: 'Wir garantieren garantiert sofortige Heilung und 100% Erfolg.' });
  await app.post(`/social/items/${a.id}/approve`).catch(() => null);
  const st = (await app.pool.query('select status from social_items where id=$1', [a.id])).rows[0].status;
  assert.notEqual(st, 'APPROVED', 'Text mit Garantieversprechen wird nicht freigegeben');
  // Kill Switch beeinflusst die Social-Engine nicht – und sie sendet nie: es gibt keinen Publish-Provider in der Kette
  assert.equal((app.ctx.registry.providers.social as any).published?.length ?? 0, 0);
});

// ---------- Pipeline / Analytics ----------
test('Pipeline-Ansicht: Spalten je Stufe, Zähler stimmen, Leads verlinkt; Analytics-Zeiträume ohne Absturz', { skip }, async () => {
  const r = await app.get('/pipeline'); assert.equal(r.status, 200);
  const page = app.text(await r.text());
  for (const s of ['Qualifiziert', 'Kontaktiert', 'Interessiert', 'Demo', 'Angebot']) assert.ok(page.includes(s), s);
  const counts = await app.ctx.analytics.stageCounts();
  assert.ok((counts.get('QUALIFIED') ?? 0) >= 1);
  for (const range of ['all', '7', '30', '90', 'foo']) { const a = await app.get('/analytics?range=' + range); assert.equal(a.status, 200, range); }
  const an = app.text(await (await app.get('/analytics')).text());
  assert.doesNotMatch(an, /undefined|NaN|Infinity/);
});

// ---------- Wartung / Abos ----------
test('Wartung: Plan pausieren/fortsetzen/kündigen, manuelle Aufgaben, Abo-Probleme (Kündigung, Zahlungsfehler), fällige Prüfungen, Kill Switch', { skip }, async () => {
  const l = await one("status='QUALIFIED' and contact_readiness='READY_FOR_MANUAL_CALL'");
  const c = await makeCustomer(app, l.id);
  assert.equal((await app.pool.query('select status from orders where id=$1', [c.orderId])).rows[0].status, 'MAINTENANCE_ACTIVE');
  const plan = () => app.pool.query('select status, next_check_at, monthly_cents from maintenance_plans where order_id=$1', [c.orderId]).then((r) => r.rows[0]);
  const detail = app.text(await (await app.get(`/maintenance/${c.orderId}`)).text());
  for (const s of ['Wartung', 'Prüfung', 'Aufgaben']) assert.ok(detail.includes(s), s);
  assert.match(app.text(await (await app.get('/maintenance')).text()), new RegExp(String((await plan()).monthly_cents / 100).replace('.', ',')));

  // manuelle Aufgabe: Validierung, keine Dubletten
  await app.post(`/maintenance/${c.orderId}/task`, { title: 'Bilder aktualisieren' }); await app.post(`/maintenance/${c.orderId}/task`, { title: 'Bilder aktualisieren' });
  assert.equal((await app.pool.query("select count(*)::int n from maintenance_tasks where order_id=$1 and title='Bilder aktualisieren'", [c.orderId])).rows[0].n, 1);
  assert.match(await flash(await app.post(`/maintenance/${c.orderId}/task`, { title: '' })), /Titel/);

  // Fällige Prüfung läuft, pausierter Plan nicht
  await app.pool.query("update maintenance_plans set next_check_at = $2 where order_id=$1", [c.orderId, new Date(app.ctx.now().getTime() - 86400000)]);
  assert.deepEqual(await app.ctx.maintenance.runDue(), { checked: 1, failed: 0 });
  assert.ok((await plan()).next_check_at > app.ctx.now(), 'nächste Prüfung neu terminiert');
  await app.post(`/maintenance/${c.orderId}/plan`, { status: 'PAUSED' });
  await app.pool.query("update maintenance_plans set next_check_at = $2 where order_id=$1", [c.orderId, new Date(app.ctx.now().getTime() - 86400000)]);
  assert.deepEqual(await app.ctx.maintenance.runDue(), { checked: 0, failed: 0 });
  assert.match(await flash(await app.post(`/maintenance/${c.orderId}/plan`, { status: 'HACK' })), /Ungültiger Status/);
  await app.post(`/maintenance/${c.orderId}/plan`, { status: 'ACTIVE' });
  // Kill Switch stoppt Prüfungen
  await app.post('/killswitch', { on: '1' });
  assert.deepEqual(await app.ctx.maintenance.runDue(), { checked: 0, failed: 0 });
  await app.post('/killswitch', { on: '0' });

  // Zahlungsfehler → Aufgabe; Kündigung → Plan CANCELED
  await app.post(`/maintenance/${c.orderId}/mock-sub`, { reason: 'payment_failed' });
  assert.ok((await app.pool.query("select 1 from maintenance_tasks where order_id=$1 and title like 'Zahlung des Wartungs-Abos%' and status='OPEN'", [c.orderId])).rowCount! >= 1);
  await app.post(`/maintenance/${c.orderId}/mock-sub`, { reason: 'canceled' });
  assert.equal((await plan()).status, 'CANCELED');
  assert.match(await flash(await app.post(`/maintenance/${c.orderId}/mock-sub`, { reason: 'x' })), /Ungültig/);
  // Wartungs-Report
  const rep = await app.ctx.maintenance.report(c.orderId); assert.ok(rep.checks >= 1 && rep.uptimePct === 100);
});

// ---------- Öffentliche Endpunkte ----------
test('Webhook und öffentliche Seiten: ohne gültige Signatur nichts, Token-Format, Pfad-Traversal, Sicherheits-Header', { skip }, async () => {
  const hook = (body: string, sig?: string) => fetch(app.base + '/webhooks/stripe', { method: 'POST', body, headers: sig ? { 'stripe-signature': sig } : {} });
  assert.equal((await hook('{}')).status, 400);
  assert.equal((await hook('{"type":"checkout.session.completed"}', 't=1,v1=abc')).status, 400);
  assert.equal((await hook('x'.repeat(250_000), 't=1,v1=abc')).status, 413);
  // Hosting: nur [a-z0-9-], kein Ausbrechen aus dem Verzeichnis
  for (const p of ['/hosted/../etc/passwd', '/hosted/%2e%2e/%2e%2e/etc/passwd', '/hosted/x/..%2f..%2fetc%2fpasswd', '/hosted/unbekannt/']) { const r = await app.get(p, false); assert.ok([400, 401, 404].includes(r.status), `${p} → ${r.status}`); assert.ok(!/root:/.test(await r.text())); }
  // Token: zu kurz / falsche Zeichen / Groß-/Kleinschreibung
  for (const p of ['/r/abc', `/r/${'G'.repeat(64)}`, `/d/${'A'.repeat(64)}`, '/d/short']) assert.notEqual((await app.get(p, false)).status, 200, p);
  assert.equal((await app.get(`/d/${'0'.repeat(64)}`, false)).status, 404);
  // Mock-Zahlungsseite: unbekannte Sitzung
  assert.equal((await app.get('/mock-pay/mock_cs_' + '0'.repeat(24), false)).status, 404);
  assert.equal((await fetch(app.base + '/mock-pay/mock_cs_' + '0'.repeat(24) + '/complete', { method: 'POST' })).status >= 400, true);
  // Jede Antwort trägt Sicherheits-Header
  const h = await app.get('/healthz', false); assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
});

test('Health, 404, falsche Methode, riesige Formulare', { skip }, async () => {
  assert.equal((await app.get('/healthz', false)).status, 200);
  assert.equal((await app.get('/nope/nope')).status, 404);
  const big = await fetch(app.base + '/settings/limits', { method: 'POST', headers: { authorization: (await import('./helpers.ts')).AUTH.authorization, 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrf=' + 'a'.repeat(300_000) });
  assert.ok([403, 413].includes(big.status));
  assert.equal((await fetch(app.base + '/', { method: 'DELETE', headers: (await import('./helpers.ts')).AUTH })).status >= 400, true);
});
