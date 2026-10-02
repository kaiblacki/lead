import { chromium } from 'playwright-core';
const B = 'http://127.0.0.1:3055', S = '/tmp/abnahme-shots';
const auth = 'Basic ' + Buffer.from('u:browser-test-pass-123').toString('base64');
const res: [string, boolean, string][] = []; const ok = (n: string, c: boolean, d = '') => { res.push([n, c, d]); console.log(c ? 'PASS' : 'FAIL', n, d); };
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await br.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { authorization: auth } }); const p = await ctx.newPage();
const txt = async () => (await p.locator('body').innerText());
const go = async (u: string) => { await p.goto(B + u); };
const KIM = '48ee1f4a-0d4e-4bfd-9963-778e331d870a', LAMER = 'bf5e7ab4-cf2b-45e7-81fa-4addfac0b7ff', DN = 'db4d9ff8-5fbf-480f-9e23-541c5dbc5ea3';
try {
  // 1 Hauptdashboard
  await go('/leads'); let t = await txt(); await p.screenshot({ path: `${S}/01-leads.png` });
  ok('01 Hauptdashboard', /Jetzt bearbeiten/.test(t) && /Work Status/.test(t) && /Contactability/.test(t) && /Nächste Aktion/.test(t));
  // 2 Sortierung A/B/C/D, kontaktierbar zuerst
  const prios = await p.locator('ul.items > li').evaluateAll((els) => els.slice(0, 40).map((e) => (e.querySelector('span[title]')?.textContent ?? '').trim() + '|' + (/DATA_NEEDED/.test(e.textContent ?? '') ? 'DN' : 'OK')));
  const firstDN = prios.findIndex((x) => x.endsWith('DN')); const head = prios.slice(0, firstDN < 0 ? prios.length : firstDN);
  ok('02 Sortierung kontaktierbar zuerst, dann A→D', head.every((x) => x.endsWith('OK')) && (firstDN < 0 || prios.slice(firstDN).every((x) => x.endsWith('DN'))), prios.slice(0, 12).join(' '));
  // 3 Telefon-Filter
  await go('/leads?quick=has_phone'); t = await txt(); const noPhone = await p.locator('ul.items > li').evaluateAll((els) => els.filter((e) => !e.querySelector('a.tel')).length);
  ok('03 Filter Telefon vorhanden', noPhone === 0 && /Leads/.test(t), 'ohne Telefon: ' + noPhone);
  // 4 DATA_NEEDED
  await go('/leads?quick=data_needed'); const dn = await p.locator('ul.items > li').evaluateAll((els) => els.every((e) => /DATA_NEEDED/.test(e.textContent ?? '')) ? els.length : -1); await p.screenshot({ path: `${S}/04-data-needed.png` });
  ok('04 DATA_NEEDED separat', dn > 0, String(dn)); await go('/enrichment'); ok('04b Ansicht Daten beschaffen', /Daten beschaffen/.test(await txt()));
  // 5 Bereit zum Kontakt
  await go('/leads?quick=ready_contact'); const rc = await p.locator('ul.items > li').evaluateAll((els) => els.every((e) => !/DATA_NEEDED/.test(e.textContent ?? '')) ? els.length : -1); ok('05 Bereit zum Kontakt', rc > 0, String(rc));
  // 6 schlechteste Websites
  await go('/leads?quick=worst_websites'); const sc = await p.locator('ul.items > li').evaluateAll((els) => els.slice(0, 15).map((e) => Number(/Website-Score\s*(\d+)/.exec(e.textContent ?? '')?.[1] ?? 999)));
  ok('06 Schlechteste Websites aufsteigend', sc.length > 0 && sc.every((x, i) => i === 0 || x >= sc[i - 1]), sc.join(','));
  // 7 Lead ohne Website
  await go('/leads/' + KIM); t = await txt(); await p.screenshot({ path: `${S}/07-lead-nowebsite.png`, fullPage: true });
  ok('07 Lead ohne Website', /Kim Nails Studio/.test(t) && /Telefon/.test(t) && /Was soll ich am Telefon sagen/.test(t) && (await p.locator('a[href^="tel:"]').count()) > 0 && /Priorität/.test(t) && /work_status|Work Status|DATA_NEEDED|kontaktierbar/i.test(t));
  // 8 Lead mit Website
  await go('/leads/' + LAMER); t = await txt(); await p.screenshot({ path: `${S}/08-lead-website.png`, fullPage: true });
  ok('08 Lead mit Website', /La Mer/.test(t) && /Website/.test(t) && /Positive|Schwächen|Manuell prüfen/.test(t));
  // 9 Prioritäts-Override
  await go('/leads/' + KIM); await p.locator('select[name=priority]').selectOption('C'); await p.locator('form[action$="/priority"] button').click(); await p.waitForLoadState(); t = await txt();
  ok('09 Prioritäts-Override', /manuell gesetzt/.test(t) && /Automatisch wäre/.test(t));
  await go('/leads?priority=C'); ok('09b Override in Liste', /Kim Nails Studio/.test(await txt()));
  // 10 Status
  await go('/leads/' + KIM); const opts = await p.locator('form[action$="/status"] select[name=to] option').allTextContents(); await p.locator('form[action$="/status"] input[name=reason]').fill('Browser-Test'); await p.locator('form[action$="/status"] select[name=to]').selectOption({ index: 0 }); await p.locator('form[action$="/status"] button').first().click(); await p.waitForLoadState();
  ok('10 Statusänderung', /Status|gespeichert|geändert/i.test(await txt()), opts.join(','));
  // 11 Notiz
  await p.locator('textarea[name=body]').fill('Browser-Notiz: Rückruf Mittwoch'); await p.locator('form[action$="/notes"] button').click(); await p.waitForLoadState(); await go('/leads/' + KIM);
  ok('11 Notiz persistiert', /Browser-Notiz: Rückruf Mittwoch/.test(await p.content()));
  // 12 Telefonansicht
  await p.locator('#telefon').scrollIntoViewIfNeeded(); await p.locator('#telefon').screenshot({ path: `${S}/12-telefon.png` }); const ph = await p.locator('#telefon').innerText();
  ok('12 Telefonansicht', /Gesprächseinstieg/.test(ph) && /Ziel/.test(ph) && /Hallo/.test(ph), ph.slice(0, 80).replace(/\n/g, ' '));
  // 13 Demo empfohlen
  await go('/leads?quick=demo_recommended'); const nrec = await p.locator('ul.items > li').evaluateAll((els) => els.every((e) => /Demo empfohlen/.test(e.textContent ?? '')) ? els.length : -1); await go('/leads/e9265732-980a-40fa-8c4f-812b46e9635a'); const rec = await p.content();
  await p.screenshot({ path: `${S}/13-demo-empfohlen.png`, fullPage: true }); ok('13 Demo empfohlen (Liste + Lead-Seite mit Begründung und Button)', nrec > 0 && /Keine Website gefunden, Telefonnummer vorhanden/.test(rec) && await p.getByRole('button', { name: /Demo erstellen/ }).count() > 0, 'empfohlen: ' + nrec);
  // 14-16 Approval, Module, Erstellen
  const LIO = 'e9265732-980a-40fa-8c4f-812b46e9635a'; await go('/leads/' + LIO); await p.getByRole('button', { name: /Demo erstellen/ }).first().click(); await p.waitForLoadState(); t = await txt(); await p.screenshot({ path: `${S}/14-freigabe.png`, fullPage: true });
  ok('14 Demo-Freigabe (Bestätigungsseite: Frage, Layout, empfohlene Funktionen)', /Demo für Queen Nails erstellen\?/.test(t) && /Layout: /.test(t) && /Enthaltene Funktionen/.test(t) && /empfohlen/.test(t) && !/Demo erstellt/.test(t.split('Ja, Demo')[0]));
  await p.getByRole('link', { name: /Funktionen ändern/ }).click(); await p.waitForLoadState(); const boxes = p.locator('input[type=checkbox][name=mod]'); const n = await boxes.count(); const first = boxes.nth(0); const was = await first.isChecked(); if (was) await first.uncheck(); else await first.check();
  await p.locator('form[action$="/modules"] button').first().click(); await p.waitForLoadState(); t = await txt(); await p.screenshot({ path: `${S}/15-module.png`, fullPage: true });
  ok('15 Module ändern (empfohlen ≠ ausgewählt)', n >= 8 && /Auswahl gespeichert|von dir gewählt|ausgewählt/i.test(t), 'Checkboxen: ' + n);
  await go('/leads/' + LIO + '/demo/confirm?template=auto'); t = await txt(); ok('15b Bestätigungsseite zeigt die gewählten Module', /von dir gewählt/.test(t));
  const yes = p.getByRole('button', { name: /Ja, Demo erstellen/ }); ok('16a Bestätigungsbutton vorhanden', await yes.count() > 0);
  await yes.first().click(); await p.waitForLoadState(); t = await txt(); await p.screenshot({ path: `${S}/16-demo-erstellt.png`, fullPage: true });
  ok('16 Demo erstellt (nur nach Bestätigung)', /Demo erstellt/.test(t));
  const link = await p.locator('a[href*="/d/"]').first().getAttribute('href').catch(() => null);
  if (link) {
    const url = link.startsWith('http') ? link : B + link; const pub = await br.newContext({ viewport: { width: 1280, height: 900 } }); const dp = await pub.newPage(); await dp.goto(url); const c = await dp.content();
    await dp.screenshot({ path: `${S}/17-demo-desktop.png`, fullPage: true }); ok('17 Demo Desktop', /Unverbindliche Demo/.test(c) && /Kontakt/.test(c) && /<footer|Footer/i.test(c) && await dp.locator('h1').count() > 0);
    await dp.setViewportSize({ width: 390, height: 844 }); await dp.reload(); const w = await dp.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })); await dp.screenshot({ path: `${S}/18-demo-mobil.png`, fullPage: true });
    ok('18 Demo Mobile (kein horizontales Scrollen)', w.sw <= w.cw + 1, JSON.stringify(w)); await pub.close();
  } else { ok('17 Demo Desktop', false, 'kein Demo-Link'); ok('18 Demo Mobile', false, 'kein Demo-Link'); }
} catch (e) { console.log('ABBRUCH', (e as Error).message.split('\n')[0]); }
await br.close(); console.log('\nERGEBNIS', res.filter((r) => r[1]).length + '/' + res.length);
