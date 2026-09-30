import type { Repo } from '../db/repo.ts';
import { transition, type Status } from '../core/status.ts';
import { assertOrderTransition, type OrderStatus } from './status.ts';
import type { PaymentProvider } from '../payments/provider.ts';
import { pickTemplate } from '../templates/index.ts';

export type Kind = 'deposit' | 'final' | 'maintenance';
export type ProjectContent = {
  companyName: string; industry?: string; address?: string; city?: string; phone?: string; email?: string; openingHours?: string;
  tagline?: string; about?: string; bookingUrl?: string; services: { title: string; text: string }[];
  legal: { owner?: string; vatId?: string; register?: string; hosting?: string };
};

export class OrderService {
  repo: Repo;
  constructor(repo: Repo) { this.repo = repo; }

  async setOrderStatus(c: import('pg').PoolClient, orderId: string, from: OrderStatus, to: OrderStatus, reason: string, actor = 'system') {
    assertOrderTransition(from, to);
    const r = await c.query('update orders set status=$1, updated_at=now() where id=$2 and owner_id=$3 and status=$4', [to, orderId, this.repo.ownerId, from]);
    if (!r.rowCount) throw new Error(`Bestellung nicht im Status ${from}`);
    await this.repo.event(c, null, 'order_status', { order_id: orderId, from, to, reason, actor });
  }
  async setLeadStatus(c: import('pg').PoolClient, leadId: string, to: Status, reason: string) {
    const l = await c.query('select status from leads where id=$1 and owner_id=$2 for update', [leadId, this.repo.ownerId]);
    const from = l.rows[0].status as Status;
    if (from === to) return;
    const ev = transition(leadId, from, to, reason);
    await c.query('update leads set status=$1 where id=$2 and owner_id=$3', [to, leadId, this.repo.ownerId]);
    await this.repo.event(c, leadId, 'status_change', { from: ev.from, to: ev.to, reason, actor: 'system' });
  }

  /** Legt die Bestellung an, sobald das Angebot versendet wurde. Gültig ist nur ein freigegebenes und versendetes Angebot. */
  async createOrder(leadId: string) {
    return this.repo.tx(async (c) => {
      const o = await c.query("select * from offers where lead_id=$1 and owner_id=$2 and status='SENT' order by created_at desc limit 1", [leadId, this.repo.ownerId]);
      if (!o.rows[0]) throw new Error('Kein versendetes Angebot vorhanden');
      const ex = await c.query('select id from orders where offer_id=$1', [o.rows[0].id]);
      if (ex.rows[0]) return ex.rows[0].id as string;
      const r = await c.query('insert into orders(owner_id, lead_id, offer_id, deposit_cents, final_cents, maintenance_cents) values ($1,$2,$3,$4,$5,$6) returning id',
        [this.repo.ownerId, leadId, o.rows[0].id, o.rows[0].deposit_cents, o.rows[0].final_cents, o.rows[0].maintenance_cents]);
      await this.setLeadStatus(c, leadId, 'DEPOSIT_PENDING', 'Bestellung angelegt');
      await this.repo.event(c, leadId, 'order_created', { order_id: r.rows[0].id, actor: 'user' });
      return r.rows[0].id as string;
    });
  }

  async getOrder(orderId: string) {
    return (await this.repo.pool.query('select * from orders where id=$1 and owner_id=$2', [orderId, this.repo.ownerId])).rows[0] ?? null;
  }
  async orderForLead(leadId: string) {
    return (await this.repo.pool.query('select * from orders where lead_id=$1 and owner_id=$2 order by created_at desc limit 1', [leadId, this.repo.ownerId])).rows[0] ?? null;
  }
  async payments(orderId: string) {
    return (await this.repo.pool.query('select * from payments where order_id=$1 and owner_id=$2 order by created_at', [orderId, this.repo.ownerId])).rows;
  }

  /** Erzeugt (oder nutzt wieder) einen Checkout-Link. Die Reihenfolge der Zahlungen wird vom Bestellstatus erzwungen. */
  async startCheckout(orderId: string, kind: Kind, provider: PaymentProvider, baseUrl: string, customerEmail?: string) {
    const order = await this.getOrder(orderId);
    if (!order) throw new Error('Bestellung nicht gefunden');
    const allowed: Record<Kind, OrderStatus> = { deposit: 'PAYMENT_PENDING', final: 'FINAL_PAYMENT_PENDING', maintenance: 'DEPLOYED' };
    if (order.status !== allowed[kind]) throw new Error(`Zahlung "${kind}" ist im Status ${order.status} nicht möglich`);
    const amount = kind === 'deposit' ? order.deposit_cents : kind === 'final' ? order.final_cents : order.maintenance_cents;
    if (amount <= 0) throw new Error(`Betrag für "${kind}" ist 0 – kein Checkout nötig`);
    const existing = (await this.repo.pool.query("select * from payments where order_id=$1 and kind=$2 and status='pending' and owner_id=$3 order by created_at desc limit 1", [orderId, kind, this.repo.ownerId])).rows[0];
    if (existing?.checkout_url && Date.now() - new Date(existing.created_at).getTime() < 23 * 3600_000) return { url: existing.checkout_url as string, paymentId: existing.id as string, reused: true };
    if (existing) await this.repo.pool.query("update payments set status='expired' where id=$1", [existing.id]);
    const pay = await this.repo.pool.query('insert into payments(owner_id, order_id, kind, amount_cents, currency, provider) values ($1,$2,$3,$4,$5,$6) returning id',
      [this.repo.ownerId, orderId, kind, amount, order.currency, provider.name]);
    const paymentId = pay.rows[0].id as string;
    const label = { deposit: 'Anzahlung Website', final: 'Restzahlung Website', maintenance: 'Wartung Website (monatlich)' }[kind];
    try {
      const s = await provider.createCheckout({ amountCents: amount, currency: order.currency, description: label, mode: kind === 'maintenance' ? 'subscription' : 'payment',
        orderId, paymentId, successUrl: `${baseUrl}/danke`, cancelUrl: `${baseUrl}/abgebrochen`, customerEmail });
      await this.repo.pool.query('update payments set provider_ref=$1, checkout_url=$2 where id=$3', [s.id, s.url, paymentId]);
      await this.repo.event(this.repo.pool, order.lead_id, 'checkout_created', { order_id: orderId, kind, payment_id: paymentId, actor: 'system' });
      return { url: s.url, paymentId, reused: false };
    } catch (e) {
      await this.repo.pool.query("update payments set status='failed' where id=$1", [paymentId]);
      throw e;
    }
  }

  /** Verarbeitet einen Webhook. Idempotent, prüft Betrag und Währung, treibt den Bestellstatus nur in erlaubten Schritten voran. */
  async handleWebhook(rawBody: string, signature: string | undefined, provider: PaymentProvider): Promise<{ handled: string; orderId?: string; kind?: string }> {
    const ev = provider.parseWebhook(rawBody, signature);
    if (ev.kind === 'ignored') return { handled: 'ignored' };
    if (ev.kind === 'subscription_problem') {
      return this.repo.tx(async (c) => {
        const seen = await c.query('insert into webhook_events(id, owner_id, type) values ($1,$2,$3) on conflict do nothing', [ev.id, this.repo.ownerId, ev.kind]);
        if (!seen.rowCount) return { handled: 'duplicate' };
        if (!/^[0-9a-f-]{36}$/.test(ev.orderId)) return { handled: 'unknown_order' };
        const o = (await c.query('select lead_id from orders where id=$1 and owner_id=$2', [ev.orderId, this.repo.ownerId])).rows[0];
        if (!o) return { handled: 'unknown_order' };
        await this.repo.event(c, o.lead_id, ev.reason === 'canceled' ? 'subscription_canceled' : 'subscription_payment_failed', { order_id: ev.orderId, actor: 'system' });
        return { handled: 'subscription_problem', orderId: ev.orderId, kind: ev.reason };
      });
    }
    return this.repo.tx(async (c) => {
      const seen = await c.query('insert into webhook_events(id, owner_id, type) values ($1,$2,$3) on conflict do nothing', [ev.id, this.repo.ownerId, ev.kind]);
      if (!seen.rowCount) return { handled: 'duplicate' };
      const p = (await c.query('select p.*, o.lead_id, o.status as order_status from payments p join orders o on o.id=p.order_id where p.provider_ref=$1 and p.owner_id=$2 for update of p', [ev.sessionId, this.repo.ownerId])).rows[0];
      if (!p) return { handled: 'unknown_payment' };
      if (ev.kind === 'expired') { await c.query("update payments set status='expired' where id=$1 and status='pending'", [p.id]); return { handled: 'expired' }; }
      if (p.status !== 'pending') return { handled: 'not_pending' };
      if (ev.amountCents !== p.amount_cents || ev.currency.toLowerCase() !== p.currency.toLowerCase()) {
        await this.repo.event(c, p.lead_id, 'payment_mismatch', { payment_id: p.id, expected: p.amount_cents, got: ev.amountCents, actor: 'system' });
        return { handled: 'mismatch' };
      }
      await c.query("update payments set status='paid', paid_at=now() where id=$1", [p.id]);
      await this.repo.event(c, p.lead_id, 'payment_paid', { payment_id: p.id, kind: p.kind, amount_cents: p.amount_cents, actor: 'system' });
      const os = p.order_status as OrderStatus;
      if (p.kind === 'deposit' && os === 'PAYMENT_PENDING') {
        await this.setOrderStatus(c, p.order_id, os, 'DEPOSIT_PAID', 'Anzahlung eingegangen');
        await this.setOrderStatus(c, p.order_id, 'DEPOSIT_PAID', 'IN_PRODUCTION', 'Produktion gestartet');
        await this.setLeadStatus(c, p.lead_id, 'DEPOSIT_PAID', 'Anzahlung eingegangen');
        await this.setLeadStatus(c, p.lead_id, 'PRODUCTION', 'Produktion gestartet');
        await this.createProject(c, p.order_id, p.lead_id);
      } else if (p.kind === 'final' && os === 'FINAL_PAYMENT_PENDING') {
        await this.setOrderStatus(c, p.order_id, os, 'FULLY_PAID', 'Restzahlung eingegangen');
      } else if (p.kind === 'maintenance' && os === 'DEPLOYED') {
        await this.setOrderStatus(c, p.order_id, os, 'MAINTENANCE_ACTIVE', 'Wartung aktiviert');
        await this.setLeadStatus(c, p.lead_id, 'MAINTENANCE', 'Wartung aktiviert');
      }
      return { handled: 'paid', orderId: p.order_id, kind: p.kind };
    });
  }

  private async createProject(c: import('pg').PoolClient, orderId: string, leadId: string) {
    const l = (await c.query('select * from leads where id=$1 and owner_id=$2', [leadId, this.repo.ownerId])).rows[0];
    const t = pickTemplate(l.industry, l.company_name);
    const content: ProjectContent = {
      companyName: l.company_name, industry: l.industry ?? undefined, address: l.address ?? undefined, city: l.city ?? undefined, phone: l.phone ?? undefined,
      openingHours: l.opening_hours ?? undefined, services: t.services, legal: {},
    };
    await c.query('insert into projects(owner_id, order_id, template, content) values ($1,$2,$3,$4) on conflict (order_id) do nothing', [this.repo.ownerId, orderId, t.key, JSON.stringify(content)]);
  }
}
