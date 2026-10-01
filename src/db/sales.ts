import { randomBytes } from 'node:crypto';
import type { Repo } from './repo.ts';
import type { Offer } from '../offers/generate.ts';
import { canTransition, findPath, type Status } from '../core/status.ts';
import { moveLead } from './lead-status.ts';

const PRE_SALE: Status[] = ['QUALIFIED', 'DEMO_CREATED', 'CONTACTED', 'REPLIED', 'INTERESTED', 'OFFER_SENT'];

export class SalesStore {
  repo: Repo;
  constructor(repo: Repo) { this.repo = repo; }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }

  // ---------- Demos ----------
  /** Legt eine Demo mit geheimem Link an und setzt den Lead auf „Demo erstellt“, wenn der Übergang erlaubt ist. */
  async createDemo(leadId: string, template: string, html: string, validDays: number, actor = 'user'): Promise<{ id: string; token: string }> {
    return this.repo.tx(async (c) => {
      const l = await c.query('select status from leads where id=$1 and owner_id=$2 for update', [leadId, this.owner]);
      if (!l.rows[0]) throw new Error('Lead nicht gefunden');
      const token = randomBytes(32).toString('hex');
      const r = await c.query("insert into demos(owner_id, lead_id, template, token, html, expires_at) values ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval) returning id", [this.owner, leadId, template, token, html, String(validDays)]);
      if (canTransition(l.rows[0].status as Status, 'DEMO_CREATED')) await moveLead(this.repo, c, leadId, 'DEMO_CREATED', 'Demo erstellt', actor);
      await this.repo.event(c, leadId, 'demo_created', { demo_id: r.rows[0].id, template, actor });
      return { id: r.rows[0].id, token };
    });
  }
  /** Inhalt einer bestehenden Demo ersetzen (Link und Ablauf bleiben). */
  async updateDemoHtml(demoId: string, template: string, html: string) {
    const r = await this.pool.query('update demos set html=$3, template=$4 where id=$1 and owner_id=$2 and not revoked returning lead_id', [demoId, this.owner, html, template]);
    if (!r.rowCount) throw new Error('Demo nicht gefunden');
    await this.repo.event(this.pool, r.rows[0].lead_id, 'demo_updated', { demo_id: demoId, template, actor: 'user' });
  }
  async listDemos(leadId: string) { return (await this.pool.query('select id, template, token, expires_at, revoked, view_count, last_viewed_at, created_at from demos where lead_id=$1 and owner_id=$2 order by created_at desc', [leadId, this.owner])).rows; }
  async revokeDemo(demoId: string) {
    const r = await this.pool.query('update demos set revoked=true where id=$1 and owner_id=$2 returning lead_id', [demoId, this.owner]);
    if (!r.rowCount) throw new Error('Demo nicht gefunden');
    await this.repo.event(this.pool, r.rows[0].lead_id, 'demo_revoked', { demo_id: demoId, actor: 'user' });
    return r.rows[0].lead_id as string;
  }
  /** Öffentlicher Abruf per Token (nur gültige, nicht widerrufene, nicht abgelaufene Demos). */
  async getDemoByToken(token: string): Promise<string | null> {
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    const r = await this.pool.query('update demos set view_count = view_count + 1, last_viewed_at = now() where token=$1 and owner_id=$2 and not revoked and expires_at > now() returning html', [token, this.owner]);
    return r.rows[0]?.html ?? null;
  }

  // ---------- Angebote ----------
  async createOffer(leadId: string, o: Offer, demoId?: string | null) {
    return this.repo.tx(async (c) => {
      const l = await c.query('select 1 from leads where id=$1 and owner_id=$2', [leadId, this.owner]);
      if (!l.rowCount) throw new Error('Lead nicht gefunden');
      const r = await c.query('insert into offers(owner_id, lead_id, content, price_cents, deposit_cents, final_cents, maintenance_cents, demo_id) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id',
        [this.owner, leadId, JSON.stringify(o), o.priceCents, o.depositCents, o.finalCents, o.maintenanceCentsPerMonth, demoId ?? null]);
      await this.repo.event(c, leadId, 'offer_created', { offer_id: r.rows[0].id, actor: 'user' });
      return r.rows[0].id as string;
    });
  }
  async latestOffer(leadId: string) { return (await this.pool.query('select * from offers where lead_id=$1 and owner_id=$2 order by created_at desc, id desc limit 1', [leadId, this.owner])).rows[0] ?? null; }
  async approveOffer(offerId: string) {
    const cur = (await this.pool.query('select content, status from offers where id=$1 and owner_id=$2', [offerId, this.owner])).rows[0];
    if (!cur || cur.status !== 'DRAFT') throw new Error('Angebot nicht gefunden oder nicht im Entwurf');
    if ((cur.content?.warnings ?? []).length) throw new Error('Das Angebot enthält noch Platzhalter (Lieferzeit, USt-Hinweis, Vertragsbedingungen in config/pricing.json). Bitte zuerst ausfüllen.');
    const r = await this.pool.query("update offers set status='APPROVED', approved_at=now() where id=$1 and owner_id=$2 and status='DRAFT' returning lead_id", [offerId, this.owner]);
    if (!r.rowCount) throw new Error('Angebot nicht gefunden oder nicht im Entwurf');
    await this.repo.event(this.pool, r.rows[0].lead_id, 'offer_approved', { offer_id: offerId, actor: 'user' });
    return r.rows[0].lead_id as string;
  }
  /** Markiert das Angebot als von dir versendet. Nur freigegebene Angebote; der Lead wandert automatisch auf „Angebot gesendet“. */
  async markOfferSent(offerId: string, actor = 'user') {
    return this.repo.tx(async (c) => {
      const o = await c.query('select lead_id, status, content from offers where id=$1 and owner_id=$2 for update', [offerId, this.owner]);
      if (!o.rows[0]) throw new Error('Angebot nicht gefunden');
      if (o.rows[0].status !== 'APPROVED') throw new Error('Angebot muss zuerst freigegeben werden');
      if ((o.rows[0].content?.warnings ?? []).length) throw new Error('Das Angebot enthält noch Platzhalter (config/pricing.json) und darf so nicht versendet werden.');
      const leadId = o.rows[0].lead_id as string;
      const cur = (await c.query('select status from leads where id=$1 and owner_id=$2', [leadId, this.owner])).rows[0].status as Status;
      if (cur !== 'OFFER_SENT' && !findPath(cur, 'OFFER_SENT', PRE_SALE).length) throw new Error(`Aus dem Status ${cur} ist kein Angebot möglich.`);
      await moveLead(this.repo, c, leadId, 'OFFER_SENT', 'Angebot versendet (manuell)', actor, { path: true, within: PRE_SALE });
      await c.query("update offers set status='SENT', sent_at=now() where id=$1 and owner_id=$2", [offerId, this.owner]);
      await this.repo.event(c, leadId, 'offer_sent', { offer_id: offerId, actor });
      return leadId;
    });
  }
}
