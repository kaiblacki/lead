import type { Repo } from '../db/repo.ts';
import type { LeadStore } from '../db/leads.ts';
import type { SalesStore } from '../db/sales.ts';
import type { SalesDocs } from '../sales/docs.ts';
import type { OrderService } from '../orders/service.ts';
import { moveLead, recordOutcome } from '../db/lead-status.ts';
import type { Status } from '../core/status.ts';
import { startOfBerlinDay, endOfBerlinDay } from '../core/time.ts';

export const CALL_RESULTS = ['NO_ANSWER', 'NO_INTEREST', 'CALL_BACK', 'INTERESTED', 'DEMO', 'OFFER', 'BOUGHT', 'DO_NOT_CONTACT'] as const;
export type CallResult = (typeof CALL_RESULTS)[number];
export const CALL_LABEL: Record<CallResult, string> = { NO_ANSWER: 'Nicht erreicht', NO_INTEREST: 'Kein Interesse', CALL_BACK: 'Rückruf', INTERESTED: 'Interessiert', DEMO: 'Demo gewünscht', OFFER: 'Angebot gewünscht', BOUGHT: 'Gekauft', DO_NOT_CONTACT: 'Nicht mehr kontaktieren' };
const PRE_SALE: Status[] = ['QUALIFIED', 'DEMO_CREATED', 'CONTACTED', 'REPLIED', 'INTERESTED', 'OFFER_SENT'];
/** Absteigend nach Wert; fehlende Werte zuletzt. Reihenfolge der Anrufliste: Sales Opportunity → Datenqualität → Contactability → Digital Need. */
const cmp = (a: number | null | undefined, b: number | null | undefined) => (a ?? -1) - (b ?? -1);
const FOLLOW_UP_DAYS = 3, MAX_ATTEMPTS = 3;

export type CallOutcome = { result: CallResult; moved: Status[]; messages: string[]; demoUrl?: string; offerId?: string; orderId?: string };


/** „Meine heutigen Calls“ und die Pipeline-Logik hinter den Ergebnis-Buttons. Es wird nie automatisch angerufen oder gesendet. */
export class CallService {
  repo: Repo; leads: LeadStore; sales: SalesStore; docs: SalesDocs; orders: OrderService; now: () => Date;
  constructor(d: { repo: Repo; leads: LeadStore; sales: SalesStore; docs: SalesDocs; orders: OrderService; now?: () => Date }) { this.repo = d.repo; this.leads = d.leads; this.sales = d.sales; this.docs = d.docs; this.orders = d.orders; this.now = d.now ?? (() => new Date()); }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }

  /** Heutige Anrufliste: Rückrufe zuerst, dann neue Leads nach Priorität, dann Nachfassen. */
  async queue() {
    const now = this.now();
    const dayStart = startOfBerlinDay(now), dayEnd = endOfBerlinDay(now);
    const settings = await this.repo.getSettings();
    const base = `select l.id, l.company_name, l.city, l.sub_industry, l.status, l.phone, l.website_url, l.website_state, l.distance_km, l.callback_at, l.last_contact_at, l.call_count, l.is_mock, l.contact_reason,
        o.score, o.category, o.digital_need, (o.dimensions->'dataQuality'->>'value')::float as dq, (o.dimensions->'contactability'->>'value')::float as contactability, l.address, l.source, sp.brief, sp.opener, sp.approved_at,
        (select note from contact_history h where h.lead_id = l.id and h.note is not null order by at desc limit 1) as last_note,
        (select result from contact_history h where h.lead_id = l.id and h.channel='PHONE' order by at desc limit 1) as last_result
      from leads l
      left join lateral (select score, category, digital_need, dimensions from opportunities where lead_id = l.id order by created_at desc, id desc limit 1) o on true
      left join lateral (select brief, opener, approved_at from sales_packages where lead_id = l.id order by created_at desc, id desc limit 1) sp on true
      where l.owner_id = $1 and l.contact_readiness = 'READY_FOR_MANUAL_CALL' and not l.paused and not l.contact_blocked and l.phone is not null`;
    const doneToday = (await this.pool.query("select count(*)::int n, count(distinct lead_id)::int leads from contact_history where owner_id=$1 and channel='PHONE' and at >= $2 and at < $3", [this.owner, dayStart, dayEnd])).rows[0];
    const handledIds = new Set((await this.pool.query("select distinct lead_id from contact_history where owner_id=$1 and channel='PHONE' and at >= $2 and at < $3", [this.owner, dayStart, dayEnd])).rows.map((r) => r.lead_id));
    const callbacks = (await this.pool.query(`${base} and l.callback_at < $2 and l.status = any($3) order by l.callback_at`, [this.owner, dayEnd, PRE_SALE])).rows;
    const fresh = (await this.pool.query(`${base} and l.callback_at is null and l.status in ('QUALIFIED') and o.score is not null order by o.score desc nulls last, l.created_at`, [this.owner])).rows.sort((a, b) => cmp(b.score, a.score) || cmp(b.dq, a.dq) || cmp(b.contactability, a.contactability) || cmp(b.digital_need, a.digital_need));
    const follow = (await this.pool.query(`${base} and l.callback_at is null and l.status in ('DEMO_CREATED','INTERESTED','OFFER_SENT') and l.last_contact_at < $2 order by case l.status when 'OFFER_SENT' then 0 when 'INTERESTED' then 1 else 2 end, l.last_contact_at`, [this.owner, new Date(now.getTime() - FOLLOW_UP_DAYS * 86400000)])).rows;
    const shape = (r: any, kind: 'callback' | 'new' | 'follow_up') => ({ ...r, kind, priority: r.brief?.priority ?? 'D' });
    const ok = (r: any) => !handledIds.has(r.id);
    const list = [...callbacks.filter(ok).map((r) => shape(r, 'callback')), ...fresh.filter(ok).filter((r) => r.brief?.priority && r.brief.priority !== 'D').map((r) => shape(r, 'new')), ...follow.filter(ok).map((r) => shape(r, 'follow_up'))];
    const callbacksN = list.filter((x) => x.kind === 'callback').length;
    const target = settings.dailyCallTarget;
    const limited = [...list.slice(0, callbacksN), ...list.slice(callbacksN).slice(0, Math.max(0, target - doneToday.leads - callbacksN))];
    return { items: limited, done: doneToday.leads, calls: doneToday.n, target, open: limited.length, phoneEnabled: settings.phoneEnabled };
  }

  /** Ergebnis eines Anrufs erfassen und den Lead automatisch in die passende Pipeline-Stufe bewegen. */
  async applyResult(leadId: string, result: CallResult, o: { note?: string; callbackAt?: Date | null } = {}): Promise<CallOutcome> {
    if (!CALL_RESULTS.includes(result)) throw new Error('Unbekanntes Anruf-Ergebnis');
    const lead = await this.leads.rowToEntry(leadId);
    if (!lead) throw new Error('Lead nicht gefunden');
    if (lead.contact_blocked || lead.contact_readiness === 'DO_NOT_CONTACT') throw new Error('Dieser Lead ist gesperrt (Do not contact).');
    const now = this.now();
    if (result === 'CALL_BACK' && (!o.callbackAt || Number.isNaN(o.callbackAt.getTime()))) throw new Error('Für „Rückruf“ bitte Datum und Uhrzeit angeben.');
    if (result === 'CALL_BACK' && o.callbackAt!.getTime() < now.getTime() - 60_000) throw new Error('Der Rückruf-Termin liegt in der Vergangenheit.');
    if ((o.note ?? '').length > 4000) throw new Error('Notiz ist zu lang (max. 4000 Zeichen).');
    const out: CallOutcome = { result, moved: [], messages: [] };

    // Vorprüfung, damit „Gekauft“ nicht halb ausgeführt wird
    if (result === 'BOUGHT') {
      const offer = await this.sales.latestOffer(leadId);
      if (!offer || !['SENT', 'ACCEPTED'].includes(offer.status)) {
        const existingOk = offer && ['DRAFT', 'APPROVED'].includes(offer.status) && !(offer.content?.warnings ?? []).length;
        if (!existingOk) {
          const tentative = await this.docs.offerFor(leadId);
          if (tentative.warnings.length) throw new Error('„Gekauft“ braucht ein versendbares Angebot, aber in config/pricing.json stehen noch Platzhalter (Lieferzeit, USt-Hinweis, Bedingungen). Bitte zuerst ausfüllen.');
          out.offerId = tentative.offerId;
        }
      }
    }

    // 1) Anruf protokollieren, Zähler, Learning-Loop-Ergebnis
    const callbackAt = result === 'CALL_BACK' ? o.callbackAt! : result === 'NO_ANSWER' && (lead.call_count ?? 0) + 1 < MAX_ATTEMPTS ? new Date(now.getTime() + 86400000) : null;
    await this.repo.tx(async (c) => {
      await this.leads.recordContact(c, leadId, { channel: 'PHONE', direction: 'outbound', result, note: o.note ?? null, callbackAt });
      await c.query('update leads set call_count = call_count + 1, last_contact_at = $3, callback_at = $4 where id=$1 and owner_id=$2', [leadId, this.owner, now, callbackAt]);
      await recordOutcome(this.repo, c, leadId, 'call', result, { attempt: (lead.call_count ?? 0) + 1 });
      await this.repo.event(c, leadId, 'call_result', { result, note: o.note ? true : false, actor: 'user' });
    });

    const move = async (target: Status, reason: string) => { const steps = await this.repo.tx((c) => moveLead(this.repo, c, leadId, target, reason, 'user', { path: true, within: PRE_SALE.concat('IGNORED') })); out.moved.push(...steps); };
    const status = lead.status as Status;
    /** „Interessiert“ nur nachziehen, wenn der Lead noch davor steht (nicht von Demo/Angebot zurückspringen). */
    const ensureInterested = async (reason: string) => { if (['QUALIFIED', 'CONTACTED', 'REPLIED'].includes(status)) await move('INTERESTED', reason); };
    switch (result) {
      case 'NO_ANSWER':
        if ((lead.call_count ?? 0) + 1 >= MAX_ATTEMPTS) out.messages.push(`${MAX_ATTEMPTS}. Versuch ohne Erfolg – kein automatischer Rückruf mehr. Lead bleibt zur Entscheidung offen.`);
        else out.messages.push('Nicht erreicht – neuer Versuch morgen in der Anrufliste.');
        break;
      case 'NO_INTEREST': await move('IGNORED', 'Anruf: kein Interesse'); await this.repo.tx((c) => recordOutcome(this.repo, c, leadId, 'final', 'LOST', { reason: 'no_interest' })); break;
      case 'CALL_BACK': if (status === 'QUALIFIED' || status === 'DEMO_CREATED') await move('CONTACTED', 'Anruf: Rückruf vereinbart'); out.messages.push(`Rückruf am ${o.callbackAt!.toLocaleString('de-DE')} in der Anrufliste.`); break;
      case 'INTERESTED': await ensureInterested('Anruf: interessiert'); break;
      case 'DEMO': {
        await ensureInterested('Anruf: Demo gewünscht');
        const d = await this.docs.demoFor(leadId, 'auto'); out.demoUrl = d.url; out.moved.push('DEMO_CREATED' as Status); out.messages.push('Demo erstellt – Link an den Kunden weitergeben.');
        break;
      }
      case 'OFFER': {
        await ensureInterested('Anruf: Angebot gewünscht');
        const cur = await this.sales.latestOffer(leadId);
        const offerId = cur && ['DRAFT', 'APPROVED'].includes(cur.status) ? cur.id : (await this.docs.offerFor(leadId)).offerId; out.offerId = offerId;
        const fresh = await this.sales.latestOffer(leadId);
        if ((fresh.content?.warnings ?? []).length) { out.messages.push('Angebot als Entwurf angelegt. Es enthält noch Platzhalter (config/pricing.json) und kann so nicht versendet werden.'); break; }
        if (fresh.status === 'DRAFT') await this.sales.approveOffer(fresh.id);
        await this.sales.markOfferSent(fresh.id, 'user'); out.moved.push('OFFER_SENT' as Status); out.messages.push('Angebot freigegeben und als versendet markiert – jetzt dem Kunden zusenden.');
        break;
      }
      case 'BOUGHT': {
        await ensureInterested('Anruf: gekauft');
        let offer = await this.sales.latestOffer(leadId);
        if (offer && ['DRAFT', 'APPROVED'].includes(offer.status)) { if (offer.status === 'DRAFT') await this.sales.approveOffer(offer.id); await this.sales.markOfferSent(offer.id, 'user'); }
        out.orderId = await this.orders.acceptOffer(leadId, 'user'); out.moved.push('OFFER_ACCEPTED' as Status, 'DEPOSIT_PENDING' as Status);
        out.messages.push('Bestellung angelegt – jetzt den Anzahlungs-Link erstellen und dem Kunden geben.');
        break;
      }
      case 'DO_NOT_CONTACT': await this.leads.markDoNotContact(leadId, o.note || 'Wunsch im Telefonat', 'user'); out.moved.push('IGNORED' as Status); out.messages.push('Auf die Sperrliste gesetzt.'); break;
    }
    return out;
  }
}
