import type { Repo } from './repo.ts';
import type { SearchCriteria } from '../search/criteria.ts';

export class RunStore {
  repo: Repo;
  constructor(repo: Repo) { this.repo = repo; }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }

  async create(c: SearchCriteria, description: string): Promise<string> {
    const r = await this.pool.query('insert into lead_runs(owner_id, industry, region, radius_km, run_limit, status, criteria, description, counters) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id',
      [this.owner, c.industry ?? null, c.location, c.radiusKm, c.maxLeads, 'RUNNING', JSON.stringify(c), description, JSON.stringify({ found: 0, prefiltered: 0, analyzed: 0, matched: 0, errors: 0 })]);
    await this.repo.event(this.pool, null, 'search_started', { run_id: r.rows[0].id, description, actor: 'user' });
    return r.rows[0].id;
  }
  async createImport(label: string, n: number): Promise<string> {
    const r = await this.pool.query('insert into lead_runs(owner_id, industry, region, radius_km, run_limit, status, criteria, description, counters) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id',
      [this.owner, null, 'CSV-Import', null, Math.max(n, 1), 'RUNNING', JSON.stringify({ import: true, rows: n }), label, JSON.stringify({ found: n, prefiltered: 0, analyzed: 0, matched: 0, errors: 0 })]);
    await this.repo.event(this.pool, null, 'import_started', { run_id: r.rows[0].id, rows: n, actor: 'user' });
    return r.rows[0].id;
  }
  async running() { return (await this.pool.query("select id, created_at from lead_runs where owner_id=$1 and status='RUNNING' order by created_at desc", [this.owner])).rows; }
  async progress(id: string, counters: object) { await this.pool.query('update lead_runs set counters=$1 where id=$2 and owner_id=$3', [JSON.stringify(counters), id, this.owner]); }
  async finish(id: string, status: 'DONE' | 'STOPPED' | 'FAILED', summary: object, error?: string) {
    await this.pool.query('update lead_runs set status=$1, summary=$2, error=$3, finished_at=now() where id=$4 and owner_id=$5', [status, JSON.stringify(summary), error ?? null, id, this.owner]);
    await this.repo.event(this.pool, null, 'search_finished', { run_id: id, status, error: error ?? null, actor: 'system' });
  }
  async setRanks(runId: string, ranked: string[]) {
    for (let i = 0; i < ranked.length; i++) await this.pool.query('update run_results set rank=$1 where run_id=$2 and lead_id=$3 and owner_id=$4', [i + 1, runId, ranked[i], this.owner]);
  }
  /** Läufe, die beim Neustart noch als laufend markiert waren, sind abgebrochen worden. */
  async markInterrupted() {
    const r = await this.pool.query("update lead_runs set status='STOPPED', error='Durch Neustart unterbrochen', finished_at=now() where owner_id=$1 and status='RUNNING' returning id", [this.owner]);
    return r.rowCount ?? 0;
  }
  async list(limit = 20) { return (await this.pool.query('select id, created_at, finished_at, status, description, counters, summary, error from lead_runs where owner_id=$1 order by created_at desc limit $2', [this.owner, limit])).rows; }
  async get(id: string) { return (await this.pool.query('select * from lead_runs where id=$1 and owner_id=$2', [id, this.owner])).rows[0] ?? null; }
}
