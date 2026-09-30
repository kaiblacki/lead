import { createHmac, timingSafeEqual } from 'node:crypto';

export type CheckoutRequest = {
  amountCents: number; currency: string; description: string; mode: 'payment' | 'subscription';
  orderId: string; paymentId: string; successUrl: string; cancelUrl: string; customerEmail?: string;
};
export type CheckoutSession = { id: string; url: string };
export type PaymentEvent =
  | { id: string; kind: 'paid'; sessionId: string; amountCents: number; currency: string; mode: string }
  | { id: string; kind: 'expired'; sessionId: string }
  | { id: string; kind: 'ignored' };

export interface PaymentProvider {
  readonly name: string;
  createCheckout(r: CheckoutRequest): Promise<CheckoutSession>;
  /** Wirft bei ungültiger Signatur. */
  parseWebhook(rawBody: string, signatureHeader: string | undefined, now?: number): PaymentEvent;
}

const TOLERANCE_S = 300;

export function verifyStripeSignature(rawBody: string, header: string | undefined, secret: string, nowMs = Date.now()): void {
  if (!header) throw new Error('Signatur fehlt');
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !sigs.length) throw new Error('Signatur ungültig');
  if (Math.abs(nowMs / 1000 - t) > TOLERANCE_S) throw new Error('Signatur abgelaufen');
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const ok = sigs.some((s) => { const b = Buffer.from(s, 'hex'); return b.length === expected.length && timingSafeEqual(b, expected); });
  if (!ok) throw new Error('Signatur ungültig');
}

/** Stripe Checkout ohne SDK (nur fetch). Nicht gegen das echte Stripe getestet – siehe README. */
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe';
  private secretKey: string;
  private webhookSecret: string;
  constructor(secretKey = process.env.STRIPE_SECRET_KEY, webhookSecret = process.env.STRIPE_WEBHOOK_SECRET) {
    if (!secretKey) throw new Error('STRIPE_SECRET_KEY fehlt');
    if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET fehlt');
    if (!/^(sk|rk)_(test|live)_/.test(secretKey)) throw new Error('STRIPE_SECRET_KEY hat kein gültiges Format');
    this.secretKey = secretKey; this.webhookSecret = webhookSecret;
  }

  async createCheckout(r: CheckoutRequest): Promise<CheckoutSession> {
    const f = new URLSearchParams({
      mode: r.mode, success_url: r.successUrl, cancel_url: r.cancelUrl, client_reference_id: r.orderId,
      'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': r.currency, 'line_items[0][price_data][unit_amount]': String(r.amountCents),
      'line_items[0][price_data][product_data][name]': r.description, 'metadata[order_id]': r.orderId, 'metadata[payment_id]': r.paymentId,
    });
    if (r.mode === 'subscription') f.set('line_items[0][price_data][recurring][interval]', 'month');
    if (r.customerEmail) f.set('customer_email', r.customerEmail);
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST', body: f,
      headers: { authorization: `Bearer ${this.secretKey}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': r.paymentId },
    });
    const data = (await res.json()) as { id?: string; url?: string; error?: { message?: string } };
    if (!res.ok || !data.id || !data.url) throw new Error(`Stripe: ${data.error?.message ?? res.status}`);
    return { id: data.id, url: data.url };
  }

  parseWebhook(rawBody: string, header: string | undefined, now = Date.now()): PaymentEvent {
    verifyStripeSignature(rawBody, header, this.webhookSecret, now);
    const e = JSON.parse(rawBody) as { id: string; type: string; data?: { object?: any } };
    const o = e.data?.object ?? {};
    if ((e.type === 'checkout.session.completed' || e.type === 'checkout.session.async_payment_succeeded') && o.payment_status === 'paid') {
      return { id: e.id, kind: 'paid', sessionId: o.id, amountCents: o.amount_total, currency: o.currency, mode: o.mode };
    }
    if (e.type === 'checkout.session.expired') return { id: e.id, kind: 'expired', sessionId: o.id };
    return { id: e.id, kind: 'ignored' };
  }
}
