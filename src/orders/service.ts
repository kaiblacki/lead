import type pg from 'pg';
import type { Repo } from '../db/repo.ts';
import { moveLead, recordOutcome } from '../db/lead-status.ts';
import { assertOrderTransition, type OrderStatus } from './status.ts';
import type { PaymentProvider } from '../providers/types.ts';
import { buildMockEvent } from '../providers/mock/payment.ts';
import type { SiteContent } from '../site/engine.ts';
import { contentFromFacts } from '../site/content.ts';
import { pickTemplate } from '../site/templates.ts';
import type { AppConfig } from '../core/config.ts';
import type { Fact, FactKey } from '../core/profile.ts';

export type Kind = 'deposit' | 'final' | 'maintenance';
export type ProjectContent = SiteContent;

export class OrderService {
  repo: Repo; cfg: AppConfig; now: () => Date;
  constructor(repo: Repo, cfg: AppConfig, now: () => Date = () => new Date()) { this.repo = repo; this.cfg = cfg; this.now = now; }

  async setOrderStatus(c: pg.PoolClient, orderId: string, from: OrderStatus, to: OrderStatus, reason: string, actor = 'system') {
    assertOrderTransition(from, to);
    const r = await c.query('update orders set status=$1, updated_at=now() where id=$2 and owner_id=$3 and status=$4', [to, orderId, this.repo.ownerId, from]);
    if (!r.rowCount) throw new Error(`Bestellung nicht im Status ${from}`);
    await this.repo.event(c, null, 'order_status', { order_id: orderId, from, to, reason, actor });
  }
  /** Lead-Status im Gleichschritt mit der Bestellung (nur erlaubte Schritte, Audit + Learning Loop inklusive). */
  async setLeadStatus(c: pg.PoolClient, leadId: string, to: Parameters<typeof moveLead>[3], reason: string, actor = 'system') {
    await moveLead(this.repo, c, leadId, to, reason, actor);
  }

  /**
   * Angebot angenommen → Bestellung anlegen → Anzahlung offen. Voraussetzung: ein versendetes (oder bereits angenommenes) Angebot.
   * Lead: OFFER_SENT → OFFER_ACCEPTED → DEPOSIT_PENDING.
   */
  async acceptOffer(leadId: string, actor = 'user'): Promise<string> {
    return this.repo.tx(async (c) => {
      const o = await c.query("select * from offers where lead_id=$1 and owner_id=$2 and status in ('SENT','ACCEPTED') order by created_at desc limit 1 for update", [leadId, this.repo.ownerId]);
      if (!o.rows[0]) throw new Error('Kein versendetes Angebot vorhanden. Erst Angebot erstellen, freigeben und als versendet markieren.');
      const ex = await c.query('select id from orders where offer_id=$1', [o.rows[0].id]);
      if (ex.rows[0]) return ex.rows[0].id as string;
      await c.query("update offers set status='ACCEPTED', accepted_at=now() where id=$1 and owner_id=$2", [o.rows[0].id, this.repo.ownerId]);
      const r = await c.query('insert into orders(owner_id, lead_id, offer_id, deposit_cents, final_cents, maintenance_cents) values ($1,$2,$3,$4,$5,$6) returning id',
        [this.repo.ownerId, leadId, o.rows[0].id, o.rows[0].deposit_cents, o.rows[0].final_cents, o.rows[0].maintenance_cents]);
      await moveLead(this.repo, c, leadId, 'OFFER_ACCEPTED', 'Angebot angenommen', actor);
      await moveLead(this.repo, c, leadId, 'DEPOSIT_PENDING', 'Bestellung angelegt, Anzahlung offen', 'system');
      await this.repo.event(c, leadId, 'order_created', { order_id: r.rows[0].id, actor });
      return r.rows[0].id as string;
    });
  }
  /** Kompatibilität: Bestellung anlegen = Angebot annehmen. */
  createOrder(leadId: string) { return this.acceptOffer(leadId); }

  async getOrder(orderId: string) { return (await this.repo.pool.query('select * from orders where id=$1 and owner_id=$2', [orderId, this.repo.ownerId])).rows[0] ?? null; }
  async orderForLead(leadId: string) { return (await this.repo.pool.query('select * from orders where lead_id=$1 and owner_id=$2 order by created_at desc limit 1', [leadId, this.repo.ownerId])).rows[0] ?? null; }
  async payments(orderId: string) { return (await this.repo.pool.query('select * from payments where order_id=$1 and owner_id=$2 order by created_at', [orderId, this.repo.ownerId])).rows; }

  /** Erzeugt (oder nutzt wieder) einen Checkout-Link. Die Reihenfolge der Zahlungen wird vom Bestellstatus erzwungen. */
  async startCheckout(orderId: string, kind: Kind, provider: PaymentProvider, baseUrl: string, customerEmail?: string) {
    const order = await this.getOrder(orderId);
    if (!order) throw new Error('Bestellung nicht gefunden');
    const allowed: Record<Kind, OrderStatus> = { deposit: 'PAYMENT_PENDING', final: 'FINAL_PAYMENT_PENDING', maintenance: 'DEPLOYED' };
    if (order.status !== allowed[kind]) throw new Error(`Zahlung "${kind}" ist im Status ${order.status} nicht möglich`);
    const amount = kind === 'deposit' ? order.deposit_cents : kind === 'final' ? order.final_cents : order.maintenance_cents;
    if (amount <= 0) throw new Error(`Betrag für "${kind}" ist 0 – kein Checkout nötig`);
    const existing = (await this.repo.pool.query("select * from payments where order_id=$1 and kind=$2 and status='pending' and owner_id=$3 order by created_at desc limit 1", [orderId, kind, this.repo.ownerId])).rows[0];
    if (existing?.checkout_url && existing.provider === provider.name && Date.now() - new Date(existing.created_at).getTime() < 23 * 3600_000) return { url: existing.checkout_url as string, paymentId: existing.id as string, reused: true };
    if (existing) await this.repo.pool.query("update payments set status='expired' where id=$1", [existing.id]);
    const pay = await this.repo.pool.query('insert into payments(owner_id, order_id, kind, amount_cents, currency, provider) values ($1,$2,$3,$4,$5,$6) returning id', [this.repo.ownerId, orderId, kind, amount, order.currency, provider.name]);
    const paymentId = pay.rows[0].id as string;
    const label = { deposit: 'Anzahlung Website', final: 'Restzahlung Website', maintenance: 'Wartung Website (monatlich)' }[kind];
    try {
      const s = await provider.createCheckout({ amountCents: amount, currency: order.currency, description: label, mode: kind === 'maintenance' ? 'subscription' : 'payment', orderId, paymentId, successUrl: `${baseUrl}/danke`, cancelUrl: `${baseUrl}/abgebrochen`, customerEmail });
      await this.repo.pool.query('update payments set provider_ref=$1, checkout_url=$2 where id=$3', [s.id, s.url, paymentId]);
      await this.repo.event(this.repo.pool, order.lead_id, 'checkout_created', { order_id: orderId, kind, payment_id: paymentId, provider: provider.name, actor: 'system' });
      return { url: s.url, paymentId, reused: false };
    } catch (e) {
      await this.repo.pool.query("update payments set status='failed' where id=$1", [paymentId]);
      throw e;
    }
  }

  /** Mock-Zahlung: baut ein signiertes Stripe-Ereignis und schickt es durch denselben Webhook-Code wie bei Stripe. */
  async simulatePayment(paymentId: string, provider: PaymentProvider) {
    if (!provider.isMock) throw new Error('Zahlungen lassen sich nur mit dem Mock-Provider simulieren.');
    const p = (await this.repo.pool.query("select * from payments where id=$1 and owner_id=$2 and status='pending'", [paymentId, this.repo.ownerId])).rows[0];
    if (!p || !p.provider_ref) throw new Error('Keine offene Zahlung gefunden');
    const ev = buildMockEvent({ type: 'checkout.session.completed', sessionId: p.provider_ref, amountCents: p.amount_cents, currency: p.currency, mode: p.kind === 'maintenance' ? 'subscription' : 'payment' }, this.now().getTime());
    return this.handleWebhook(ev.body, ev.signature, provider);
  }
  /** Mock: Abo-Probleme simulieren (Kündigung / fehlgeschlagene Zahlung). */
  async simulateSubscriptionProblem(orderId: string, reason: 'canceled' | 'payment_failed', provider: PaymentProvider) {
    if (!provider.isMock) throw new Error('Nur mit dem Mock-Provider möglich.');
    const ev = buildMockEvent({ type: reason === 'canceled' ? 'customer.subscription.deleted' : 'invoice.payment_failed', orderId }, this.now().getTime());
    return this.handleWebhook(ev.body, ev.signature, provider);
  }

  /** Verarbeitet einen Webhook. Idempotent, prüft Betrag und Währung, treibt den Bestellstatus nur in erlaubten Schritten voran. */
  async handleWebhook(rawBody: string, signature: string | undefined, provider: PaymentProvider): Promise<{ handled: string; orderId?: string; kind?: string }> {
    const ev = provider.parseWebhook(rawBody, signature, this.now().getTime());
    if (ev.kind === 'ignored') return { handled: 'ignored' };
    if (ev.kind === 'subscription_problem') {
      return this.repo.tx(async (c) => {
        const seen = await c.query('insert into webhook_events(id, owner_id, type) values ($1,$2,$3) on conflict do nothing', [ev.id, this.repo.ownerId, ev.kind]);
        if (!seen.rowCount) return { handled: 'duplicate' };
        if (!/^[0-9a-f-]{36}$/.test(ev.orderId)) return { handled: 'unknown_order' };
        const o = (await c.query('select lead_id from orders where id=$1 and owner_id=$2', [ev.orderId, this.repo.ownerId])).rows[0];
        if (!o) return { handled: 'unknown_order' };
        await this.repo.event(c, o.lead_id, ev.reason === 'canceled' ? 'subscription_canceled' : 'subscription_payment_failed', { order_id: ev.orderId, actor: 'system' });
        if (ev.reason === 'canceled') await c.query("update maintenance_plans set status='CANCELED' where order_id=$1 and owner_id=$2", [ev.orderId, this.repo.ownerId]);
        else await c.query(`insert into maintenance_tasks(owner_id, order_id, title, detail, source) select $1,$2,'Zahlung des Wartungs-Abos fehlgeschlagen','Bitte mit dem Kunden klären.','check' where not exists (select 1 from maintenance_tasks where order_id=$2 and status='OPEN' and title='Zahlung des Wartungs-Abos fehlgeschlagen')`, [this.repo.ownerId, ev.orderId]);
        return { handled: 'subscription_problem', orderId: ev.orderId, kind: ev.reason };
      });
    }
    return this.repo.tx(async (c) => {
      const seen = await c.query('insert into webhook_events(id, owner_id, type) values ($1,$2,$3) on conflict do nothing', [ev.id, this.repo.ownerId, ev.kind]);
      if (!seen.rowCount) return { handled: 'duplicate' };
      const p = (await c.query('select p.*, o.lead_id, o.status as order_status, o.maintenance_cents from payments p join orders o on o.id=p.order_id where p.provider_ref=$1 and p.owner_id=$2 for update of p', [ev.sessionId, this.repo.ownerId])).rows[0];
      if (!p) return { handled: 'unknown_payment' };
      if (ev.kind === 'expired') { await c.query("update payments set status='expired' where id=$1 and status='pending'", [p.id]); return { handled: 'expired' }; }
      if (p.status !== 'pending') return { handled: 'not_pending' };
      if (ev.amountCents !== p.amount_cents || ev.currency.toLowerCase() !== p.currency.toLowerCase()) {
        await this.repo.event(c, p.lead_id, 'payment_mismatch', { payment_id: p.id, expected: p.amount_cents, got: ev.amountCents, actor: 'system' });
        return { handled: 'mismatch' };
      }
      await c.query("update payments set status='paid', paid_at=now() where id=$1", [p.id]);
      await this.repo.event(c, p.lead_id, 'payment_paid', { payment_id: p.id, kind: p.kind, amount_cents: p.amount_cents, provider: p.provider, actor: 'system' });
      const os = p.order_status as OrderStatus;
      if (p.kind === 'deposit' && os === 'PAYMENT_PENDING') {
        await this.setOrderStatus(c, p.order_id, os, 'DEPOSIT_PAID', 'Anzahlung eingegangen');
        await this.setOrderStatus(c, p.order_id, 'DEPOSIT_PAID', 'IN_PRODUCTION', 'Produktion gestartet');
        await this.setLeadStatus(c, p.lead_id, 'DEPOSIT_PAID', 'Anzahlung eingegangen');
        await this.setLeadStatus(c, p.lead_id, 'PRODUCTION', 'Produktion gestartet');
        await recordOutcome(this.repo, c, p.lead_id, 'final', 'WON', { order_id: p.order_id, deposit_cents: p.amount_cents });
        await this.createProject(c, p.order_id, p.lead_id);
      } else if (p.kind === 'final' && os === 'FINAL_PAYMENT_PENDING') {
        await this.setOrderStatus(c, p.order_id, os, 'FULLY_PAID', 'Restzahlung eingegangen');
      } else if (p.kind === 'maintenance' && os === 'DEPLOYED') {
        await this.setOrderStatus(c, p.order_id, os, 'MAINTENANCE_ACTIVE', 'Wartung aktiviert');
        await this.setLeadStatus(c, p.lead_id, 'MAINTENANCE', 'Wartung aktiviert');
        const next = new Date(this.now().getTime() + 7 * 86400000);
        await c.query(`insert into maintenance_plans(owner_id, order_id, monthly_cents, next_check_at) values ($1,$2,$3,$4) on conflict (order_id) do update set status='ACTIVE', monthly_cents=$3`, [this.repo.ownerId, p.order_id, p.amount_cents, next]);
      }
      return { handled: 'paid', orderId: p.order_id, kind: p.kind };
    });
  }

  /** Projekt aus den gespeicherten Fakten anlegen: echte Angaben übernehmen, Beispieltexte bleiben erkennbar (die QA blockiert sie). */
  private async createProject(c: pg.PoolClient, orderId: string, leadId: string) {
    const fr = await c.query('select key, value, source, source_url, note, quality, captured_at from lead_facts where lead_id=$1 and owner_id=$2', [leadId, this.repo.ownerId]);
    const facts: Fact[] = fr.rows.map((x) => ({ key: x.key as FactKey, value: x.value, source: x.source, url: x.source_url ?? undefined, note: x.note ?? undefined, quality: x.quality, capturedAt: x.captured_at.toISOString() }));
    const l = (await c.query('select company_name, sub_industry, industry from leads where id=$1 and owner_id=$2', [leadId, this.repo.ownerId])).rows[0];
    const tpl = pickTemplate({ subIndustry: l.sub_industry, industryText: l.industry, name: l.company_name }, this.cfg.taxonomy);
    const { content } = contentFromFacts(facts, tpl, this.cfg.taxonomy, { forProduction: true });
    await c.query('insert into projects(owner_id, order_id, template, content) values ($1,$2,$3,$4) on conflict (order_id) do nothing', [this.repo.ownerId, orderId, tpl.key, JSON.stringify(content)]);
  }
}
