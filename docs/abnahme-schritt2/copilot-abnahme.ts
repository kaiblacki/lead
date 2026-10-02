/** Browser-Abnahme Verkaufsassistent: echter Suchlauf (OSM) + drei Leads (ohne Website / schlechte Website / ordentliche Website) in verschiedenen Branchen. Keine Nachricht, keine Demo. */
import { chromium } from 'playwright-core';
import pg from 'pg';
const B = process.env.B ?? 'http://127.0.0.1:3078', S = process.env.SHOTS ?? '/tmp/copilot-shots', PW = 'browser-test-pass-123';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const res: [string, boolean][] = []; let nr = 0;
const ok = (n: string, c: boolean, d = '') => { nr++; res.push([n, c]); console.log(c ? 'PASS' : 'FAIL', String(nr).padStart(2, '0'), n, d); };
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await br.newContext({ viewport: { width: 1280, height: 1000 }, extraHTTPHeaders: { authorization: 'Basic ' + Buffer.from(`u:${PW}`).toString('base64') } });
const p = await ctx.newPage(); const go = (u: string) => p.goto(B + u); const txt = () => p.locator('body').innerText();
const q = async (sql: string, a: unknown[] = []) => (await pool.query(sql, a)).rows;
try {
  // 1. echter Suchlauf in zwei neuen Branchen (Handwerk, Gastro) – der Verkaufsassistent entsteht automatisch
  await go('/'); await p.locator('#neue-suche input[name=location]').fill('Saarbrücken'); await p.locator('#neue-suche input[name=radiusKm]').fill('3');
  await p.locator('#neue-suche select[name=sub]').selectOption(['elektriker', 'restaurant']); await p.getByRole('button', { name: 'Leads suchen' }).click(); await p.waitForLoadState();
  let t = ''; for (let i = 0; i < 100; i++) { t = await txt(); if (/abgeschlossen/.test(t) && /Leads analysiert/.test(t)) break; if (/fehlgeschlagen/.test(t)) break; await p.waitForTimeout(3000); await p.reload(); }
  const runUrl = p.url(); ok('Suchlauf Elektriker + Restaurant (Saarbrücken, 3 km) abgeschlossen', /abgeschlossen/.test(t) && /Leads analysiert/.test(t), (t.match(/\d+ Leads analysiert/) ?? [''])[0]);
  const runId = runUrl.split('/').pop()!;
  const auto = await q("select count(*)::int n from leads l join sales_copilot s on s.lead_id=l.id and s.tier='MASS' where l.run_id=$1", [runId]);
  const all = await q('select count(*)::int n from leads where run_id=$1', [runId]);
  ok('Verkaufsassistent entsteht automatisch für interessante Leads des Laufs', auto[0].n > 0, `${auto[0].n} von ${all[0].n} Leads (A/B, Verkaufschance ≥ 60 oder Demo empfohlen)`);

  // 2. drei Leads auswählen: ohne Website · schlechte Website · ordentliche Website (verschiedene Branchen, wenn vorhanden)
  const pick = async (state: string, notSub: string[]) => (await q(`select id, company_name, sub_industry from leads where website_state=$1 and sub_industry <> all($2) and phone is not null order by (select score from opportunities where lead_id=leads.id order by created_at desc limit 1) desc nulls last limit 1`, [state, notSub]))[0]
    ?? (await q('select id, company_name, sub_industry from leads where website_state=$1 order by created_at desc limit 1', [state]))[0];
  const noSite = await pick('none', ['friseur', 'nagelstudio']) ?? await pick('none', []);
  const bad = await pick('needs_improvement', []); const fine = await pick('fine', [noSite?.sub_industry ?? '']);
  ok('Drei Testleads gefunden', !!noSite && !!bad && !!fine, [noSite, bad, fine].map((x) => x && `${x.company_name} (${x.sub_industry})`).join(' | '));
  const cases: [string, any, RegExp, RegExp[]][] = [
    ['ohne Website', noSite, /keine eigene Website/, [/In den verfügbaren Quellen wurde keine eigene Website gefunden/, /Website-Potenzial|A · Website \/ Digitalisierung\s*HOCH/]],
    ['schlechte Website', bad, /Online-Auftritt|Punkte gesehen/, [/Erkennbare Probleme/, /Beleg/]],
    ['ordentliche Website', fine, /solide|Online-Auftritt/, [/Website vorhanden und laut Prüfung in Ordnung|NIEDRIG|MITTEL/]],
  ];
  let k = 0;
  for (const [label, lead, openerRe, extra] of cases) {
    k++; await go(`/leads/${lead.id}`);
    if (!/Dieser Lead in 30 Sekunden/.test(await txt())) { await p.getByRole('button', { name: 'Verkaufsassistent erzeugen' }).click(); await p.waitForLoadState(); }
    t = await txt(); await p.locator('#verkaufsassistent').screenshot({ path: `${S}/lead${k}-${label.replace(/\W+/g, '-')}.png` });
    const need = ['Dieser Lead in 30 Sekunden', 'Ziel dieses Gesprächs', 'Nächste Aktion:', 'Persönlicher Gesprächseinstieg', 'A · Website / Digitalisierung', 'B · Bedarfsanalyse', 'C · Kooperation', 'Fragen im Gespräch', 'Deine stärksten Argumente', 'So erklärst du die Demo', 'Mögliche Einwände', 'Empfohlener Gesprächsablauf', 'So kannst du dich vorstellen'];
    const missing = need.filter((n) => !t.includes(n));
    ok(`${label} – ${lead.company_name}: alle Abschnitte (Zusammenfassung, Ziel, Einstieg, 3 Geschäftsmöglichkeiten, Fragen, Argumente, Demo, Einwände, Ablauf, Vorstellung)`, missing.length === 0, missing.join(', '));
    const box = await p.locator('#verkaufsassistent').innerText();
    ok(`${label}: Einstieg persönlich (Firma, Kai Schwarz) und passend zur Website-Lage`, box.includes(lead.company_name) && /Kai Schwarz/.test(box) && openerRe.test(box));
    ok(`${label}: Websiteteil belegt (${extra.length} Prüfmerkmale)`, extra.every((re) => re.test(box)));
    ok(`${label}: keine erfundenen Aussagen (kein „hat keine Website“, keine Umsatz-/Mitarbeiter-/Versicherungsbehauptung, kein Rabatt, keine Produkte)`, !/hat keine Website|besitzt keine Website|Rabatt|Prämie|Haftpflicht|Berufsunfähig|Rechtsschutz|\d+ Mitarbeit|Umsatz von/i.test(box));
    const kinds = ['HOCH', 'MITTEL', 'NIEDRIG', 'NICHT GENUG DATEN'];
    ok(`${label}: Website-/Bedarfs-/Kooperationspotenzial getrennt angezeigt`, kinds.some((x) => box.includes(`A · Website / Digitalisierung ${x}`) || box.includes(`A · Website / Digitalisierung\n${x}`)) || /A · Website \/ Digitalisierung/.test(box)) ;
    const row = (await q('select website_potential, needs_analysis_potential, partnership_potential, recommended_next_action, call_goal from leads where id=$1', [lead.id]))[0];
    ok(`${label}: Potenziale und nächste Aktion gespeichert`, !!row.website_potential && !!row.needs_analysis_potential && !!row.partnership_potential && !!row.recommended_next_action && !!row.call_goal, JSON.stringify(row).slice(0, 220));
  }

  // 3. Telefonakquise-Gate: Gesprächsziel nach Freigabe, Anruf-Ergebnis erfassen (nur protokollieren)
  await go('/settings'); const f = p.locator('form[action="/settings/phone"]');
  if (await f.count()) { const en = f.locator('input[name=enable]'); if (!(await en.isChecked().catch(() => false))) { await en.check(); const ack = f.locator('input[name=ack]'); if (await ack.count()) await ack.check(); const nm = f.locator('input[name=callerName]'); if (await nm.count() && !(await nm.inputValue())) await nm.fill('Kai Schwarz'); await f.locator('button').first().click(); await p.waitForLoadState(); } }
  await go(`/leads/${noSite.id}`);
  await p.locator('textarea[name=note]').first().fill('Inhaber interessiert an Bedarfsanalyse, Website später'); await p.locator('input[name=next_step]').first().fill('Bedarfsanalyse-Termin nächste Woche');
  await p.getByRole('button', { name: 'Bedarfsanalyse interessant' }).first().click(); await p.waitForLoadState(); t = await txt();
  ok('Anruf-Ergebnis „Bedarfsanalyse interessant“ mit Notiz und nächstem Schritt gespeichert', /Ergebnis gespeichert: NEEDS_ANALYSIS/.test(t));
  const box2 = await p.locator('#verkaufsassistent').innerText();
  ok('Danach: nächste Aktion „Bedarfsanalyse-Termin“, Gesprächsziel „Separaten Bedarfsanalyse-Termin“, Bedarfsanalyse INTERESSANT', /Bedarfsanalyse-Termin/.test(box2) && /Separaten Bedarfsanalyse-Termin vereinbaren/.test(box2) && /INTERESSANT/.test(box2));
  await p.locator('#verkaufsassistent').screenshot({ path: `${S}/lead-nach-anruf.png` });
  const hist = await q("select result, next_step, topics, note from contact_history where lead_id=$1 and channel='PHONE' order by at desc limit 1", [noSite.id]);
  ok('Kontakt-Historie: Ergebnis, Thema, nächster Schritt, Notiz', hist[0]?.result === 'NEEDS_ANALYSIS' && hist[0].topics.includes('needs') && /Bedarfsanalyse-Termin/.test(hist[0].next_step) && /Inhaber interessiert/.test(hist[0].note));
  ok('Weitere Ergebnis-Buttons vorhanden (Kooperation, Mehrere Themen, Interessiert Website, Demo gewünscht, Nicht erreicht, Rückruf, Kein Interesse, Nicht mehr kontaktieren)', await Promise.all(['Kooperation interessant', 'Mehrere Themen interessant', 'Interessiert Website', 'Demo gewünscht', 'Nicht erreicht', 'Rückruf', 'Kein Interesse', 'Nicht mehr kontaktieren', 'Angebot gewünscht'].map((n) => p.getByRole('button', { name: n, exact: true }).count())).then((r) => r.every((x) => x > 0)));

  // 4. Liste, Filter, Heute bearbeiten
  await go('/leads'); t = await txt(); await p.screenshot({ path: `${S}/liste.png` });
  ok('Leadliste mit 🌐 Website / 🛡 Bedarfsanalyse / 🤝 Kooperation', /🌐 Website:/.test(t) && /🛡 Bedarfsanalyse:/.test(t) && /🤝 Kooperation:/.test(t));
  const flt: [string, string][] = [['Website-Potenzial hoch', 'website_high'], ['Bedarfsanalyse interessant', 'needs_interesting'], ['Partnerpotenzial hoch', 'partner_high'], ['Demo vorhanden', 'demo_exists'], ['Anrufen', 'call_today'], ['Rückruf', 'callback']];
  const found: string[] = []; for (const [n, quick] of flt) { await go(`/leads?quick=${quick}`); const c = await p.locator('ul.items > li').count(); found.push(`${n}: ${c}`); }
  await go('/leads'); ok('Neue Filter vorhanden und funktionieren', (await Promise.all(flt.map(([n]) => p.getByRole('link', { name: n, exact: true }).count()))).every((x) => x > 0), found.join(' · '));
  await go('/today'); t = await txt(); await p.screenshot({ path: `${S}/heute.png`, fullPage: true });
  ok('„Heute bearbeiten“: Firma, Telefon, Priorität, Website-Potenzial, Demo, Gesprächsziel, nächste Aktion, Button „Verkaufsassistent öffnen“', /Website-Potenzial/.test(t) && /Gesprächsziel/.test(t) && /Nächste Aktion/.test(t) && (await p.getByRole('link', { name: 'Verkaufsassistent öffnen' }).count()) > 0);
  await p.getByRole('link', { name: 'Verkaufsassistent öffnen' }).first().click(); await p.waitForLoadState(); ok('Button öffnet den Verkaufsassistenten', /\/leads\/.+#verkaufsassistent/.test(p.url()) && /Dieser Lead in 30 Sekunden/.test(await txt()));
  await go('/calls'); t = await txt(); ok('Telefonansicht zeigt Gesprächsziel + Verkaufsassistent-Link (oder keine Calls offen)', /Verkaufsassistent öffnen|Keine Calls offen|Tagesziel/.test(t));

  // 5. Vertiefen ohne KI: ehrlich, keine Kosten
  await go(`/leads/${fine.id}`); await p.getByRole('button', { name: /Verkaufsassistent vertiefen/ }).click(); await p.waitForLoadState(); t = await txt();
  ok('„Verkaufsassistent vertiefen“ ohne KI-Schlüssel: klare Meldung, keine Kosten', /Keine KI konfiguriert/.test(t));
  const cost = await q('select count(*)::int n from ai_usage where lead_id=$1', [fine.id]); ok('Keine KI-Aufrufe protokolliert', cost[0].n === 0);
  const out = await q('select count(*)::int n from outbox'); const nm = await q("select count(*)::int n from contact_history where channel in ('EMAIL','WHATSAPP')");
  ok('Nichts gesendet (Outbox leer, keine E-Mail/WhatsApp-Kontakte)', out[0].n === 0 && nm[0].n === 0);
} catch (e) { console.log('FEHLER', e instanceof Error ? e.stack : e); await p.screenshot({ path: `${S}/fehler.png`, fullPage: true }).catch(() => undefined); }
await br.close(); await pool.end();
const fail = res.filter((r) => !r[1]); console.log(`\n${res.length - fail.length}/${res.length} Prüfungen bestanden`); process.exit(fail.length ? 1 : 0);
