import type { Repo } from '../db/repo.ts';
import { suppressionKeys } from '../contact/strategy.ts';
import type { LeadStore } from '../db/leads.ts';

/** DSGVO-Werkzeuge je Lead: Auskunft (Art. 15, alle gespeicherten Daten als JSON) und Löschung (Art. 17) mit Eintrag in die Sperrliste, damit der Lead nicht wieder auftaucht. */
export class Gdpr {
  repo: Repo; leads: LeadStore;
  constructor(repo: Repo, leads: LeadStore) { this.repo = repo; this.leads = leads; }
  private get pool() { return this.repo.pool; }

  async export(leadId: string) {
    const o = this.repo.ownerId;
    const lead = (await this.pool.query('select * from leads where id=$1 and owner_id=$2', [leadId, o])).rows[0];
    if (!lead) throw new Error('Lead nicht gefunden');
    const q = async (sql: string) => (await this.pool.query(sql, [leadId, o])).rows;
    const out = {
      exportedAt: new Date().toISOString(), hinweis: 'Alle zu diesem Unternehmen gespeicherten Daten (Auskunft nach Art. 15 DSGVO).',
      lead,
      facts: await q('select key, value, source, source_url, quality, captured_at, note from lead_facts where lead_id=$1 and owner_id=$2 order by key'),
      contactHistory: await q('select at, channel, direction, result, note, callback_at from contact_history where lead_id=$1 and owner_id=$2 order by at'),
      audits: await q('select * from audits where lead_id=$1 and owner_id=$2'),
      opportunities: await q('select score, category, created_at from opportunities where lead_id=$1 and owner_id=$2'),
      salesPackages: await q('select opener, brief, approved_at, created_at from sales_packages where lead_id=$1 and owner_id=$2'),
      demos: await q('select template, created_at, expires_at, revoked, view_count from demos where lead_id=$1 and owner_id=$2'),
      offers: await q('select status, price_cents, deposit_cents, final_cents, created_at from offers where lead_id=$1 and owner_id=$2'),
      orders: await q('select id, status, deposit_cents, final_cents, maintenance_cents, created_at from orders where lead_id=$1 and owner_id=$2'),
      outbox: await q('select kind, to_addr, subject, status, created_at from outbox where lead_id=$1 and owner_id=$2'),
      events: await q('select type, payload, created_at from events where lead_id=$1 and owner_id=$2 order by created_at'),
    };
    await this.repo.event(this.pool, leadId, 'gdpr_export', { actor: 'user' });
    return out;
  }

  /** Löscht den Lead samt abhängiger Daten. Kunden mit Auftrag werden nicht gelöscht (Aufbewahrungspflichten, § 147 AO / § 257 HGB) – dort nur sperren. */
  async erase(leadId: string): Promise<{ suppressed: number }> {
    const o = this.repo.ownerId;
    const lead = (await this.pool.query('select company_name from leads where id=$1 and owner_id=$2', [leadId, o])).rows[0];
    if (!lead) throw new Error('Lead nicht gefunden');
    if ((await this.pool.query('select 1 from orders where lead_id=$1 and owner_id=$2 limit 1', [leadId, o])).rowCount) throw new Error('Dieser Lead ist Kunde (Auftrag vorhanden): Daten unterliegen gesetzlichen Aufbewahrungspflichten und werden nicht gelöscht. Stattdessen „Nicht mehr kontaktieren“ setzen.');
    const facts = await this.leads.factsOf(leadId);
    const keys = suppressionKeys(facts, lead.company_name).filter((k) => k.kind !== 'domain' || !/^(gmail|gmx|web|t-online|outlook|yahoo|mail)\./.test(k.value));
    await this.repo.tx(async (c) => {
      for (const k of keys) await this.repo.addSuppression(k.kind, k.value, 'DSGVO-Löschung', null, c);
      await c.query('delete from leads where id=$1 and owner_id=$2', [leadId, o]);
      await this.repo.event(c, null, 'gdpr_erased', { actor: 'user', suppressed: keys.length });
    });
    return { suppressed: keys.length };
  }
}
