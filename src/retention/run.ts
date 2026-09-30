import type { Repo } from '../db/repo.ts';

export type RetentionConfig = { ignoredLeadDays: number; unscoredLeadDays: number; contactHistoryDays: number; auditLogDays: number; expiredDemoDays: number; snapshotDays: number; keepCustomerData: boolean };
export type RetentionPlan = { rule: string; label: string; count: number; days: number }[];

/** Datenaufbewahrung: löscht Daten, die nach der konfigurierten Frist nicht mehr nötig sind. Sperrlisten-Einträge und Kundendaten bleiben. */
export class Retention {
  repo: Repo; cfg: RetentionConfig;
  constructor(repo: Repo, cfg: RetentionConfig) { this.repo = repo; this.cfg = cfg; }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }

  private cut(days: number, now: Date) { return new Date(now.getTime() - days * 86400000); }
  private rules(now: Date) {
    const c = this.cfg;
    const leadActivity = 'greatest(l.created_at, coalesce(l.last_analyzed_at, l.created_at), coalesce(l.last_contact_at, l.created_at))';
    const noOrder = 'not exists (select 1 from orders o where o.lead_id = l.id)';
    return [
      { rule: 'ignoredLeads', label: 'Abgelehnte/zurückgestellte Leads ohne Bestellung', days: c.ignoredLeadDays,
        where: `from leads l where l.owner_id=$1 and l.status='IGNORED' and ${noOrder} and ${leadActivity} < $2`, table: 'leads l', del: 'delete from leads l', cut: this.cut(c.ignoredLeadDays, now) },
      { rule: 'unscoredLeads', label: 'Nicht bewertbare Leads (Erneut prüfen) ohne Bestellung', days: c.unscoredLeadDays,
        where: `from leads l where l.owner_id=$1 and l.status='RECHECK' and ${noOrder} and ${leadActivity} < $2`, table: 'leads l', del: 'delete from leads l', cut: this.cut(c.unscoredLeadDays, now) },
      { rule: 'contactHistory', label: 'Kontakt-Historie', days: c.contactHistoryDays, where: 'from contact_history x where x.owner_id=$1 and x.at < $2', table: 'contact_history x', del: 'delete from contact_history x', cut: this.cut(c.contactHistoryDays, now) },
      { rule: 'expiredDemos', label: 'Abgelaufene/widerrufene Demos', days: c.expiredDemoDays, where: 'from demos x where x.owner_id=$1 and (x.expires_at < $2 or (x.revoked and x.created_at < $2))', table: 'demos x', del: 'delete from demos x', cut: this.cut(c.expiredDemoDays, now) },
      { rule: 'snapshots', label: 'Score-Snapshots ohne Kundenbezug', days: c.snapshotDays, where: `from score_snapshots x where x.owner_id=$1 and x.created_at < $2 and not exists (select 1 from orders o where o.lead_id = x.lead_id)`, table: 'score_snapshots x', del: 'delete from score_snapshots x', cut: this.cut(c.snapshotDays, now) },
      { rule: 'auditLog', label: 'Audit-Log-Einträge', days: c.auditLogDays, where: 'from events x where x.owner_id=$1 and x.created_at < $2', table: 'events x', del: 'delete from events x', cut: this.cut(c.auditLogDays, now) },
    ];
  }

  async plan(now = new Date()): Promise<RetentionPlan> {
    const out: RetentionPlan = [];
    for (const r of this.rules(now)) out.push({ rule: r.rule, label: r.label, days: r.days, count: (await this.pool.query(`select count(*)::int n ${r.where}`, [this.owner, r.cut])).rows[0].n });
    return out;
  }

  /** Führt die Löschung aus (Reihenfolge: zuerst abhängige Daten, Audit-Log zuletzt) und protokolliert das Ergebnis. */
  async execute(now = new Date()): Promise<RetentionPlan> {
    const rules = this.rules(now);
    const result: RetentionPlan = [];
    await this.repo.tx(async (c) => {
      for (const r of rules) {
        const n = (await c.query(`${r.del} where ${r.where.replace(/^from [^ ]+ [a-z]+ where /, '')} returning 1`, [this.owner, r.cut])).rowCount ?? 0;
        result.push({ rule: r.rule, label: r.label, days: r.days, count: n });
      }
    });
    await this.repo.event(this.pool, null, 'retention_run', { actor: 'user', deleted: Object.fromEntries(result.map((r) => [r.rule, r.count])) });
    return result;
  }
}
