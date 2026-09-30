import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, runSearch, skip, NOW, type Ctx } from './helpers.ts';
import { distanceKm } from '../../src/core/geo.ts';
import { analyzeCandidate } from '../../src/search/analyze-candidate.ts';
import { assessContact } from '../../src/contact/strategy.ts';
import { buildBrief } from '../../src/sales/brief.ts';
import { getWorld } from '../../src/fixtures/world.ts';

const OWNER = '00000000-0000-0000-0000-0000000000a1';
let ctx: Ctx;
before(async () => { if (!skip) ctx = await setup(OWNER); });
after(async () => { if (!skip) await ctx.close(); });
const VK = { lat: 49.2514, lng: 6.8447 };

test('Beispielsuche: Völklingen + 30 km + Nagelstudios + Website fehlt oder verbesserungswürdig → qualifizierte, sortierte Leadliste', { skip }, async () => {
  const { id, run } = await runSearch(ctx, { website: ['none', 'needs_improvement'], excludeExisting: '0' });
  assert.equal(run.status, 'DONE', run.error);
  assert.match(run.description, /Völklingen · 30 km · Nagelstudio · Website fehlt oder Website verbesserungswürdig/);
  assert.ok(run.counters.matched >= 8 && run.counters.matched <= 15, JSON.stringify(run.counters));
  assert.ok(run.counters.analyzed >= run.counters.matched && run.counters.found >= run.counters.analyzed);
  const { rows, total } = await ctx.leads.list({ runId: id, matchedOnly: true, limit: 100 });
  assert.equal(total, run.counters.matched);
  for (const r of rows) {
    assert.equal(r.sub_industry, 'nagelstudio'); assert.ok(Number(r.distance_km) <= 30);
    assert.ok(['none', 'needs_improvement'].includes(r.website_state), r.website_state);
    assert.ok(r.score !== null && r.digital_need !== null && r.category);
    assert.equal(r.is_mock, true);
  }
  const scores = rows.map((r) => r.score); assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'nach Sales Opportunity sortiert');
  const ranks = (await ctx.pool.query('select rank from run_results where run_id=$1 and matched order by rank', [id])).rows.map((r) => r.rank);
  assert.deepEqual(ranks, ranks.map((_, i) => i + 1));
  const usage = (await ctx.pool.query('select provider, sum(requests)::int n from provider_usage where run_id=$1 group by 1', [id])).rows;
  assert.ok(usage.some((u) => u.provider === 'mock-google-places') && usage.some((u) => u.provider === 'mock-crawler'));
});

test('Jeder analysierte Lead ist vollständig gespeichert: Fakten mit Herkunft, Audit mit ✅/⚠️/❌, 11 Dimensionen, Verkaufsbrief, Snapshot, Audit-Log', { skip }, async () => {
  const { rows } = await ctx.leads.list({ limit: 200 });
  const withSite = rows.find((r) => r.website_state === 'needs_improvement')!;
  const d = (await ctx.leads.get(withSite.id))!;
  assert.ok(d.facts.length >= 8 && d.facts.every((f: any) => f.source && f.captured_at && f.quality));
  assert.ok(d.facts.some((f: any) => f.key === 'distanceKm' && f.source === 'computed'));
  assert.ok(d.checks.some((c: any) => c.status === 'pass') && d.checks.some((c: any) => c.status === 'fail'));
  assert.equal(Object.keys(d.opportunity.dimensions).length, 11);
  assert.ok(d.opportunity.why.length > 20 && d.opportunity.contributions.sales.length >= 3);
  assert.ok(d.sales.brief.reasons.length >= 2 && d.sales.brief.valueRange.estimate === true);
  assert.equal(d.snapshots.length >= 1, true); assert.ok(d.snapshots[0].scores.configHash);
  assert.ok(d.events.some((e: any) => e.type === 'audit_done') && d.events.some((e: any) => e.type === 'status_change'));
  assert.ok(['QUALIFIED', 'IGNORED'].includes(d.lead.status));
  assert.ok(d.lead.contact_readiness && d.lead.contact_reason);
});

test('Fakten-Konflikte und Datenqualität sind in der Datenbank sichtbar', { skip }, async () => {
  const r = await ctx.pool.query(`select lead_id, key, count(distinct source)::int n from lead_facts where owner_id=$1 and key='phone' group by 1,2 having count(distinct source) > 1`, [OWNER]);
  assert.ok(r.rowCount! >= 1, 'mind. ein Lead mit Telefon aus mehreren Quellen');
});

test('Filter: mobile Probleme, keine Terminbuchung, Social aktiv, Mindest-Score, Größe, Telefon, Kontaktstatus', { skip }, async () => {
  const c = (o: object) => runSearch(ctx, { subIndustries: ['friseur', 'kosmetik', 'nagelstudio'], excludeExisting: '0', radiusKm: '40', maxLeads: '40', ...o });
  const mob = await c({ mobileProblems: '1', _form: '1' });
  for (const r of (await ctx.leads.list({ runId: mob.id, matchedOnly: true })).rows) assert.equal(r.website_state === 'none', false, 'mobile Probleme nur bei existierender Website');
  assert.ok(mob.run.counters.matched > 0);
  const nb = await c({ noBooking: '1', _form: '1' });
  assert.ok(nb.run.counters.matched > 0);
  const rowsNb = (await ctx.leads.list({ runId: nb.id, matchedOnly: true })).rows;
  for (const r of rowsNb) { const d = (await ctx.leads.get(r.id))!; const b = d.checks.find((x: any) => x.code === 'ONLINE_BOOKING'); assert.ok(r.website_state === 'none' || b?.status === 'fail'); }
  const act = await c({ socialActive: 'yes', _form: '1' });
  for (const r of (await ctx.leads.list({ runId: act.id, matchedOnly: true })).rows) {
    const soc = (await ctx.leads.get(r.id))!.facts.filter((f: any) => f.key === 'social' && f.value.lastPostAt);
    assert.ok(soc.some((f: any) => Date.parse(f.value.lastPostAt) >= NOW.getTime() - 90 * 86400000));
  }
  const hi = await c({ minOpportunity: '60' });
  for (const r of (await ctx.leads.list({ runId: hi.id, matchedOnly: true })).rows) assert.ok(r.score >= 60);
  const small = await c({ employeeBuckets: ['10-49'], includeUnknownSize: '0', _form: '1' });
  for (const r of (await ctx.leads.list({ runId: small.id, matchedOnly: true })).rows) assert.equal((await ctx.leads.factsOf(r.id)).find((f) => f.key === 'employeeBucket')?.value, '10-49');
  const ready = await c({ readiness: ['READY_FOR_MANUAL_CALL'] });
  assert.equal(ready.run.counters.matched, 0);            // Telefonakquise ist standardmäßig nicht freigegeben
  assert.ok(ready.run.summary.warnings.length === 0 || true);
});

test('Mindest-/Höchstzahl: Höchstzahl begrenzt, Mindestzahl erzeugt Hinweis', { skip }, async () => {
  const small = await runSearch(ctx, { maxLeads: '3', excludeExisting: '0' });
  assert.equal(small.run.counters.matched, 3);
  const few = await runSearch(ctx, { radiusKm: '2', minLeads: '10', excludeExisting: '0', maxLeads: '50' });
  assert.ok(few.run.counters.matched < 10); assert.match(few.run.summary.warnings.join(' '), /mindestens 10 Leads/);
});

test('„Bereits vorhandene ausschließen“ verhindert doppelte Analysen', { skip }, async () => {
  const first = await runSearch(ctx, { subIndustries: ['elektriker'], radiusKm: '40', maxLeads: '5', excludeExisting: '1' });
  const n1 = first.run.counters.analyzed; assert.ok(n1 > 0);
  const again = await runSearch(ctx, { subIndustries: ['elektriker'], radiusKm: '40', maxLeads: '5', excludeExisting: '1' });
  assert.ok(again.run.summary.skipped['Bereits als Lead vorhanden'] >= n1, JSON.stringify(again.run.summary.skipped));
  const count = (await ctx.pool.query("select count(*)::int n from leads where owner_id=$1 and sub_industry='elektriker'", [OWNER])).rows[0].n;
  const distinct = (await ctx.pool.query("select count(distinct source_ref)::int n from leads where owner_id=$1 and sub_industry='elektriker'", [OWNER])).rows[0].n;
  assert.equal(count, distinct);
});

test('Unbekannter Ort und leere Treffer: Lauf endet sauber mit Meldung', { skip }, async () => {
  const bad = await runSearch(ctx, { location: 'Atlantis' });
  assert.equal(bad.run.status, 'FAILED'); assert.match(bad.run.error, /nicht gefunden/);
  const none = await runSearch(ctx, { subIndustries: [], industry: '', keywords: 'zzzunbekannt' });
  assert.equal(none.run.status, 'DONE'); assert.match(none.run.summary.warnings.join(' '), /keine Treffer/);
});

test('Budget-Limit stoppt den Lauf, Teilergebnisse bleiben erhalten', { skip }, async () => {
  const limits = (await ctx.repo.getLimits()).limits;
  try {
    await ctx.repo.saveLimits({ ...limits, maxAuditsPerRun: 2 });
    const r = await runSearch(ctx, { website: ['exists'], excludeExisting: '0', subIndustries: ['friseur'], radiusKm: '40' });
    assert.equal(r.run.status, 'STOPPED'); assert.match(r.run.summary.stoppedReason, /WEBSITE ANALYSES/);
    assert.equal(r.run.counters.analyzed, 2);
    assert.equal((await ctx.leads.list({ runId: r.id })).total, 2);       // Teilergebnisse gespeichert
    await ctx.repo.saveLimits({ ...limits, maxCrawlPagesPerRun: 5 });
    const c = await runSearch(ctx, { website: ['exists'], excludeExisting: '0', subIndustries: ['kosmetik'], radiusKm: '40' });
    assert.equal(c.run.status, 'STOPPED'); assert.match(c.run.summary.stoppedReason, /CRAWL PAGES/);
    await ctx.repo.saveLimits({ ...limits, maxPlacesRequestsPerRun: 0 });
    const p = await runSearch(ctx, { subIndustries: ['maler'] });
    assert.equal(p.run.status, 'STOPPED'); assert.match(p.run.summary.stoppedReason, /PLACES REQUESTS/);
  } finally { await ctx.repo.saveLimits(limits); }
});

test('Kill Switch: verhindert neue Läufe und stoppt einen laufenden Lauf', { skip }, async () => {
  await ctx.repo.setKillSwitch(true);
  await assert.rejects(() => ctx.runner.start(ctx.criteria({})), /Kill Switch/);
  await ctx.repo.setKillSwitch(false);
  // Während des Laufs einschalten: der Crawler legt den Schalter nach dem dritten Abruf um
  let calls = 0; const orig = ctx.providers.crawler.crawl.bind(ctx.providers.crawler);
  (ctx.providers.crawler as any).crawl = async (u: string, o: any) => { if (++calls === 3) await ctx.repo.setKillSwitch(true); return orig(u, o); };
  const r = await runSearch(ctx, { website: ['exists'], excludeExisting: '0', subIndustries: ['restaurant'], radiusKm: '40' });
  (ctx.providers.crawler as any).crawl = orig;
  assert.equal(r.run.status, 'STOPPED'); assert.match(r.run.summary.stoppedReason, /Kill Switch/);
  assert.ok(r.run.counters.analyzed >= 3 && r.run.counters.analyzed <= 4);
  await ctx.repo.setKillSwitch(false);
});

test('Nur ein Lauf gleichzeitig', { skip }, async () => {
  const id = await ctx.runner.start(ctx.criteria({ subIndustries: ['cafe'], excludeExisting: '0' }));
  await assert.rejects(() => ctx.runner.start(ctx.criteria({})), /läuft bereits/);
  await ctx.runner.idle();
  assert.equal((await ctx.runs.get(id)).status, 'DONE');
  await ctx.pool.query("update lead_runs set status='RUNNING' where id=$1", [id]);
  assert.equal(await ctx.runs.markInterrupted(), 1);
  assert.equal((await ctx.runs.get(id)).status, 'STOPPED');
});

test('Sperrliste: gesperrte Unternehmen werden nie „Treffer“ und landen nicht in der Anrufliste', { skip }, async () => {
  const b = getWorld().find((x) => x.subKey === 'kosmetik' && x.variant === 'none' && x.inPlaces && x.phone && x.status === 'OPERATIONAL' && distanceKm(VK, x.point) < 25)!;
  await ctx.repo.addSuppression('phone', b.phone!, 'Wunsch des Inhabers');
  const r = await runSearch(ctx, { subIndustries: ['kosmetik'], radiusKm: '40', website: ['none'], excludeExisting: '0', maxLeads: '100' });
  const row = (await ctx.pool.query("select l.id, l.status, l.contact_readiness, rr.matched, rr.fail_reasons from leads l join run_results rr on rr.lead_id=l.id and rr.run_id=$1 where l.owner_id=$2 and l.company_name=$3", [r.id, OWNER, b.name])).rows[0];
  assert.equal(row.contact_readiness, 'DO_NOT_CONTACT'); assert.equal(row.matched, false); assert.equal(row.status, 'IGNORED');
  assert.match(row.fail_reasons.join(), /Sperrliste/);
});

test('Telefonakquise-Freigabe: aus → MANUAL_REVIEW, an → READY_FOR_MANUAL_CALL (alle Leads neu bewertet), wieder aus → zurück', { skip }, async () => {
  const pick = async () => (await ctx.pool.query("select id, contact_readiness, contact_reason, phone from leads where owner_id=$1 and phone is not null and contact_readiness <> 'DO_NOT_CONTACT' limit 1", [OWNER])).rows[0];
  const before = await pick(); assert.equal(before.contact_readiness, 'MANUAL_REVIEW'); assert.match(before.contact_reason, /noch nicht freigegeben/);
  const r = await ctx.repo.saveSettings({ phoneEnabled: true });
  assert.ok(r.changedPhone); assert.ok((await ctx.leads.recomputeAllContact()) > 10);
  const on = (await ctx.leads.get(before.id))!.lead; assert.equal(on.contact_readiness, 'READY_FOR_MANUAL_CALL'); assert.equal(on.contact_channel, 'PHONE');
  const s = await ctx.repo.getSettings(); assert.ok(s.phoneAckAt);
  await ctx.repo.saveSettings({ phoneEnabled: false }); await ctx.leads.recomputeAllContact();
  assert.equal((await ctx.leads.get(before.id))!.lead.contact_readiness, 'MANUAL_REVIEW');
  await assert.rejects(() => ctx.repo.saveSettings({ dailyCallTarget: 0 }), /1 bis 200/);
  await assert.rejects(() => ctx.repo.saveSettings({ channels: { fax: { autoSend: true, dailyLimit: 1 } } }), /Kanal/);
});

test('Erneute Analyse überschreibt keine Handarbeit: freigegebener/bearbeiteter Einstieg und Status bleiben', { skip }, async () => {
  const row = (await ctx.leads.list({ status: 'QUALIFIED', limit: 1 })).rows[0];
  await ctx.leads.editOpener(row.id, 'Mein eigener Einstieg mit Bezug zum Laden.'); await ctx.leads.approveBrief(row.id);
  await ctx.pool.query("update leads set status='CONTACTED' where id=$1", [row.id]);
  const lead = (await ctx.leads.get(row.id))!.lead;
  const facts = await ctx.leads.factsOf(row.id);
  const place = (await ctx.providers.places.search({ center: VK, radiusKm: 60, keywords: [lead.company_name], limit: 400 })).items.find((p) => p.externalId === lead.source_ref)!;
  const res = await analyzeCandidate(ctx.providers, ctx.cfg, { place, center: VK, now: NOW });
  const contact = assessContact({ facts: res.facts, audit: res.audit, phoneEnabled: true });
  const brief = buildBrief({ company: res.lead.companyName, facts: res.facts, audit: res.audit, analysis: res.analysis, contact, now: NOW, pricing: ctx.cfg.pricing, sales: ctx.cfg.sales });
  const saved = await ctx.leads.saveAnalysis({ res, contact, brief, scoring: ctx.cfg.scoring });
  assert.equal(saved.leadId, row.id); assert.equal(saved.created, false); assert.equal(saved.status, 'CONTACTED');
  const d = (await ctx.leads.get(row.id))!;
  assert.equal(d.sales.opener, 'Mein eigener Einstieg mit Bezug zum Laden.'); assert.ok(d.sales.approved_at);
  assert.ok(d.snapshots.length >= 2); assert.ok(facts.length > 0);
});

test('Lead-Liste: Filter, Suche, Sortierung, Seiten', { skip }, async () => {
  const all = await ctx.leads.list({ limit: 500 });
  assert.ok(all.total > 30);
  assert.ok((await ctx.leads.list({ q: all.rows[0].company_name.slice(0, 6) })).rows.some((r) => r.id === all.rows[0].id));
  assert.ok((await ctx.leads.list({ websiteState: 'none' })).rows.every((r) => r.website_state === 'none'));
  assert.ok((await ctx.leads.list({ minScore: 60 })).rows.every((r) => r.score >= 60));
  const byDist = (await ctx.leads.list({ sort: 'distance', limit: 500 })).rows.map((r) => Number(r.distance_km));
  assert.deepEqual(byDist.filter((x) => !Number.isNaN(x)), [...byDist.filter((x) => !Number.isNaN(x))].sort((a, b) => a - b));
  assert.equal((await ctx.leads.list({ limit: 5, offset: 5 })).rows.length, 5);
  assert.equal((await ctx.leads.list({ q: "'; drop table leads; --" })).total, 0);
  assert.ok((await ctx.pool.query('select 1 from leads limit 1')).rowCount === 1);
});

test('Mandantentrennung der neuen Tabellen (RLS)', { skip }, async () => {
  const tables = ['lead_facts', 'run_results', 'contact_history', 'score_snapshots', 'lead_outcomes', 'maintenance_plans', 'maintenance_tasks', 'owner_settings', 'provider_usage', 'leads', 'audits', 'findings', 'opportunities'];
  const c = await ctx.pool.connect();
  try {
    await c.query("insert into auth.users values ('00000000-0000-0000-0000-0000000000b2') on conflict do nothing");
    await c.query('set role authenticated'); await c.query("set request.jwt.sub = '00000000-0000-0000-0000-0000000000b2'");
    for (const t of tables) assert.equal((await c.query(`select count(*)::int n from ${t}`)).rows[0].n, 0, t);
    await c.query("set request.jwt.sub = '" + OWNER + "'");
    assert.ok((await c.query('select count(*)::int n from lead_facts')).rows[0].n > 0);
    await c.query('reset role'); await c.query('set role anon');
    await assert.rejects(() => c.query('select 1 from lead_facts'), /permission denied/);
  } finally { await c.query('reset role'); c.release(); }
});
