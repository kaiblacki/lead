import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appSetup, skip, enablePhone, quickSearch, leadsWhere, makeCustomer, type App } from './helpers.ts';

const OWNER = '00000000-0000-0000-0000-0000000000f6';
let app: App;
before(async () => { if (skip) return; app = await appSetup(OWNER, { cfgDir: 'config.mock' }); await enablePhone(app); await quickSearch(app); });
after(async () => { if (!skip) await app.close(); });
const flash = async (r: Response) => app.text(await app.follow(r));

test('Rechnungen: fortlaufende Nummer, Beträge mit USt, nur für bezahlte Zahlungen, unveränderlich, druckbar', { skip }, async () => {
  const [a, b] = await leadsWhere(app, "status='QUALIFIED' and contact_readiness='READY_FOR_MANUAL_CALL'");
  const c = await makeCustomer(app, a.id);
  const pays = (await app.pool.query("select id, kind, amount_cents from payments where order_id=$1 order by created_at", [c.orderId])).rows;
  const dep = pays.find((p) => p.kind === 'deposit');
  const res = await app.get(`/payments/${dep.id}/invoice`); assert.equal(res.status, 200);
  const page = app.text(await res.text());
  assert.match(page, /Rechnung RE-\d{4}-0001/); assert.match(page, /Demo Agentur \(Mock\) GmbH/); assert.match(page, /USt-IdNr\.: DE000000000/);
  assert.match(page, /Umsatzsteuer 19 %/); assert.match(page, /390,00/); assert.match(page, /74,10/); assert.match(page, /464,10/);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');
  // zweite Abfrage liefert dieselbe Nummer; weitere Zahlung bekommt die nächste
  assert.match(app.text(await (await app.get(`/payments/${dep.id}/invoice`)).text()), /RE-\d{4}-0001/);
  const fin = pays.find((p) => p.kind === 'final');
  assert.match(app.text(await (await app.get(`/payments/${fin.id}/invoice`)).text()), /RE-\d{4}-0002/);
  assert.equal((await app.pool.query('select count(*)::int n from invoices where owner_id=$1', [OWNER])).rows[0].n, 2);
  // Auftragsseite verlinkt die Rechnungen
  assert.match(await (await app.get(`/orders/${c.orderId}`)).text(), new RegExp(`/payments/${dep.id}/invoice`));
  // offene Zahlung: keine Rechnung
  const call = await app.ctx.calls.applyResult(b.id, 'BOUGHT'); await app.post(`/orders/${call.orderId}/checkout/deposit`);
  const open = (await app.pool.query("select id from payments where order_id=$1", [call.orderId])).rows[0];
  assert.match(await flash(await app.get(`/payments/${open.id}/invoice`).then((r) => r)), /nur für bezahlte/);
  // Schnappschuss ändert sich nicht, wenn die Agenturdaten später geändert werden
  app.ctx.invoices.agency = { ...app.ctx.invoices.agency, invoice: { ...app.ctx.invoices.agency.invoice, legalName: 'Neue Firma GmbH' } };
  assert.match(app.text(await (await app.get(`/payments/${dep.id}/invoice`)).text()), /Demo Agentur \(Mock\) GmbH/);
});

test('Rechnungen mit Standard-Konfiguration (Platzhalter): blockiert mit klarer Meldung, nichts gespeichert', { skip }, async () => {
  const other = await appSetup('00000000-0000-0000-0000-0000000000f7');
  try {
    await enablePhone(other); await quickSearch(other);
    const l = (await leadsWhere(other, "status='QUALIFIED' and contact_readiness='READY_FOR_MANUAL_CALL'"))[0];
    const d = other.ctx.invoices; assert.ok(d.missingSellerData().length >= 4);
    await assert.rejects(d.forPayment('00000000-0000-0000-0000-000000000000'), /Angaben zur Agentur fehlen/);
  } finally { await other.close(); }
});

test('DSGVO: Auskunft enthält alle Daten, Löschung entfernt den Lead und sperrt ihn; Kunden sind geschützt', { skip }, async () => {
  const [l] = await leadsWhere(app, "status='QUALIFIED' and contact_readiness='READY_FOR_MANUAL_CALL'");
  await app.ctx.calls.applyResult(l.id, 'NO_ANSWER', { note: 'Mailbox' });
  const ex = await app.get(`/leads/${l.id}/export.json`); assert.equal(ex.status, 200); assert.match(ex.headers.get('content-disposition') ?? '', /auskunft\.json/);
  const j = JSON.parse(await ex.text());
  assert.equal(j.lead.id, l.id); assert.ok(j.facts.length > 0); assert.equal(j.contactHistory[0].note, 'Mailbox'); assert.ok(j.events.length > 0); assert.ok('outbox' in j && 'orders' in j);
  // ohne Bestätigung nichts gelöscht
  assert.match(await flash(await app.post(`/leads/${l.id}/erase`, {})), /bestätigen/);
  assert.equal((await leadsWhere(app, `id='${l.id}'`)).length, 1);
  const supBefore = (await app.repo.listSuppression()).length;
  assert.match(await flash(await app.post(`/leads/${l.id}/erase`, { confirm: '1' })), /gelöscht/);
  assert.equal((await leadsWhere(app, `id='${l.id}'`)).length, 0);
  assert.equal((await app.pool.query('select count(*)::int n from lead_facts where lead_id=$1', [l.id])).rows[0].n, 0, 'abhängige Daten sind weg');
  assert.ok((await app.repo.listSuppression()).length > supBefore, 'Sperrliste verhindert Wiederauftauchen');
  assert.ok((await app.pool.query("select 1 from events where owner_id=$1 and type='gdpr_erased'", [OWNER])).rowCount);
  assert.equal((await app.get(`/leads/${l.id}/export.json`)).status >= 400, true);
  // Kunde mit Auftrag: Löschung verweigert
  const [k] = await leadsWhere(app, "status='QUALIFIED' and contact_readiness='READY_FOR_MANUAL_CALL'");
  await app.ctx.calls.applyResult(k.id, 'BOUGHT');
  assert.match(await flash(await app.post(`/leads/${k.id}/erase`, { confirm: '1' })), /Aufbewahrungspflichten/);
  assert.equal((await leadsWhere(app, `id='${k.id}'`)).length, 1);
  // fremder Besitzer kann nicht exportieren
  assert.match(app.text(await (await app.get(`/leads/${k.id}`)).text()), /Datenschutz \(DSGVO\)/);
});
