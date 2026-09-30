import { createHmac, randomBytes } from 'node:crypto';
import type { CheckoutRequest, CheckoutSession, PaymentEvent, PaymentProvider } from '../types.ts';
import { parseStripeWebhook } from '../real/stripe.ts';

export const MOCK_WEBHOOK_SECRET = 'mock_whsec_local_only';

/**
 * Stripe-Ersatz: erzeugt lokale Checkout-Seiten (/mock-pay/<id>) und signierte Ereignisse im echten Stripe-Format.
 * Die Verarbeitung läuft über denselben Webhook-Code wie bei Stripe.
 */
export class MockStripeProvider implements PaymentProvider {
  readonly name = 'mock-stripe'; readonly isMock = true;
  private baseUrl: string;
  constructor(baseUrl: string) { this.baseUrl = baseUrl.replace(/\/$/, ''); }
  async createCheckout(_r: CheckoutRequest): Promise<CheckoutSession> {
    const id = `mock_cs_${randomBytes(12).toString('hex')}`;
    return { id, url: `${this.baseUrl}/mock-pay/${id}` };
  }
  parseWebhook(rawBody: string, header: string | undefined, now = Date.now()): PaymentEvent {
    return parseStripeWebhook(rawBody, header, MOCK_WEBHOOK_SECRET, now);
  }
}

/** Baut ein signiertes Stripe-Ereignis. `kind`: bezahlt, abgelaufen, Abo gekündigt, Abo-Zahlung fehlgeschlagen. */
export function buildMockEvent(e: { eventId?: string; type: 'checkout.session.completed' | 'checkout.session.expired' | 'customer.subscription.deleted' | 'invoice.payment_failed';
  sessionId?: string; amountCents?: number; currency?: string; mode?: string; orderId?: string }, nowMs = Date.now()): { body: string; signature: string } {
  const object: any = e.type.startsWith('checkout.session')
    ? { id: e.sessionId, payment_status: e.type === 'checkout.session.completed' ? 'paid' : 'unpaid', amount_total: e.amountCents, currency: e.currency ?? 'eur', mode: e.mode ?? 'payment' }
    : e.type === 'customer.subscription.deleted' ? { metadata: { order_id: e.orderId } } : { subscription_details: { metadata: { order_id: e.orderId } } };
  const body = JSON.stringify({ id: e.eventId ?? `mock_evt_${randomBytes(8).toString('hex')}`, type: e.type, data: { object } });
  const t = Math.floor(nowMs / 1000);
  return { body, signature: `t=${t},v1=${createHmac('sha256', MOCK_WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex')}` };
}
