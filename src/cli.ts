import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { leadsFromCsv } from './connectors/csv.ts';
import { GooglePlacesSource } from './connectors/places.ts';
import { fetchSite } from './auditor/fetch.ts';
import { runPipeline } from './pipeline.ts';
import { renderReport } from './report/html.ts';
import { Budget, DEFAULT_LIMITS } from './guardrails/budget.ts';
import type { Lead } from './core/types.ts';
import { Repo } from './db/repo.ts';

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const json = (p: string) => JSON.parse(readFileSync(new URL(`../config/${p}`, import.meta.url), 'utf8'));

async function main() {
  const [cmd, file] = args;
  if (cmd !== 'analyze') {
    console.log('Nutzung:\n  node src/cli.ts analyze <leads.csv> [--out out/report.html] [--limit 100] [--offline]\n  node src/cli.ts analyze --search "Friseur" --region "Saarland" [--limit 20]   (braucht GOOGLE_PLACES_API_KEY)');
    process.exit(cmd ? 1 : 0);
  }
  const limit = Number(flag('limit') ?? DEFAULT_LIMITS.maxLeadsPerRun);
  let leads: Lead[];
  if (flag('search')) {
    leads = await new GooglePlacesSource().search({ industry: flag('search')!, region: flag('region') ?? '', radiusKm: Number(flag('radius') ?? 50), limit });
  } else {
    if (!file || file.startsWith('--')) throw new Error('CSV-Datei angeben');
    const r = leadsFromCsv(readFileSync(file, 'utf8'));
    r.skipped.forEach((s) => console.warn('Übersprungen:', s));
    leads = r.leads;
  }
  const offline = args.includes('--offline');
  const repo = args.includes('--save') ? Repo.fromEnv() : null;
  let limits = { ...DEFAULT_LIMITS, maxLeadsPerRun: limit, maxAuditsPerRun: limit };
  let scoring = json('scoring.json');
  let runId: string | null = null;
  if (repo) {
    const db = await repo.getLimits();
    limits = { ...db.limits, maxLeadsPerRun: Math.min(db.limits.maxLeadsPerRun, limit), maxAuditsPerRun: Math.min(db.limits.maxAuditsPerRun, limit) };
    scoring = await repo.getScoringConfig(scoring);
    if (db.killSwitch) { console.error('Kill Switch ist aktiv – Lauf abgebrochen.'); await repo.close(); process.exit(2); }
    runId = await repo.createRun(flag('search') ?? file ?? 'csv', flag('region') ?? '', null, limit);
  }
  const run = new Budget(limits);
  const { reports, stoppedReason } = await runPipeline(leads, {
    fetchSite: offline ? async () => ({ ok: false, error: 'offline-Modus' }) : fetchSite,
    scoring, pricing: json('pricing.json'), budget: run,
    beforeLead: repo ? async (l) => {
      if ((await repo.getLimits()).killSwitch) return 'stop';
      if (await repo.isPaused(l.source, l.id)) return 'skip';
    } : undefined,
    onReport: repo ? async (r) => { await repo.saveReport(r, runId); } : undefined,
  });
  if (repo && runId) { await repo.finishRun(runId, stoppedReason ? 'STOPPED' : 'DONE', { leads: reports.length, stoppedReason: stoppedReason ?? null }); await repo.close(); }
  const out = flag('out') ?? 'out/report.html';
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderReport(reports, { title: 'Lead-Analyse', stoppedReason }));
  console.log(`${reports.length} Leads analysiert → ${out}${stoppedReason ? `\nGestoppt: ${stoppedReason}` : ''}`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
