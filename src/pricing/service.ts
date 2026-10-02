import type { Repo } from '../db/repo.ts';
import type { AppConfig } from '../core/config.ts';
import type { PartnerService } from '../partners/service.ts';
import { computeQuote, type Quote, type QuoteSelection } from './quote.ts';

export type QuoteRow = { id: string; lead_id: string; package: string; selection: QuoteSelection; partner_discount_approved: boolean; partner_status: string | null; computed: Quote; updated_at: Date };

/** Preis-Konfiguration je Lead (Paket, Add-ons, Wartung, Partnerstatus). Der Partnerstatus kommt immer aus dem Partnerprofil des Leads. */
export class QuoteService {
  repo: Repo; cfg: AppConfig; partners: PartnerService;
  constructor(d: { repo: Repo; cfg: AppConfig; partners: PartnerService }) { this.repo = d.repo; this.cfg = d.cfg; this.partners = d.partners; }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }
  async get(leadId: string): Promise<QuoteRow | null> { return (await this.pool.query('select * from quotes where lead_id=$1 and owner_id=$2', [leadId, this.owner])).rows[0] ?? null; }

  /** Speichert (und berechnet neu). Partnerrabatt nur mit Freigabe und nur bei aktivem Partner – beides prüft computeQuote bzw. diese Methode. */
  async save(leadId: string, sel: Omit<QuoteSelection, 'partnerStatus' | 'partnerDiscountApproved'> & { partnerDiscountApproved?: boolean }): Promise<QuoteRow> {
    if (!(await this.pool.query('select 1 from leads where id=$1 and owner_id=$2', [leadId, this.owner])).rowCount) throw new Error('Lead nicht gefunden');
    const status = await this.partners.statusForLead(leadId);
    const approved = !!sel.partnerDiscountApproved && status === 'ACTIVE_PARTNER';
    if (sel.partnerDiscountApproved && status !== 'ACTIVE_PARTNER') throw new Error('Der Partnerpreis gilt nur für aktive Partner.');
    const full: QuoteSelection = { ...sel, partnerStatus: status, partnerDiscountApproved: approved };
    const computed = computeQuote(this.cfg, full);
    const r = await this.pool.query(`insert into quotes(owner_id, lead_id, package, selection, partner_discount_approved, partner_status, computed) values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (owner_id, lead_id) do update set package=$3, selection=$4, partner_discount_approved=$5, partner_status=$6, computed=$7, updated_at=now() returning *`,
      [this.owner, leadId, sel.package, JSON.stringify(full), approved, status, JSON.stringify(computed)]);
    await this.repo.event(this.pool, leadId, 'quote_saved', { package: sel.package, one_time_cents: computed.oneTimeCents, actor: 'user' });
    return r.rows[0];
  }
  /** Neu berechnen, z. B. wenn sich der Partnerstatus geändert hat (eine nicht mehr gültige Freigabe fällt weg). */
  async recompute(leadId: string): Promise<QuoteRow | null> { const q = await this.get(leadId); return q ? this.save(leadId, { ...q.selection, partnerDiscountApproved: q.partner_discount_approved && (await this.partners.statusForLead(leadId)) === 'ACTIVE_PARTNER' }) : null; }
}
