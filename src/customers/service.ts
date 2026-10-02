import { randomBytes } from 'node:crypto';
import type { Repo } from '../db/repo.ts';
import { UserError } from '../dashboard/types.ts';

export const REQUEST_STATUSES = ['NEW', 'IN_REVIEW', 'APPROVED', 'IN_PROGRESS', 'DONE', 'DECLINED'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const REQUEST_LABEL: Record<RequestStatus, string> = { NEW: 'Neu', IN_REVIEW: 'In Prüfung', APPROVED: 'Freigegeben', IN_PROGRESS: 'In Arbeit', DONE: 'Erledigt', DECLINED: 'Abgelehnt' };
const NEXT: Record<RequestStatus, RequestStatus[]> = { NEW: ['IN_REVIEW', 'DECLINED'], IN_REVIEW: ['APPROVED', 'DECLINED'], APPROVED: ['IN_PROGRESS', 'DECLINED'], IN_PROGRESS: ['DONE'], DONE: [], DECLINED: [] };
const clean = (v: unknown, max: number) => { const t = String(v ?? '').trim(); return t ? t.slice(0, max) : null; };

/** Kundenprofil (nach Auftrag), Wartungsübersicht mit Änderungsbudget und Änderungswünsche. Keine Abrechnung, kein Versand – nur Verwaltung für Kai. */
export class CustomerService {
  repo: Repo; cfg: any; now: () => Date;
  constructor(o: { repo: Repo; cfg: any; now?: () => Date }) { this.repo = o.repo; this.cfg = o.cfg; this.now = o.now ?? (() => new Date()); }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }

  async list() {
    return (await this.pool.query(`select c.*, (select count(*)::int from customer_requests r where r.customer_id = c.id and r.status in ('NEW','IN_REVIEW','APPROVED','IN_PROGRESS')) as open_requests
      from customers c where c.owner_id = $1 order by c.created_at desc`, [this.owner])).rows;
  }
  /** Aufträge, die live sind (veröffentlicht / Wartung), aber noch kein Kundenprofil haben. */
  async ordersWithoutProfile() {
    return (await this.pool.query(`select o.id as order_id, o.status, o.lead_id, l.company_name, l.city from orders o join leads l on l.id = o.lead_id
      where o.owner_id = $1 and o.status in ('FULLY_PAID','DEPLOYED','MAINTENANCE_ACTIVE') and not exists (select 1 from customers c where c.lead_id = o.lead_id and c.owner_id = o.owner_id) order by o.created_at desc`, [this.owner])).rows;
  }
  async get(id: string) { return (await this.pool.query('select * from customers where id = $1 and owner_id = $2', [id, this.owner])).rows[0] ?? null; }
  async byLead(leadId: string) { return (await this.pool.query('select * from customers where lead_id = $1 and owner_id = $2', [leadId, this.owner])).rows[0] ?? null; }

  /** Legt das Profil aus Lead, Angebot und Auftrag an (idempotent). Übernimmt nur vorhandene Angaben – Fehlendes bleibt leer („nicht verfügbar“). */
  async createFromOrder(orderId: string): Promise<string> {
    const o = (await this.pool.query(`select o.id, o.lead_id, o.status, f.quote_snapshot, l.company_name, l.phone, l.email, l.website_url,
        (select url from deployments d where d.order_id = o.id order by d.created_at desc limit 1) as site_url
      from orders o join leads l on l.id = o.lead_id left join offers f on f.id = o.offer_id where o.id = $1 and o.owner_id = $2`, [orderId, this.owner])).rows[0];
    if (!o) throw new UserError('Auftrag nicht gefunden.');
    if (!['FULLY_PAID', 'DEPLOYED', 'MAINTENANCE_ACTIVE'].includes(o.status)) throw new UserError('Kundenprofil erst nach vollständiger Bezahlung des Auftrags.');
    const ex = await this.byLead(o.lead_id); if (ex) return ex.id;
    const snap = o.quote_snapshot ?? {}; const partner = (await this.pool.query('select id from partners where lead_id = $1 and owner_id = $2 limit 1', [o.lead_id, this.owner])).rows[0];
    const r = await this.pool.query(`insert into customers(owner_id, lead_id, order_id, partner_id, company_name, phone, email, package, care, website_url, portal_token) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
      [this.owner, o.lead_id, orderId, partner?.id ?? null, o.company_name, o.phone, o.email, snap.package?.key ?? (typeof snap.package === 'string' ? snap.package : null), (snap.lines ?? []).find((l: any) => l.kind === 'CARE')?.key ?? null, o.site_url ?? o.website_url ?? null, randomBytes(32).toString('hex')]);
    return r.rows[0].id as string;
  }
  async update(id: string, f: Record<string, unknown>) {
    const st = String(f.status ?? ''); if (st && !['ACTIVE', 'PAUSED', 'ENDED'].includes(st)) throw new UserError('Ungültiger Status.');
    await this.pool.query(`update customers set contact_name = $3, phone = $4, email = $5, domain = $6, hosting_note = $7, notes = $8, status = coalesce(nullif($9,''), status), updated_at = now() where id = $1 and owner_id = $2`,
      [id, this.owner, clean(f.contact_name, 200), clean(f.phone, 60), clean(f.email, 200), clean(f.domain, 200), clean(f.hosting_note, 500), clean(f.notes, 20000), st]);
  }
  async rotatePortalToken(id: string) { await this.pool.query('update customers set portal_token = $3 where id = $1 and owner_id = $2', [id, this.owner, randomBytes(32).toString('hex')]); }
  async byToken(token: string) { return (await this.pool.query('select id, owner_id, company_name, website_url, package, care, status from customers where portal_token = $1', [token])).rows[0] ?? null; }

  /** Wartungsübersicht: Paket, Start, Preis, nächste Abrechnung (Monatstag des Starts), Änderungsbudget des laufenden Monats. */
  async maintenance(customerId: string) {
    const c = await this.get(customerId); if (!c) return null;
    const plan = c.order_id ? (await this.pool.query('select * from maintenance_plans where order_id = $1 and owner_id = $2', [c.order_id, this.owner])).rows[0] : null;
    const care = c.care ? this.cfg.packages.care[c.care] : null;
    const included: number | null = care ? (care.changesPerMonth ?? null) : null;
    const start = new Date(this.now().getFullYear(), this.now().getMonth(), 1);
    const used = (await this.pool.query(`select count(*)::int n from customer_requests where customer_id = $1 and owner_id = $2 and scope = 'IN_PLAN' and status in ('APPROVED','IN_PROGRESS','DONE') and decided_at >= $3`, [customerId, this.owner, start])).rows[0].n as number;
    let nextBilling: Date | null = null;
    if (plan && plan.status === 'ACTIVE') { const a = new Date(plan.activated_at); const n = this.now(); nextBilling = new Date(n.getFullYear(), n.getMonth(), a.getDate()); if (nextBilling <= n) nextBilling = new Date(n.getFullYear(), n.getMonth() + 1, a.getDate()); }
    return { plan, careLabel: care?.label ?? null, monthlyCents: plan ? plan.monthly_cents as number : (care?.monthlyCents ?? null), start: plan?.activated_at ?? null, nextBilling, includedChanges: included, usedChanges: used, remaining: included === null ? null : Math.max(0, included - used), includes: care?.includes ?? [] };
  }

  async requests(customerId: string) { return (await this.pool.query('select * from customer_requests where customer_id = $1 and owner_id = $2 order by created_at desc', [customerId, this.owner])).rows; }
  async addRequest(customerId: string, title: unknown, detail: unknown = null, source: 'manual' | 'portal' = 'manual', owner = this.owner): Promise<string> {
    const t = clean(title, 200); if (!t) throw new UserError('Bitte beschreibe den Änderungswunsch.');
    const r = await this.pool.query('insert into customer_requests(owner_id, customer_id, title, detail, source) values ($1,$2,$3,$4,$5) returning id', [owner, customerId, t, clean(detail, 4000), source]);
    return r.rows[0].id as string;
  }
  /** Statuswechsel nur in erlaubter Reihenfolge; Freigabe verlangt Zuordnung (im Paket / Extra mit Preis). Kunden wird nichts gesendet. */
  async setRequestStatus(requestId: string, to: string, o: { scope?: string; extraPriceCents?: number | null } = {}) {
    if (!(REQUEST_STATUSES as readonly string[]).includes(to)) throw new UserError('Ungültiger Status.');
    const r = (await this.pool.query('select * from customer_requests where id = $1 and owner_id = $2', [requestId, this.owner])).rows[0]; if (!r) throw new UserError('Änderungswunsch nicht gefunden.');
    if (!NEXT[r.status as RequestStatus].includes(to as RequestStatus)) throw new UserError(`Statuswechsel ${REQUEST_LABEL[r.status as RequestStatus]} → ${REQUEST_LABEL[to as RequestStatus]} nicht möglich.`);
    let scope: string | null = r.scope, price: number | null = r.extra_price_cents;
    if (to === 'APPROVED') {
      if (o.scope !== 'IN_PLAN' && o.scope !== 'EXTRA') throw new UserError('Bitte wählen: im Wartungspaket enthalten oder Extra-Aufwand.');
      scope = o.scope;
      if (scope === 'EXTRA') { if (o.extraPriceCents === null || o.extraPriceCents === undefined || !Number.isFinite(o.extraPriceCents) || o.extraPriceCents < 0) throw new UserError('Extra-Aufwand braucht einen Preis (separates Angebot, nichts wird automatisch berechnet).'); price = Math.round(o.extraPriceCents); } else price = null;
    }
    await this.pool.query(`update customer_requests set status = $3, scope = $4, extra_price_cents = $5, decided_at = case when $3 in ('APPROVED','DECLINED') then now() else decided_at end, done_at = case when $3 = 'DONE' then now() else done_at end where id = $1 and owner_id = $2`, [requestId, this.owner, to, scope, price]);
  }
  async stats() {
    const r = (await this.pool.query(`select (select count(*)::int from customers where owner_id = $1 and status = 'ACTIVE') customers, (select count(*)::int from customer_requests where owner_id = $1 and status in ('NEW','IN_REVIEW')) new_requests`, [this.owner])).rows[0];
    return { customers: r.customers as number, newRequests: r.new_requests as number };
  }
}
