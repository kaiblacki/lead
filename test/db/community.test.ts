import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { seededApp, skip, type App } from './helpers.ts';

/** Phase I: Community-MVP – Opt-in Pflicht, Gebühr 29/290 €, aktive Partner kostenlos, nie an Versicherung gekoppelt, nichts veröffentlicht/abgebucht. */
const apps: App[] = []; after(async () => { for (const a of apps) await a.close(); });
const page = async (app: App, path: string) => app.text(await (await app.get(path)).text());

test('Mitglied aus Partner: Opt-in Pflicht, Gebühr/kostenlos je Partnerstatus, Verzeichnis nur mit Opt-in + aktiv + gelistet', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000801', { cfgDir: 'config.mock' }); apps.push(app);
  const [a, b] = (await app.ctx.leads.list({ limit: 100 })).rows.filter((l: any) => l.phone);
  const pa = (await app.ctx.partners.fromLead(a.id)).id, pb = (await app.ctx.partners.fromLead(b.id)).id;
  await app.ctx.partners.setCriteria(pa, { conversation_held: true, referral_willingness: true, agreement: true, contact_person_known: true } as never);
  for (const s of ['PARTNER_DISCUSSION', 'PARTNER_APPROVED', 'ACTIVE_PARTNER']) await app.ctx.partners.setStatus(pa, s as never);
  const ma = await app.ctx.community.invite({ partnerId: pa }), mb = await app.ctx.community.invite({ partnerId: pb }); assert.equal(await app.ctx.community.invite({ partnerId: pa }), ma, 'idempotent');
  await assert.rejects(app.ctx.community.setStatus(ma, 'ACTIVE'), /Opt-in/); await assert.rejects(app.ctx.community.setListed(ma, true), /Opt-in/); await assert.rejects(app.ctx.community.recordOptIn(ma, ''), /Einwilligung/);
  const res = await app.post(`/community/${ma}/optin`, { note: 'mündlich am 12.10., per E-Mail bestätigt' }); assert.equal(res.status, 303);
  await app.ctx.community.recordOptIn(mb, 'schriftlich'); await app.ctx.community.setStatus(ma, 'ACTIVE'); await app.ctx.community.setStatus(mb, 'ACTIVE');
  const A = await app.ctx.community.get(ma), B = await app.ctx.community.get(mb);
  assert.equal(A.fee.free, true); assert.equal(A.feeCents, 0); assert.equal(A.fee.reason, 'ACTIVE_PARTNER'); assert.equal(B.fee.free, false); assert.equal(B.feeCents, 2900);
  await app.ctx.community.updateProfile(mb, { billing: 'YEARLY' }); assert.equal((await app.ctx.community.get(mb)).feeCents, 29000);
  assert.equal((await app.ctx.partners.get(pa)).community_status, 'MEMBER');
  assert.equal((await app.ctx.community.directory()).length, 0, 'nicht gelistet → nicht im Verzeichnis');
  await app.ctx.community.setListed(ma, true); const dir = await app.ctx.community.directory(); assert.equal(dir.length, 1); assert.deepEqual(Object.keys(dir[0]).sort(), ['company_name', 'contact_public', 'id', 'industry', 'offer_text', 'region'], 'nur freigegebene Felder');
  await app.ctx.community.withdrawOptIn(ma); assert.equal((await app.ctx.community.directory()).length, 0, 'Widerruf entfernt Eintrag');
  await app.ctx.partners.setStatus(pa, 'PAUSED_PARTNER'); assert.equal((await app.ctx.community.get(ma)).feeCents, 2900, 'nicht mehr aktiver Partner → normaler Beitrag');
  const st = await app.ctx.community.stats(); assert.equal(st.members, 2); assert.equal(st.paying, 2);
  const pg = await page(app, '/community'); for (const t of ['eigenständiges Angebot', 'für aktive Partner kostenlos', 'nichts wird abgebucht', 'Verzeichnis-Vorschau']) assert.ok(pg.includes(t), t);
  assert.equal((await app.pool.query('select count(*)::int n from outbox')).rows[0].n, 0);
});

test('Community-Vorteile nie an Versicherung gekoppelt (Text-Guard); Kunde als Mitglied; Beenden nimmt aus Verzeichnis', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000802', { cfgDir: 'config.mock' }); apps.push(app);
  const m = await app.ctx.community.invite({ companyName: 'Muster GmbH' });
  await assert.rejects(app.ctx.community.updateProfile(m, { offer_text: 'Gratis Mitgliedschaft bei Abschluss einer Versicherung.' }), /Versicherung/);
  await app.ctx.community.updateProfile(m, { offer_text: 'Regelmäßiger Austausch lokaler Unternehmen.' });
  await app.ctx.community.recordOptIn(m, 'schriftlich'); await app.ctx.community.setStatus(m, 'ACTIVE'); await app.ctx.community.setListed(m, true); assert.equal((await app.ctx.community.directory()).length, 1);
  await app.ctx.community.setStatus(m, 'ENDED'); assert.equal((await app.ctx.community.directory()).length, 0); assert.equal((await app.ctx.community.get(m)).feeCents, 0);
  const bad = await app.post('/community/invite', {}); assert.equal(bad.status, 303);
});
