import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { seededApp, skip, type App } from './helpers.ts';

/** Phase C: Demo-Stufen (System empfiehlt, Kai entscheidet) und schnelle Standard-Demo (nur nach Bestätigung). Nichts wird gesendet oder veröffentlicht. */
const apps: App[] = []; after(async () => { for (const a of apps) await a.close(); });
const page = async (app: App, path: string) => app.text(await (await app.get(path)).text());
const callable = async (app: App) => (await app.ctx.leads.list({ limit: 100 })).rows.filter((l: any) => l.work_status === 'CONTACTABLE' && l.phone);

test('Demo-Stufen: auswählen/zurücksetzen ohne Demo zu erstellen; „gezeigt“ erst mit Demo; „erstellt“ nur automatisch', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000491'); apps.push(app);
  const [a, b] = await callable(app); const S = app.ctx.demoStages; const demos = async () => (await app.pool.query('select count(*)::int n from demos where owner_id=$1', ['00000000-0000-0000-0000-000000000491'])).rows[0].n;
  assert.ok(['NO_DEMO', 'DEMO_RECOMMENDED'].includes(await S.effective(a.id)));
  assert.equal(await S.set(a.id, 'NO_DEMO'), 'NO_DEMO'); assert.equal((await app.pool.query('select demo_stage, demo_decision from leads where id=$1', [a.id])).rows[0].demo_decision, 'skipped'); assert.equal(await app.ctx.pipeline.approvals.stateOf(a.id, 'DEMO_CREATE'), 'REJECTED');
  assert.equal(await S.set(a.id, 'DEMO_SELECTED'), 'DEMO_SELECTED'); assert.equal(await app.ctx.pipeline.approvals.stateOf(a.id, 'DEMO_CREATE'), 'AWAITING_APPROVAL', 'Auswahl legt nur die Bestätigungsanfrage an');
  assert.equal(await demos(), 0, 'keine Demo durch die Auswahl'); await assert.rejects(S.set(a.id, 'DEMO_SHOWN'), /erst, wenn eine Demo erstellt/); await assert.rejects(S.set(a.id, 'DEMO_CREATED'), /automatisch/); await assert.rejects(S.set(a.id, 'NOPE' as never), /Unbekannte/);
  assert.equal((await app.post(`/leads/${b.id}/demo/stage`, { stage: 'NO_DEMO' })).status, 303); assert.equal(await S.effective(b.id), 'NO_DEMO'); assert.equal((await app.post(`/leads/${b.id}/demo/stage`, { stage: '' })).status, 303);
  const pg = await page(app, `/leads/${a.id}`); for (const t of ['Demo ausgewählt', 'Keine Demo', 'Demo gezeigt', 'Schnelle Standard-Demo', 'Empfehlung des Systems übernehmen']) assert.ok(pg.includes(t), t);
  await app.ctx.docs.demoFor(a.id, 'auto'); assert.equal(await S.effective(a.id), 'DEMO_CREATED'); assert.equal(await S.set(a.id, 'DEMO_SHOWN'), 'DEMO_SHOWN'); assert.ok((await app.pool.query('select demo_shown_at from leads where id=$1', [a.id])).rows[0].demo_shown_at);
  assert.match(await page(app, '/today'), /Demo gezeigt|Demo erstellt|Keine Demo|Demo empfohlen/);
});

test('Schnelle Standard-Demo: nur mit Bestätigung und gültigem Grundtemplate, nutzt die Leaddaten, setzt Stufe „erstellt“; gesperrte Leads nie', { skip, timeout: 300_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000492'); apps.push(app);
  const [a, b, c] = await callable(app); const demos = async () => (await app.pool.query('select count(*)::int n from demos where owner_id=$1', ['00000000-0000-0000-0000-000000000492'])).rows[0].n;
  for (const body of [{ family: 'SERVICE' }, { family: 'SERVICE', confirm: '0' }, { family: 'ROCKET', confirm: '1' }] as Record<string, string>[]) { await app.post(`/leads/${a.id}/demo/quick`, body); assert.equal(await demos(), 0, 'ohne Bestätigung bzw. mit ungültigem Template keine Demo'); }
  const ok = await app.post(`/leads/${a.id}/demo/quick`, { family: 'APPOINTMENT', confirm: '1' }); assert.equal(ok.status, 303); assert.equal(await demos(), 1);
  const html = (await app.pool.query('select html from demos where lead_id=$1', [a.id])).rows[0].html as string;
  assert.ok(html.includes(a.company_name.replace(/&/g, '&amp;')) || html.includes(a.company_name), 'Firmenname im Entwurf'); assert.match(html, /Unverbindliche Demo/); assert.match(html, /class="eyebrow"/); if (a.phone) assert.ok(html.includes(String(a.phone).replace(/[^\d+]/g, '')), 'Telefonnummer des Leads');
  assert.equal((await app.pool.query('select demo_family from leads where id=$1', [a.id])).rows[0].demo_family, 'APPOINTMENT'); assert.equal(await app.ctx.demoStages.effective(a.id), 'DEMO_CREATED'); assert.equal(await app.ctx.pipeline.approvals.stateOf(a.id, 'DEMO_CREATE'), 'COMPLETED');
  await app.pool.query('update leads set contact_blocked=true where id=$1', [b.id]); await app.post(`/leads/${b.id}/demo/quick`, { family: 'SERVICE', confirm: '1' }); assert.equal(await demos(), 1, 'gesperrter Lead: keine Demo');
  assert.equal((await app.post(`/leads/${c.id}/demo/quick`, { family: 'GASTRO_RETAIL', confirm: '1' })).status, 303); assert.equal(await demos(), 2);
  assert.equal((await app.pool.query('select count(*)::int n from outbox')).rows[0].n, 0, 'nichts gesendet');
});
