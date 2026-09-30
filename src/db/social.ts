import { randomUUID } from 'node:crypto';
import type { Repo } from './repo.ts';
import { validateItem, type Item } from '../social/generate.ts';

export class SocialStore {
  repo: Repo;
  constructor(repo: Repo) { this.repo = repo; }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }
  async createPlan(leadId: string, profile: string, items: Item[]): Promise<string> {
    const planId = randomUUID();
    await this.repo.tx(async (c) => {
      const l = await c.query('select 1 from leads where id=$1 and owner_id=$2', [leadId, this.owner]);
      if (!l.rowCount) throw new Error('Lead nicht gefunden');
      for (const i of items) await c.query('insert into social_items(owner_id, lead_id, plan_id, profile, scheduled_for, platform, format, title, body, hashtags, notes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [this.owner, leadId, planId, profile, i.date, i.platform, i.format, i.title, i.body, JSON.stringify(i.hashtags), JSON.stringify(i.notes)]);
      await this.repo.event(c, leadId, 'social_plan_created', { plan_id: planId, items: items.length, profile, actor: 'user' });
    });
    return planId;
  }
  async list(leadId: string) { return (await this.pool.query('select * from social_items where lead_id=$1 and owner_id=$2 order by scheduled_for, platform, created_at', [leadId, this.owner])).rows; }
  async setStatus(id: string, status: 'APPROVED' | 'REJECTED' | 'DRAFT') {
    const cur = (await this.pool.query('select platform, body, hashtags from social_items where id=$1 and owner_id=$2', [id, this.owner])).rows[0];
    if (!cur) throw new Error('Eintrag nicht gefunden');
    if (status === 'APPROVED') { const e = validateItem(cur); if (e.length) throw new Error(e.join('; ')); }
    const r = await this.pool.query("update social_items set status=$1, approved_at = case when $1='APPROVED' then now() else null end where id=$2 and owner_id=$3 returning lead_id", [status, id, this.owner]);
    await this.repo.event(this.pool, r.rows[0].lead_id, 'social_' + status.toLowerCase(), { item_id: id, actor: 'user' });
    return r.rows[0].lead_id as string;
  }
  async edit(id: string, title: string, body: string) {
    if (!title.trim() || !body.trim()) throw new Error('Titel und Text dürfen nicht leer sein');
    const r = await this.pool.query("update social_items set title=$1, body=$2, status='DRAFT', approved_at=null where id=$3 and owner_id=$4 returning lead_id", [title.trim().slice(0, 200), body.slice(0, 20000), id, this.owner]);
    if (!r.rowCount) throw new Error('Eintrag nicht gefunden');
    return r.rows[0].lead_id as string;
  }
}
