import type { Repo } from '../db/repo.ts';
import { enrichment } from '../core/enrichment.ts';

export type Report = {
  run: { id: string; description: string; status: string; error?: string | null; stoppedReason?: string };
  osm: { found: number; nailStudios: number; withWebsite: number; withPhone: number; incomplete: number; withoutWebsite: number; usage: Record<string, number> };
  ai: { websitesAnalyzed: number; scoresCreated: number; errors: number; errorSamples: string[]; aiProvider: string; aiCostPerLeadCents: number | null; aiRequests: number };
  sales: { contactReady: number; withPhone: number; top: number; best: { name: string; city: string | null; score: number | null; category: string | null; phone: string | null; website: string | null; service: string | null; reasons: string[]; opener: string | null }[] };
};

const NAIL = /nail|nagel|nägel|maniküre|manikure/i;

/** Kennzahlen eines Suchlaufs für den Abnahmetest – alles direkt aus der Datenbank, nichts geschätzt. */
export async function buildReport(repo: Repo, runId: string, aiProvider: { name: string; isMock: boolean }): Promise<Report> {
  const p = repo.pool, o = repo.ownerId;
  const run = (await p.query('select id, description, status, error, summary from lead_runs where id=$1 and owner_id=$2', [runId, o])).rows[0];
  const leads = (await p.query(`select l.id, l.company_name, l.city, l.phone, l.email, l.address, l.website_url, l.website_state, l.source, l.industry, l.sub_industry, l.contact_readiness, op.score, op.category, op.dimensions, sp.brief
    from run_results rr join leads l on l.id = rr.lead_id
    left join lateral (select score, category, dimensions from opportunities where lead_id = l.id order by created_at desc, id desc limit 1) op on true
    left join lateral (select brief from sales_packages where lead_id = l.id order by created_at desc, id desc limit 1) sp on true
    where rr.run_id=$1 and rr.owner_id=$2`, [runId, o])).rows;
  const cats = new Map<string, string[]>((await p.query(`select f.lead_id, f.value from lead_facts f join run_results rr on rr.lead_id = f.lead_id where rr.run_id=$1 and rr.owner_id=$2 and f.key='sourceCategories'`, [runId, o])).rows.map((r) => [r.lead_id, r.value as string[]]));
  /** „Eindeutig Nagelstudio“ = die QUELLE sagt es (OSM beauty=nails) oder der Firmenname nennt es – nicht die Suche, die alle Treffer so einordnet. */
  const isNail = (l: { id: string; company_name: string }) => (cats.get(l.id) ?? []).some((c) => /nails/i.test(c)) || NAIL.test(l.company_name);
  const audits = (await p.query(`select count(distinct a.lead_id)::int n from audits a join run_results rr on rr.lead_id = a.lead_id where rr.run_id=$1 and rr.owner_id=$2 and a.pages_analyzed > 0`, [runId, o])).rows[0].n as number;
  const ai = (await p.query(`select count(*)::int n, coalesce(sum(est_cents),0)::float c, count(distinct lead_id)::int leads from ai_usage where owner_id=$1 and created_at >= (select created_at from lead_runs where id=$2)`, [o, runId])).rows[0];
  const sum = run.summary ?? {};
  const scored = leads.filter((l) => l.score !== null);
  const best = [...leads].filter((l) => l.score !== null).sort((a, b) => b.score - a.score || (b.dimensions?.dataQuality?.value ?? 0) - (a.dimensions?.dataQuality?.value ?? 0)).slice(0, 5)
    .map((l) => ({ name: l.company_name, city: l.city, score: l.score, category: l.category, phone: l.phone, website: l.website_url, service: l.brief?.service?.name ?? null, reasons: (l.brief?.reasons ?? []).slice(0, 3).map((r: any) => r.text), opener: l.brief?.opener ?? null }));
  return {
    run: { id: run.id, description: run.description, status: run.status, error: run.error, stoppedReason: sum.stoppedReason },
    osm: { found: sum.found ?? leads.length, nailStudios: leads.filter(isNail).length, withWebsite: leads.filter((l) => l.website_url).length,
      withPhone: leads.filter((l) => l.phone).length, incomplete: leads.filter((l) => enrichment(l).needed).length, withoutWebsite: leads.filter((l) => !l.website_url).length, usage: sum.usage ?? {} },
    ai: { websitesAnalyzed: audits, scoresCreated: scored.length, errors: sum.errors ?? 0, errorSamples: sum.errorSamples ?? [], aiProvider: `${aiProvider.name}${aiProvider.isMock ? ' (Mock)' : ''}`, aiCostPerLeadCents: aiProvider.isMock ? null : ai.leads ? ai.c / ai.leads : 0, aiRequests: ai.n },
    sales: { contactReady: leads.filter((l) => l.contact_readiness === 'READY_FOR_MANUAL_CALL').length, withPhone: leads.filter((l) => l.phone && l.contact_readiness !== 'DO_NOT_CONTACT').length,
      top: leads.filter((l) => l.category === 'HOT' || l.category === 'HIGH POTENTIAL').length, best },
  };
}

export function formatReport(r: Report): string {
  const L: string[] = [];
  L.push(`SUCHLAUF: ${r.run.description}`, `Status: ${r.run.status}${r.run.stoppedReason ? ` (gestoppt: ${r.run.stoppedReason})` : ''}${r.run.error ? ` – Fehler: ${r.run.error}` : ''}`, '');
  L.push('OSM', `  Unternehmen gefunden:          ${r.osm.found}`, `  davon eindeutig Nagelstudios:  ${r.osm.nailStudios}`, `  mit Website:                   ${r.osm.withWebsite}`, `  ohne Website (NO_WEBSITE):     ${r.osm.withoutWebsite}`,
    `  mit Telefonnummer:             ${r.osm.withPhone}`, `  unvollständig (ENRICHMENT):    ${r.osm.incomplete}`, '');
  L.push('AI / ANALYSE', `  KI-Anbieter:                   ${r.ai.aiProvider}`, `  Websites analysiert:           ${r.ai.websitesAnalyzed}`, `  Scores erstellt:               ${r.ai.scoresCreated}`, `  Fehler:                        ${r.ai.errors}${r.ai.errorSamples.length ? '\n    - ' + r.ai.errorSamples.join('\n    - ') : ''}`,
    `  KI-Anfragen / Ø Kosten je Lead: ${r.ai.aiRequests} / ${r.ai.aiCostPerLeadCents === null ? 'nicht verfügbar (KI ist Mock, Anthropic nicht aktiv)' : `${r.ai.aiCostPerLeadCents.toFixed(2)} Cent`}`, '');
  L.push('SALES', `  kontaktbereit (Anruf):         ${r.sales.contactReady}${r.sales.contactReady === 0 ? ' (Telefonakquise in den Einstellungen noch nicht freigegeben?)' : ''}`, `  mit Telefonnummer (nicht gesperrt): ${r.sales.withPhone}`, `  TOP-Leads (HOT/HIGH):          ${r.sales.top}`, '  Beste 5:');
  r.sales.best.forEach((b, i) => L.push(`   ${i + 1}. ${b.name} (${b.city ?? 'nicht verfügbar'}) – Score ${b.score}, ${b.category}`, `      Tel: ${b.phone ?? 'nicht verfügbar'} · Website: ${b.website ?? 'nicht verfügbar'} · Leistung: ${b.service ?? 'nicht verfügbar'}`, ...b.reasons.map((x) => `      • ${x}`), ...(b.opener ? [`      ➜ ${b.opener}`] : [])));
  return L.join('\n');
}
