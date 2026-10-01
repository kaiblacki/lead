import type { Repo } from '../db/repo.ts';
import { findPlaceholders } from '../core/text.ts';

export type InvoiceData = {
  seller: { legalName: string; street: string; postalCode: string; city: string; vatId?: string; taxNumber?: string; email?: string; iban?: string };
  customer: { name: string; address?: string; postalCode?: string; city?: string };
  kind: 'deposit' | 'final' | 'maintenance'; description: string; serviceDate: string; paidAt: string;
  netCents: number; vatRatePercent: number; vatCents: number; grossCents: number; paidCents: number; openCents: number; smallBusiness: boolean; paymentNote?: string;
};
const LABEL = { deposit: 'Anzahlung', final: 'Restzahlung', maintenance: 'Wartung (Monat)' } as const;

/** Rechnungsbeträge. Netto-Modus: gezahlter Betrag gilt als netto, die USt kommt hinzu (Differenz wird als offen ausgewiesen). Brutto-Modus: USt wird herausgerechnet. Kleinunternehmer: keine USt (§ 19 UStG). */
export function amounts(paidCents: number, rate: number, o: { gross: boolean; small: boolean }) {
  if (o.small) return { netCents: paidCents, vatCents: 0, grossCents: paidCents, openCents: 0, rate: 0 };
  if (o.gross) { const net = Math.round(paidCents / (1 + rate / 100)); return { netCents: net, vatCents: paidCents - net, grossCents: paidCents, openCents: 0, rate }; }
  const vat = Math.round(paidCents * rate / 100);
  return { netCents: paidCents, vatCents: vat, grossCents: paidCents + vat, openCents: vat, rate };
}

export class InvoiceService {
  repo: Repo; agency: any; pricing: any; now: () => Date;
  constructor(repo: Repo, agency: any, pricing: any, now: () => Date = () => new Date()) { this.repo = repo; this.agency = agency; this.pricing = pricing; this.now = now; }
  private get pool() { return this.repo.pool; }

  /** Pflichtangaben des Verkäufers; liefert die fehlenden. */
  missingSellerData(): string[] {
    const i = this.agency?.invoice ?? {}; const miss: string[] = [];
    for (const k of ['legalName', 'street', 'postalCode', 'city']) if (!i[k] || findPlaceholders({ v: i[k] }).length) miss.push(k);
    if (!i.smallBusiness && !(i.taxNumber && !findPlaceholders({ v: i.taxNumber }).length) && !(i.vatId && !findPlaceholders({ v: i.vatId }).length)) miss.push('vatId/taxNumber');
    if (this.agency?.contactEmail && findPlaceholders({ v: this.agency.contactEmail }).length) miss.push('contactEmail');
    return miss;
  }

  async forPayment(paymentId: string): Promise<{ number: string; issuedAt: Date; data: InvoiceData; orderId: string }> {
    const ex = (await this.pool.query('select number, issued_at, data, order_id from invoices where payment_id=$1 and owner_id=$2', [paymentId, this.repo.ownerId])).rows[0];
    if (ex) return { number: ex.number, issuedAt: ex.issued_at, data: ex.data, orderId: ex.order_id };
    const miss = this.missingSellerData();
    if (miss.length) throw new Error(`Rechnung nicht möglich: Angaben zur Agentur fehlen in config/agency.json (invoice: ${miss.join(', ')}).`);
    const p = (await this.pool.query(`select p.id, p.kind, p.amount_cents, p.paid_at, p.order_id, o.lead_id, l.company_name, l.address, l.city, f.offer_name
      from payments p join orders o on o.id=p.order_id join leads l on l.id=o.lead_id left join lateral (select content->>'title' as offer_name from offers where id=o.offer_id) f on true
      where p.id=$1 and p.owner_id=$2`, [paymentId, this.repo.ownerId])).rows[0];
    if (!p) throw new Error('Zahlung nicht gefunden');
    return this.repo.tx(async (c) => {
      const proj = (await c.query('select content from projects where order_id=$1 and owner_id=$2', [p.order_id, this.repo.ownerId])).rows[0]?.content;
      const st = await c.query('select status, paid_at from payments where id=$1 for update', [paymentId]);
      if (st.rows[0].status !== 'paid') throw new Error('Rechnungen gibt es nur für bezahlte Zahlungen.');
      const i = this.agency.invoice;
      const a = amounts(p.amount_cents, Number(i.vatRatePercent ?? 19), { gross: !!i.amountsAreGross, small: !!i.smallBusiness });
      const paid = st.rows[0].paid_at as Date;
      const data: InvoiceData = {
        seller: { legalName: i.legalName, street: i.street, postalCode: i.postalCode, city: i.city, vatId: i.vatId || undefined, taxNumber: i.taxNumber || undefined, email: this.agency.contactEmail, iban: i.iban || undefined },
        customer: { name: proj?.companyName ?? p.company_name, address: proj?.address ?? p.address ?? undefined, postalCode: proj?.postalCode ?? undefined, city: proj?.city ?? p.city ?? undefined },
        kind: p.kind, description: `${LABEL[p.kind as keyof typeof LABEL]} – ${p.offer_name ?? 'Website'}`, serviceDate: paid.toISOString().slice(0, 10), paidAt: paid.toISOString(),
        netCents: a.netCents, vatRatePercent: a.rate, vatCents: a.vatCents, grossCents: a.grossCents, paidCents: p.amount_cents, openCents: a.openCents, smallBusiness: !!i.smallBusiness, paymentNote: i.paymentNote,
      };
      const year = this.now().getFullYear();
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [this.repo.ownerId + 'invoice']);
      const n = (await c.query("select count(*)::int n from invoices where owner_id=$1 and number like $2", [this.repo.ownerId, `RE-${year}-%`])).rows[0].n + 1;
      const number = `RE-${year}-${String(n).padStart(4, '0')}`;
      const r = await c.query('insert into invoices(owner_id, order_id, payment_id, number, data) values ($1,$2,$3,$4,$5) returning issued_at', [this.repo.ownerId, p.order_id, paymentId, number, JSON.stringify(data)]);
      await this.repo.event(c, p.lead_id, 'invoice_created', { number, payment_id: paymentId, actor: 'user' });
      return { number, issuedAt: r.rows[0].issued_at, data, orderId: p.order_id };
    });
  }
  async list(orderId: string) { return (await this.pool.query('select i.number, i.payment_id, i.issued_at from invoices i where i.order_id=$1 and i.owner_id=$2 order by i.issued_at', [orderId, this.repo.ownerId])).rows; }
}
