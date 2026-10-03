import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { findChromium } from '../../src/providers/real/render.ts';
import { seededApp, skip, AUTH, type App } from './helpers.ts';

/**
 * Browser-Abnahme Team-System (Chromium, 390 px): Admin legt Mitarbeiter + Kampagne an und weist 10 Leads zu → Mitarbeiter arbeitet (Mein Tag, Arbeit starten,
 * Leitfaden, nicht erreicht, erreicht/Interesse/Notiz, Rückruf, Demo, Übergabe) → Admin prüft Team, Profil, Leads, Zahlen, Notizen, Rückruf, Übergabe, Aktivität.
 * Mit SHOTS_DIR=… Screenshots. Nichts wird gesendet.
 */
const apps: App[] = []; after(async () => { for (const a of apps) await a.close(); });
const PW = 'geheim-12345';

async function submit(page: Page, action: string, fields: Record<string, string | boolean | string[]> = {}, o: { has?: string; button?: string } = {}) {
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { (d as HTMLDetailsElement).open = true; }));
  const forms = page.locator(`form[action="${action}"]`); const form = (o.has ? forms.filter({ has: page.locator(o.has) }) : forms).first(); assert.ok(await form.count() > 0, `Formular ${action} fehlt auf ${page.url()}`);
  for (const [name, value] of Object.entries(fields)) {
    const el = form.locator(`[name="${name}"]`).first(); assert.ok(await el.count() > 0, `Feld ${name} fehlt in ${action}`); const tag = await el.evaluate((e) => e.tagName.toLowerCase() + ':' + ((e as HTMLInputElement).type ?? ''));
    if (tag === 'select:select-one') await (String(value).startsWith('label:') ? el.selectOption({ label: String(value).slice(6) }) : el.selectOption(String(value))); else if (tag === 'input:checkbox') await el.setChecked(Boolean(value)); else await el.fill(String(value));
  }
  await Promise.all([page.waitForLoadState('load'), (o.button ? form.locator(o.button) : form.locator('button').last()).first().click()]);
}
const text = async (page: Page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
const probe = () => {
  const vw = document.documentElement.clientWidth; const inScroll = (e: Element) => !!e.closest('.scroll, pre, code, nav');
  const label = (e: Element) => `${e.tagName.toLowerCase()} "${(e.textContent ?? '').trim().slice(0, 28).replace(/\s+/g, ' ')}"`;
  const overflowing = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && !inScroll(e) && (r.right > vw + 1 || r.left < -1) && getComputedStyle(e).position !== 'fixed'; }).slice(0, 5).map(label);
  const small = [...document.querySelectorAll('button, .btn, nav a, summary, select, textarea, input:not([type=hidden]):not([type=checkbox]):not([type=radio])')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 43.5 && !e.closest('.scroll'); }).slice(0, 5).map((e) => `${label(e)} ${Math.round(e.getBoundingClientRect().height)}px`);
  return { sw: document.documentElement.scrollWidth, cw: vw, overflowing, small };
};

test('Browser-Abnahme Team: Admin → Mitarbeiter arbeitet (390 px) → Admin prüft', { skip: skip || (findChromium() ? false : 'Chromium nicht gefunden'), timeout: 600_000 }, async () => {
  const app = await seededApp('00000000-0000-0000-0000-000000000c01', { cfgDir: 'config.mock', n: 60 }); apps.push(app); const t = app.ctx.team; const q = (sql: string, p: unknown[] = []) => app.pool.query(sql, [app.ctx.repo.ownerId, ...p]).then((r) => r.rows);
  const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] }); const shots = process.env.SHOTS_DIR; if (shots) mkdirSync(shots, { recursive: true }); let n = 0;
  const problems: string[] = []; const errors: string[] = [];
  const mk = async (headers: Record<string, string>) => { const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, extraHTTPHeaders: headers, baseURL: app.base }); const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`)); page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); }); return page; };
  const shot = async (page: Page, name: string) => { n++; if (shots) await page.screenshot({ path: join(shots, `${String(n).padStart(2, '0')}-${name}.png`), fullPage: true }); };
  const check = async (page: Page, name: string) => { const m = await page.evaluate(probe); if (m.sw > m.cw + 1) problems.push(`${name}: seitliches Scrollen ${m.sw}>${m.cw}`); if (m.overflowing.length) problems.push(`${name}: ragt heraus ${m.overflowing.join(', ')}`); if (m.small.length) problems.push(`${name}: Tap-Ziele < 44px ${m.small.join(' | ')}`); };
  try {
    // ---------- ADMIN ----------
    const admin = await mk(AUTH); await admin.goto('/team'); assert.match(await text(admin), /Team/); await shot(admin, 'admin-team');
    await admin.click('text=+ Mitarbeiter anlegen'); await submit(admin, '/team/new', { name: 'Max Mustermann', login: 'max', password: PW, role: 'SALES', team: 'Saar', industries: 'Nagelstudio', regions: 'Völklingen' }); assert.match(await text(admin), /Mitarbeiter angelegt/); const max = (await q("select id from staff_users where owner_id = $1 and login = 'max'"))[0].id as string;
    await admin.goto('/team/campaigns'); await submit(admin, '/team/campaigns', { name: 'Nagelstudios Völklingen KW41', contactability: 'PHONE_ONLY', limit: '10', assignee: 'label:Max Mustermann', playbook: 'PLAYBOOK_A_NO_WEBSITE' }); assert.match(await text(admin), /Kampagne erstellt, \d+ Lead/);
    const assigned = (await q('select count(*)::int n from leads where owner_id = $1 and assigned_to_user_id = $2', [max]))[0].n as number; assert.ok(assigned >= 6 && assigned <= 10, `zugewiesen: ${assigned}`); await shot(admin, 'admin-kampagne');
    await admin.goto(`/team/${max}`); const pt = await text(admin); assert.match(pt, new RegExp(`${assigned} zugewiesen`)); assert.match(pt, /Zum Team/); assert.match(pt, /letzte Aktivität noch keine/); await shot(admin, 'admin-mitarbeiter');
    await admin.goto('/team/assign?limit=2&preview=1&user=' + max); await check(admin, 'admin-zuweisung');
    // ---------- MITARBEITER ----------
    const sales = await mk({ authorization: 'Basic ' + Buffer.from(`max:${PW}`).toString('base64') });
    await sales.goto('/'); assert.match(sales.url(), /\/work$/); const day = await text(sales); for (const w of ['Max', 'neue Leads', 'ARBEIT STARTEN', '🏠 Mein Tag', 'MEINE LEADS', 'TRAINING']) assert.ok(day.includes(w), w); assert.ok(!day.includes('Einstellungen')); await check(sales, 'mein-tag'); await shot(sales, 'mein-tag');
    assert.equal((await sales.goto('/settings'))!.status(), 403); await sales.goto('/work');
    await sales.click('text=ARBEIT STARTEN'); assert.match(sales.url(), /\/work\/lead\/[0-9a-f-]{36}/); const l1 = sales.url().match(/lead\/([0-9a-f-]{36})/)![1]; assert.ok((await q('select 1 from leads where owner_id = $1 and id = $2 and assigned_to_user_id = $3', [l1, max])).length === 1, 'eigener Lead');
    const lp = await text(sales); for (const w of ['Das soll ich sagen', 'Gesprächsziel', 'Das weiß das System', 'Playbook: A · Keine Website', 'Ansprechpartner erreicht?', 'Warum dieser Lead?', 'Kontakt-Historie']) assert.ok(lp.includes(w), w); assert.ok(await sales.locator('a[href^="tel:"]').count() > 0, 'Telefonnummer als Link');
    await check(sales, 'lead-arbeitsplatz'); await shot(sales, 'lead-arbeitsplatz');
    // 1 nicht erreicht
    await submit(sales, `/work/lead/${l1}/result`, {}, { has: 'input[value="NO_ANSWER"]' }); assert.match(await text(sales), /Gespräch gespeichert/); await shot(sales, 'gespeichert'); await check(sales, 'gespeichert');
    await sales.click('text=Nächsten Lead öffnen'); const l2 = sales.url().match(/lead\/([0-9a-f-]{36})/)![1]; assert.notEqual(l2, l1);
    // 2 erreicht → Interesse → Notiz
    await sales.click('a:has-text("JA") >> nth=0'); assert.match(await text(sales), /Besteht grundsätzlich Interesse/); await sales.click('a:has-text("JA") >> nth=0'); assert.match(await text(sales), /Woran besteht Interesse/); await check(sales, 'interesse');
    await submit(sales, `/work/lead/${l2}/result`, { note: 'Mit Geschäftsführer gesprochen. Website grundsätzlich interessant.' }, { button: 'button[value="WEBSITE_INTEREST"]' }); assert.match(await text(sales), /Gespräch gespeichert/);
    await sales.click('text=Nächsten Lead öffnen'); const l3 = sales.url().match(/lead\/([0-9a-f-]{36})/)![1];
    // 3 unsicher → Rückruf
    await sales.click('a:has-text("JA") >> nth=0'); await sales.click('a:has-text("UNSICHER")'); const cb = new Date(app.ctx.now().getTime() + 5 * 86400000 + 2 * 3600000).toISOString().slice(0, 11) + '14:00';
    await submit(sales, `/work/lead/${l3}/result`, { note: 'Rückruf Donnerstag 14 Uhr.', callback: cb }, { button: 'button[value="CALL_BACK"]' }); assert.match(await text(sales), /Rückruf für .* gespeichert/);
    await sales.click('text=Nächsten Lead öffnen'); const l4 = sales.url().match(/lead\/([0-9a-f-]{36})/)![1];
    // 4 Demo gewünscht
    await sales.click('a:has-text("JA") >> nth=0'); await sales.click('a:has-text("JA") >> nth=0'); await submit(sales, `/work/lead/${l4}/result`, { note: 'Möchte eine Demo sehen, am liebsten bis Freitag.' }, { button: 'button[value="DEMO_WANTED"]' }); assert.match(await text(sales), /Gespräch gespeichert/);
    await sales.click('text=Nächsten Lead öffnen'); const l5 = sales.url().match(/lead\/([0-9a-f-]{36})/)![1];
    // 5 Übergabe an Kai
    await sales.click('text=AN KAI ÜBERGEBEN'); assert.match(sales.url(), /\/handoff$/); await check(sales, 'uebergabe'); await submit(sales, `/work/lead/${l5}/handoff`, { reason: 'WEBSITE_ANGEBOT', note: 'Will ein Angebot für die Website. Ansprechpartner Herr Beispiel.', interest: 'Website', next_step: 'Kai ruft Donnerstag an' }); assert.match(await text(sales), /Lead wurde an Kai übergeben/);
    await sales.goto('/work'); const day2 = await text(sales); assert.match(day2, /Anrufe: 5 \/ 40/); await check(sales, 'mein-tag-danach'); await shot(sales, 'mein-tag-danach');
    for (const [name, p] of [['meine-leads', '/work/leads'], ['rueckrufe', '/work/leads?f=callbacks'], ['aufgaben', '/work/tasks'], ['uebergaben', '/work/handoffs'], ['training', '/work/training'], ['training-fall', '/work/training/t1?o=1']] as const) { const r = await sales.goto(p); assert.equal(r!.status(), 200, p); await check(sales, name); }
    assert.match(await text(sales), /Instagram/); await sales.goto('/work/handoffs'); assert.match(await text(sales), /Offen bei Kai/); await shot(sales, 'meine-uebergaben');
    // ---------- ADMIN PRÜFT ----------
    await admin.goto('/team'); const tt = await text(admin); assert.match(tt, /Max Mustermann/); await shot(admin, 'admin-team-danach');
    const m = (await t.metricsFor({ userId: max }))[0]; assert.deepEqual([m.calls, m.reached, m.interested, m.demos, m.callbacks, m.handoffs, m.noanswer], [5, 4, 2, 1, 1, 1, 1], 'Zahlen im System');
    await admin.click(`a[href*="metric=reached"][href*="user=${max}"]`); const dd = await text(admin); assert.match(dd, /4 Lead\(s\) hinter dieser Kennzahl/); assert.match(dd, /Mit Geschäftsführer gesprochen/); assert.match(dd, /Rückruf Donnerstag 14 Uhr/); await shot(admin, 'admin-drilldown');
    await admin.goto(`/team/${max}`); const prof = await text(admin); assert.doesNotMatch(prof, /letzte Aktivität noch keine/); assert.match(prof, /Anrufe/); await admin.click('text=Alle zugewiesenen Leads ansehen'); const al = await text(admin); for (const w of ['Mit Geschäftsführer gesprochen', 'Demo sehen', 'Will ein Angebot', 'Kai ruft Donnerstag an', 'Nicht erreicht', 'Übergeben', 'Rückruf']) assert.ok(al.toLowerCase().includes(w.toLowerCase()), w); await shot(admin, 'admin-zugewiesene-leads');
    await admin.goto(`/leads/${l2}?tab=verlauf`); const vl = await text(admin); assert.match(vl, /Max Mustermann/); assert.match(vl, /Website grundsätzlich interessant/); assert.match(vl, /Besitzer: Max Mustermann/);
    await admin.goto('/team/handoffs'); assert.match(await text(admin), /Will ein Angebot/); await submit(admin, (await q("select id from handoffs where owner_id = $1"))[0] ? `/team/handoffs/${(await q('select id from handoffs where owner_id = $1'))[0].id}/accept` : '', { note: 'Übernommen, rufe Donnerstag an.' }); assert.match(await text(admin), /Übernommen/);
    await admin.goto('/team/activity?range=today'); assert.match(await text(admin), /Reach Rate/); await check(admin, 'admin-aktivitaet'); await shot(admin, 'admin-aktivitaet');
    for (const [name, p] of [['admin-team', '/team'], ['admin-kampagnen', '/team/campaigns'], ['admin-profil', `/team/${max}`], ['admin-goals', '/team/goals'], ['admin-menu', '/menu'], ['admin-lead', `/leads/${l2}`]] as const) { await admin.goto(p); await check(admin, name); }
    assert.equal((await q("select count(*)::int n from outbox where owner_id = $1"))[0].n, 0, 'nichts gesendet'); assert.equal((await q("select count(*)::int n from demos where owner_id = $1 and lead_id = $2", [l4]))[0].n, 0, 'keine automatische Demo');
    assert.deepEqual(errors, []); assert.deepEqual(problems, []);
  } finally { await browser.close(); }
});
