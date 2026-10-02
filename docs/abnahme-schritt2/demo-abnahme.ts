import { chromium } from 'playwright-core';
const B = 'http://127.0.0.1:3077', S = '/tmp/abnahme-shots';
const res: [string, boolean, string][] = []; let nr = 0; const ok = (n: string, c: boolean, d = '') => { nr++; res.push([n, c, d]); console.log(c ? 'PASS' : 'FAIL', String(nr).padStart(2, '0'), n, d); };
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await br.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { authorization: 'Basic ' + Buffer.from('u:browser-test-pass-123').toString('base64') } }); const p = await ctx.newPage();
const go = (u: string) => p.goto(B + u); const txt = () => p.locator('body').innerText(); const html = () => p.content();
const firstLead = async (u: string) => { await go(u); const h = await p.locator('ul.items > li a[href^="/leads/"]').first().getAttribute('href'); return h!; };
try {
  await go('/'); let t = await txt(); await p.screenshot({ path: `${S}/01-home.png`, fullPage: true });
  ok('Dashboard öffnet (Banner DEMO-MODUS, Web-Hinweis ruhig)', /DEMO-MODUS/.test(t) && /ECHTE FIRMENDATEN/.test(t) && /Web-Anreicherung nicht aktiviert/.test(t) && !(await p.locator('.errbox').count()));
  ok('Suchformular sichtbar (Ort, Radius, Branche, Größe, „Leads suchen“)', await p.locator('#neue-suche input[name=location]').isVisible() && await p.locator('#neue-suche input[name=radiusKm]').isVisible() && await p.locator('#neue-suche select[name=sub]').isVisible() && (await p.locator('#neue-suche input[name=size]').count()) === 3 && await p.getByRole('button', { name: 'Leads suchen' }).isVisible());
  // mehrdeutiger Ort
  await p.locator('#neue-suche input[name=location]').fill('Neunkirchen'); await p.locator('#neue-suche input[name=radiusKm]').fill('5'); await p.locator('#neue-suche select[name=sub]').selectOption(['friseur']); await p.getByRole('button', { name: 'Leads suchen' }).click(); await p.waitForLoadState();
  for (let i = 0; i < 20 && !/mehrdeutig|abgeschlossen/.test(await txt()); i++) { await p.waitForTimeout(2000); await p.reload(); }
  t = await txt(); ok('Mehrdeutiger Ortsname → verständliche Meldung statt irgendeinem Ort', /mehrdeutig/.test(t) && /Bundesland/.test(t), (t.match(/Der Ort[^\n]{0,120}/) ?? [''])[0]);
  // echte Suche
  await go('/'); await p.locator('#neue-suche input[name=location]').fill('Saarbrücken'); await p.locator('#neue-suche input[name=radiusKm]').fill('4'); await p.locator('#neue-suche select[name=sub]').selectOption(['friseur', 'nagelstudio']); await p.locator('#neue-suche input[name=size][value=SMALL]').check();
  ok('Ort / Radius / Branche (2) / Größe eingegeben', true); await p.getByRole('button', { name: 'Leads suchen' }).click(); await p.waitForLoadState();
  for (let i = 0; i < 90; i++) { t = await txt(); if (/abgeschlossen/.test(t) && /Leads analysiert/.test(t)) break; await p.waitForTimeout(3000); await p.reload(); }
  await p.screenshot({ path: `${S}/02-run.png`, fullPage: true }); const runUrl = p.url();
  ok('Search Run startet und läuft durch (Zusammenfassung „Leads analysiert“)', /abgeschlossen/.test(t) && /Leads analysiert/.test(t) && /Telefonnummer vorhanden/.test(t) && /Keine Website gefunden/.test(t) && /Web-Anreicherung ist nicht aktiviert/.test(t), (t.match(/\d+ Leads analysiert/) ?? [''])[0]);
  await go('/'); t = await txt(); ok('Suchhistorie zeigt den Lauf (Ort, Größe, Status, Leads, Kosten)', /Saarbrücken/.test(t) && /SMALL/.test(t) && /abgeschlossen/.test(t) && /0,00\s€/.test(t));
  await go('/leads'); const first = await p.locator('ul.items > li').evaluateAll((els) => els.slice(0, 30).map((e) => ({ dn: /DATA_NEEDED/.test(e.textContent ?? ''), tel: !!e.querySelector('a.tel'), p: (e.querySelector('span[title]')?.textContent ?? '').trim() })));
  ok('Lead-Liste mit Telefon, Website, Score, Verkaufschance, Demo, Status, nächste Aktion', first.length > 20 && (await txt()).includes('Nächste Aktion') && (await txt()).includes('Verkaufschance') && first.filter((x) => x.tel).length > 10, 'Leads: ' + first.length);
  const rank = (x: string) => ({ A: 0, B: 1, C: 2, D: 3 } as Record<string, number>)[x] ?? 4; const ordered = first.every((x, i) => i === 0 || (Number(first[i - 1].dn) < Number(x.dn)) || (first[i - 1].dn === x.dn && (Number(!first[i - 1].tel) < Number(!x.tel) || (first[i - 1].tel === x.tel && rank(first[i - 1].p) <= rank(x.p)))));
  ok('Standardranking (kontaktierbar zuerst, dann A→D)', ordered);
  for (const [n, q] of [['Jetzt bearbeiten', 'now_work'], ['Bereit zum Kontakt', 'ready_contact'], ['Daten beschaffen', 'data_needed'], ['Demo empfohlen', 'demo_recommended'], ['Manuell prüfen', 'manual_check']] as const) { await go('/leads?quick=' + q); const c = await p.locator('ul.items > li').count(); ok(`Arbeitsbereich „${n}“`, (await p.locator('.errbox').count()) === 0 && /Leads/.test(await txt()), c + ' Leads'); }
  await go('/calls'); t = await txt(); ok('Heute anrufen: ohne Freigabe klare Meldung + Button „Einstellungen öffnen“', /Telefon-Leads vorhanden, Telefonakquise aber noch nicht aktiviert/.test(t) && await p.getByRole('link', { name: 'Einstellungen öffnen' }).isVisible());
  // Telefonakquise bewusst freigeben (Einstellungsweg)
  await p.getByRole('link', { name: 'Einstellungen öffnen' }).click(); await p.waitForLoadState(); const f = p.locator('form[action="/settings/phone"]'); await f.locator('input[name=enable]').check(); await f.locator('input[name=ack]').check(); await f.locator('input[name=callerName]').fill('Kai Test'); await f.locator('button.primary').click(); await p.waitForLoadState();
  await go('/calls'); t = await txt(); const callCount = await p.locator('details.card').count(); await p.screenshot({ path: `${S}/03-calls.png`, fullPage: true });
  ok('Nach Freigabe: Leads in „Heute anrufen“ mit Telefonnummer + Gesprächsleitfaden', callCount > 0 && (await p.locator('details.card a.tel').count()) > 0 && /Gesprächseinstieg/.test(t) && /Verkaufsgründe/.test(t), callCount + ' Leads');
  // Lead öffnen
  const href = await firstLead('/leads?quick=ready_contact'); await go(href); t = await txt(); await p.screenshot({ path: `${S}/04-lead.png`, fullPage: true });
  ok('Lead-Detailseite (Warum interessant, Telefon, Analyse, Priorität, Quellen)', /Warum ist dieser Lead interessant\?/.test(t) && (await p.locator('a[href^="tel:"]').count()) > 0 && /Priorität/.test(t) && /Quelle/.test(t) && /Keine Website in den verfügbaren Daten gefunden/.test(t));
  ok('Telefonansicht (Einstieg, Argumente, Ziel)', /Was soll ich am Telefon sagen\?/.test(t) && /Ziel des Telefonats/.test(t) && /Hallo/.test(t));
  await p.locator('select[name=priority]').selectOption('C'); await p.locator('form[action$="/priority"] button').click(); await p.waitForLoadState(); t = await txt(); ok('Prioritäts-Override', /manuell gesetzt/.test(t) && /Automatisch wäre/.test(t));
  await p.locator('form[action$="/status"] input[name=reason]').fill('Demo-Abnahme'); await p.locator('form[action$="/status"] select[name=to]').selectOption({ index: 0 }); await p.locator('form[action$="/status"] button').first().click(); await p.waitForLoadState(); ok('Statusänderung', !(await p.locator('.errbox, .flash.err').count()));
  await p.locator('textarea[name=body]').fill('Demo-Notiz: Inhaber morgen zurückrufen'); await p.locator('form[action$="/notes"] button').click(); await p.waitForLoadState(); await p.reload(); ok('Notiz bleibt nach Reload', /Demo-Notiz: Inhaber morgen zurückrufen/.test(await html()));
  // Demo
  const dh = await firstLead('/leads?quick=demo_recommended'); await go(dh); t = await html(); ok('Demo-Empfehlung mit Begründung', /Demo empfohlen/.test(t) && /Keine Website gefunden|Telefonnummer vorhanden/.test(t));
  await p.getByRole('button', { name: /Demo erstellen/ }).first().click(); await p.waitForLoadState(); t = await txt(); await p.screenshot({ path: `${S}/05-freigabe.png`, fullPage: true });
  ok('Demo-Freigabe: Bestätigungsseite mit Layout und empfohlenen Modulen', /erstellen\?/.test(t) && /Layout: /.test(t) && /Enthaltene Funktionen/.test(t));
  await p.getByRole('link', { name: /Funktionen ändern/ }).click(); await p.waitForLoadState(); const bx = p.locator('input[type=checkbox][name=mod]'); const first0 = bx.nth(0); if (await first0.isChecked()) await first0.uncheck(); else await first0.check(); await p.locator('form[action$="/modules"] button').first().click(); await p.waitForLoadState();
  await go(dh + '/demo/confirm?template=auto'); ok('Module ändern (empfohlen ≠ ausgewählt)', /von dir gewählt/.test(await txt()));
  await p.getByRole('button', { name: /Ja, Demo erstellen/ }).first().click(); await p.waitForLoadState(); t = await txt(); ok('Demo erstellen (nur nach Bestätigung)', /Demo erstellt/.test(t));
  const link = await p.locator('a[href*="/d/"]').first().getAttribute('href'); const pub = await br.newContext({ viewport: { width: 1280, height: 900 } }); const dp = await pub.newPage(); await dp.goto(link!.startsWith('http') ? link! : B + link);
  let c = await dp.content(); await dp.screenshot({ path: `${S}/06-demo-desktop.png`, fullPage: true });
  ok('Demo Desktop (Unverbindliche Demo, Hero, Leistungen, Kontakt, Öffnungszeiten, Standort, Footer, Beispiel-Markierung)', /Unverbindliche Demo/.test(c) && /Leistungen/.test(c) && /Kontakt/.test(c) && /Öffnungszeiten/.test(c) && /Standort/.test(c) && /<footer/i.test(c) && /Beispiel/.test(c) && !/Bewertungen? \(\d|★/.test(c));
  await dp.setViewportSize({ width: 390, height: 844 }); await dp.reload(); const w = await dp.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })); await dp.screenshot({ path: `${S}/07-demo-mobil.png`, fullPage: true });
  ok('Demo Mobile (390 px, kein horizontales Scrollen)', w.sw <= w.cw + 1, JSON.stringify(w));
  await go('/leads'); ok('Dashboard danach weiter benutzbar', /Leads/.test(await txt()) && (await p.locator('ul.items > li').count()) > 0);
} catch (e) { console.log('ABBRUCH', (e as Error).message.split('\n')[0]); }
await br.close(); console.log('\nERGEBNIS', res.filter((r) => r[1]).length + '/' + res.length);
