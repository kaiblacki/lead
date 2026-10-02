import type { Repo } from '../db/repo.ts';
import type { AppConfig } from '../core/config.ts';
import type { SalesStore } from '../db/sales.ts';
import type { QuoteService } from '../pricing/service.ts';
import type { PartnerService } from '../partners/service.ts';
import { buildOfferFromQuote, type OfferV2 } from './from-quote.ts';

export const OFFER_STATUSES = ['DRAFT', 'READY_FOR_REVIEW', 'APPROVED', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];
export const OFFER_LABEL: Record<OfferStatus, string> = { DRAFT: 'Entwurf', READY_FOR_REVIEW: 'Zur Prüfung', APPROVED: 'Freigegeben', SENT: 'Versendet', ACCEPTED: 'Angenommen', DECLINED: 'Abgelehnt', EXPIRED: 'Abgelaufen' };

/** Angebotsgenerator: Entwurf aus dem Konfigurator → Prüfung → Freigabe → (von dir) versendet → angenommen/abgelehnt/abgelaufen. Das System sendet nie. */
export class OfferFlow {
  repo: Repo; cfg: AppConfig; sales: SalesStore; quotes: QuoteService; partners: PartnerService; now: () => Date; baseUrl: string;
  constructor(d: { repo: Repo; cfg: AppConfig; sales: SalesStore; quotes: QuoteService; partners: PartnerService; now?: () => Date; baseUrl: string }) { this.repo = d.repo; this.cfg = d.cfg; this.sales = d.sales; this.quotes = d.quotes; this.partners = d.partners; this.now = d.now ?? (() => new Date()); this.baseUrl = d.baseUrl; }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }

  async get(id: string) { return (await this.pool.query('select o.*, l.company_name from offers o join leads l on l.id=o.lead_id where o.id=$1 and o.owner_id=$2', [id, this.owner])).rows[0] ?? null; }
  async forLead(leadId: string) { return (await this.pool.query('select * from offers where lead_id=$1 and owner_id=$2 order by created_at desc', [leadId, this.owner])).rows; }

  /** Entwurf aus dem gespeicherten Konfigurator. Mit Partnerrabatt nur, wenn er freigegeben war UND der Lead noch aktiver Partner ist. */
  async createFromQuote(leadId: string): Promise<{ offerId: string; warnings: string[] }> {
    let q = await this.quotes.get(leadId); if (!q) throw new Error('Erst im Preis-Konfigurator ein Paket wählen und speichern.');
    q = (await this.quotes.recompute(leadId))!;
    const l = (await this.pool.query('select company_name, address, contact_blocked from leads where id=$1 and owner_id=$2', [leadId, this.owner])).rows[0]; if (!l) throw new Error('Lead nicht gefunden');
    const demo = (await this.sales.listDemos(leadId)).find((x: any) => !x.revoked && new Date(x.expires_at) > this.now());
    const offer = buildOfferFromQuote(this.cfg, q.computed, { customer: { name: l.company_name, address: l.address ?? undefined }, demoUrl: demo ? `${this.baseUrl}/d/${demo.token}` : undefined, now: this.now() });
    const r = await this.pool.query(`insert into offers(owner_id, lead_id, content, price_cents, deposit_cents, final_cents, maintenance_cents, demo_id, quote_snapshot, partner_discount_cents, valid_until)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`, [this.owner, leadId, JSON.stringify(offer), offer.priceCents, offer.depositCents, offer.finalCents, offer.maintenanceCentsPerMonth, demo?.id ?? null, JSON.stringify(q.computed), q.computed.partner_discount.applied ? q.computed.partner_discount.cents : 0, offer.validUntil]);
    await this.repo.event(this.pool, leadId, 'offer_created', { offer_id: r.rows[0].id, quote_based: true, actor: 'user' });
    return { offerId: r.rows[0].id, warnings: offer.warnings };
  }
  async markReady(id: string) {
    const r = await this.pool.query("update offers set status='READY_FOR_REVIEW' where id=$1 and owner_id=$2 and status='DRAFT' returning lead_id", [id, this.owner]); if (!r.rowCount) throw new Error('Nur ein Entwurf kann zur Prüfung gestellt werden.');
    await this.repo.event(this.pool, r.rows[0].lead_id, 'offer_ready', { offer_id: id, actor: 'user' });
  }
  /** Freigabe: Platzhalter müssen ersetzt sein; Preise (INTERNAL_DRAFT_PRICE) und ein Partnerrabatt brauchen deine ausdrückliche Bestätigung; der Partnerstatus muss noch gelten. */
  async approve(id: string, o: { confirmPrices?: boolean } = {}) {
    const off = await this.pool.query('select * from offers where id=$1 and owner_id=$2', [id, this.owner]); const cur = off.rows[0]; if (!cur) throw new Error('Angebot nicht gefunden');
    if (!['DRAFT', 'READY_FOR_REVIEW'].includes(cur.status)) throw new Error('Nur ein Entwurf bzw. ein Angebot zur Prüfung kann freigegeben werden.');
    const c = cur.content as OfferV2;
    if ((c.warnings ?? []).length) throw new Error('Das Angebot enthält noch Platzhalter (Lieferzeit, USt-Hinweis, Bedingungen, Wartungslaufzeit in config/pricing.json). Bitte zuerst ausfüllen.');
    if (c.internalDraft && !o.confirmPrices) throw new Error('Die Preise sind noch INTERNAL_DRAFT_PRICE – bitte bestätigen, dass sie für dieses Angebot gelten.');
    if (c.partnerDiscount?.applied && c.partnerDiscount.reason === 'ACTIVE_PARTNER' && (await this.partners.statusForLead(cur.lead_id)) !== 'ACTIVE_PARTNER') throw new Error('Der Partnerstatus ist nicht mehr aktiv – Angebot ohne Partnerpreis neu erstellen.');
    await this.pool.query("update offers set status='APPROVED', approved_at=now() where id=$1 and owner_id=$2", [id, this.owner]);
    await this.repo.event(this.pool, cur.lead_id, 'offer_approved', { offer_id: id, actor: 'user' });
  }
  async decline(id: string) {
    const r = await this.pool.query("update offers set status='DECLINED', declined_at=now() where id=$1 and owner_id=$2 and status in ('SENT','APPROVED') returning lead_id", [id, this.owner]); if (!r.rowCount) throw new Error('Nur ein freigegebenes oder versendetes Angebot kann abgelehnt werden.');
    await this.repo.event(this.pool, r.rows[0].lead_id, 'offer_declined', { offer_id: id, actor: 'user' });
  }
  /** Abgelaufene Angebote (Gültigkeit überschritten, noch nicht angenommen/abgelehnt) → EXPIRED. */
  async expireDue(): Promise<number> {
    const r = await this.pool.query("update offers set status='EXPIRED' where owner_id=$1 and status in ('DRAFT','READY_FOR_REVIEW','APPROVED','SENT') and coalesce(valid_until, nullif(content->>'validUntil','')::date) < $2::date", [this.owner, this.now()]);
    return r.rowCount ?? 0;
  }
}
