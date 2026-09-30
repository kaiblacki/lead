import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Repo } from './db/repo.ts';
import { buildContext, type Context } from './context.ts';
import { loadConfig } from './core/config.ts';
import { leadsFromCsv } from './connectors/csv.ts';
import { CriteriaError, normalizeCriteria, parseQuickSearch } from './search/criteria.ts';
import { EXAMPLE_SEARCHES } from './search/examples.ts';
import { buildFacts } from './core/profile.ts';
import { contentFromFacts } from './site/content.ts';
import { pickTemplate, templateByKey } from './site/templates.ts';
import { renderDemo, demoWarnings } from './site/engine.ts';

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const HELP = `Nutzung: node src/cli.ts <befehl>
  providers                         Aktive Provider (Mock/echt) anzeigen
  search "<Suchsatz>"               z. B. "Völklingen + 30 km + Nagelstudios + Website fehlt oder verbesserungswürdig"
  import <datei.csv>                Eigene Liste analysieren
  seed                              Beispielsuchen ausführen (füllt das Dashboard mit Mock-Daten)
  maintenance                       Fällige Wartungsprüfungen ausführen
  retention [--execute]             Datenaufbewahrung: Probelauf bzw. Löschung
  demo <datei.csv> [--n 1] [--out out/demo.html]   Demo-Seite offline aus einer CSV-Zeile erzeugen (ohne Datenbank)
Datenbank-Befehle brauchen DATABASE_URL und OWNER_ID (siehe SETUP.md).`;

async function withCtx<T>(fn: (c: Context, repo: Repo) => Promise<T>): Promise<T> {
  const repo = Repo.fromEnv();
  const ctx = buildContext(repo, { baseUrl: process.env.PUBLIC_BASE_URL ?? 'http://127.0.0.1:3000' });
  try { return await fn(ctx, repo); } finally { await repo.close(); }
}

async function runQuick(ctx: Context, text: string) {
  const p = parseQuickSearch(text, ctx.cfg.taxonomy);
  if (p.unmatched.length) throw new Error(`Nicht verstanden: ${p.unmatched.join(', ')}`);
  const c = normalizeCriteria(p.criteria, ctx.cfg.taxonomy);
  const id = await ctx.runner.start(c);
  await ctx.runner.idle();
  const run = (await ctx.runs.get(id))!;
  const list = await ctx.leads.list({ runId: id, matchedOnly: true, limit: 10 });
  console.log(`${run.description}\n→ ${run.status}: ${run.counters.matched} Treffer von ${run.counters.analyzed} analysiert${run.error ? ` (${run.error})` : ''}${run.summary?.stoppedReason ? ` (gestoppt: ${run.summary.stoppedReason})` : ''}`);
  for (const l of list.rows) console.log(`  ${String(l.score ?? '–').padStart(3)}  ${l.category?.padEnd(15) ?? ''} ${l.company_name} (${l.city ?? ''}) – Website: ${l.website_state}`);
  return run;
}

async function main() {
  const [cmd, arg] = args;
  switch (cmd) {
    case 'providers': { const reg = (await import('./providers/registry.ts')).createProviders(process.env, { baseUrl: 'http://127.0.0.1:3000' }); for (const s of reg.status) console.log(`${s.kind.padEnd(10)} ${s.name.padEnd(20)} ${s.mode.padEnd(5)} ${s.note}`); break; }
    case 'search': if (!arg) throw new Error('Suchsatz angeben'); await withCtx((c) => runQuick(c, arg)); break;
    case 'import': {
      if (!arg) throw new Error('CSV-Datei angeben');
      const { leads, skipped } = leadsFromCsv(readFileSync(arg, 'utf8')); skipped.forEach((s) => console.warn('Übersprungen:', s));
      await withCtx(async (c) => { const id = await c.runner.startImport(leads, `CSV-Import ${arg}`); await c.runner.idle(); const run = (await c.runs.get(id))!; console.log(`${run.status}: ${run.counters.analyzed} analysiert, ${run.counters.errors} Fehler`); });
      break;
    }
    case 'seed': await withCtx(async (c) => {
      if (c.registry.providers.places.isMock === false) throw new Error('seed ist nur im Mock-Modus erlaubt (APP_MODE=mock).');
      for (const q of EXAMPLE_SEARCHES) await runQuick(c, q);
    }); break;
    case 'maintenance': await withCtx(async (c) => console.log(await c.maintenance.runDue())); break;
    case 'retention': await withCtx(async (c) => { const out = args.includes('--execute') ? await c.retention.execute() : await c.retention.plan(); for (const r of out) console.log(`${String(r.count).padStart(5)}  ${r.label} (${r.days} Tage)`); if (!args.includes('--execute')) console.log('Probelauf. Mit --execute wirklich löschen.'); }); break;
    case 'demo': {
      if (!arg) throw new Error('CSV-Datei angeben');
      const cfg = loadConfig();
      const { leads } = leadsFromCsv(readFileSync(arg, 'utf8'));
      const lead = leads[Number(flag('n') ?? 1) - 1]; if (!lead) throw new Error('Lead nicht gefunden (--n beginnt bei 1)');
      const facts = buildFacts({ csv: lead, capturedAt: new Date().toISOString() });
      const sub = cfg.taxonomy.match(`${lead.industry ?? ''} ${lead.companyName}`);
      const t = flag('template') ? templateByKey(flag('template')!) : pickTemplate({ subIndustry: sub?.key, industryText: lead.industry, name: lead.companyName }, cfg.taxonomy);
      const { content, hints } = contentFromFacts(facts, t, cfg.taxonomy);
      const html = renderDemo(content, t, cfg.agency, { ...hints, noWebsite: !lead.websiteUrl });
      const out = flag('out') ?? 'out/demo.html'; mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, html);
      demoWarnings(html).forEach((w) => console.warn('Hinweis:', w)); console.log(`Demo (${t.label}) für ${lead.companyName} → ${out}`); break;
    }
    default: console.log(HELP); process.exit(cmd ? 1 : 0);
  }
}
main().catch((e) => { console.error(e instanceof CriteriaError ? e.errors.join('\n') : e.message); process.exit(1); });
