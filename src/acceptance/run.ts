/**
 * Kern-Abnahmetest: „Völklingen + 30 km + Nagelstudios“ mit echten OpenStreetMap-Daten (Live-Modus).
 * Es wird NICHTS gesendet, bezahlt oder veröffentlicht – nur gesucht, zusammengeführt und analysiert.
 * Aufruf: npm run acceptance   (braucht DATABASE_URL, OWNER_ID und Netzzugang zu nominatim.openstreetmap.org und overpass-api.de)
 */
import { Repo } from '../db/repo.ts';
import { buildContext } from '../context.ts';
import { CriteriaError, normalizeCriteria, parseQuickSearch } from '../search/criteria.ts';
import { buildReport, formatReport } from './report.ts';

const env = process.env;
env.APP_MODE = 'live';
const query = process.argv.slice(2).join(' ') || 'Völklingen + 30 km + Nagelstudios + 200 Leads';
const repo = Repo.fromEnv();
try {
  const ctx = buildContext(repo, { baseUrl: env.PUBLIC_BASE_URL ?? 'http://127.0.0.1:3000' });
  const P = ctx.registry.providers;
  console.log('Provider:'); for (const s of ctx.registry.status) console.log(`  ${s.kind.padEnd(10)} ${s.name.padEnd(18)} ${s.mode.padEnd(5)} ${s.note}`);
  // Sicherheitsnetz: nichts darf senden/bezahlen; Quelle muss OSM sein
  if (P.places.name !== 'osm') throw new Error(`Abbruch: Lead-Quelle ist „${P.places.name}“, erwartet OpenStreetMap (GOOGLE_PLACES_API_KEY entfernen oder PLACES_SOURCE=osm setzen).`);
  if (!P.email.isMock || !P.whatsapp.isMock || !P.payments.isMock) throw new Error('Abbruch: E-Mail, WhatsApp und Zahlung müssen für diesen Test Mock sein (SMTP_*, WHATSAPP_*, STRIPE_* entfernen).');
  const p = parseQuickSearch(query, ctx.cfg.taxonomy);
  if (p.unmatched.length) throw new Error(`Nicht verstanden: ${p.unmatched.join(', ')}`);
  const criteria = normalizeCriteria(p.criteria, ctx.cfg.taxonomy);
  const uaHint = env.OSM_CONTACT ? '' : ' – Tipp: OSM_CONTACT mit deiner Kontakt-Adresse setzen';
  console.log(`\nSuche: ${p.understood.join(' · ')}\n(Nominatim/Overpass: höchstens 1 Anfrage pro Sekunde, eindeutiger User-Agent${uaHint})\n`);
  // „Möglichst vollständig“: die Standard-Obergrenzen (100 Leads/Lauf) würden den Lauf abbrechen. Nur erhöhen, nie senken; bleibt in den Einstellungen sichtbar.
  const cur = (await repo.getLimits()).limits;
  const want = { ...cur, maxLeadsPerRun: Math.max(cur.maxLeadsPerRun, 400), maxAuditsPerRun: Math.max(cur.maxAuditsPerRun, 400) };
  if (want.maxLeadsPerRun !== cur.maxLeadsPerRun || want.maxAuditsPerRun !== cur.maxAuditsPerRun) { await repo.saveLimits(want); console.log(`Limits für diesen Test erhöht: ${want.maxLeadsPerRun} Leads / ${want.maxAuditsPerRun} Analysen pro Lauf.`); }
  const runId = await ctx.runner.start(criteria);
  await ctx.runner.idle();
  console.log(formatReport(await buildReport(repo, runId, P.ai)));
  console.log(`\nIm Dashboard ansehen: ${ctx.baseUrl}/search/run/${runId}  und  /leads?run=${runId}\n${'Daten © OpenStreetMap-Mitwirkende (ODbL) – https://www.openstreetmap.org/copyright'}`);
} catch (e) {
  console.error(e instanceof CriteriaError ? `Eingabe: ${e.message}` : e instanceof Error ? e.message : e); process.exitCode = 1;
} finally { await repo.close(); }
