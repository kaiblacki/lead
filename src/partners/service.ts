import type { Repo } from '../db/repo.ts';
import { CRITERIA, REFERRAL_CONTACT_FIELDS, REFERRAL_FIELDS, checkTransition, matchPartners, type Criteria, type PartnerStatus, type ReferralField, type MatchPartner } from './model.ts';
import { assertNoInsuranceCoupling } from '../core/compliance.ts';

const EDITABLE = ['company_name', 'contact_person', 'industry', 'region', 'radius_km', 'services', 'preferred_customer_types', 'interesting_leads', 'uninteresting_leads', 'phone', 'email', 'website', 'referral_preferences', 'notes', 'started_at', 'community_status'] as const;
const text = (v: unknown, max = 4000) => { const s = String(v ?? '').trim(); if (s.length > max) throw new Error(`Eingabe ist zu lang (max. ${max} Zeichen).`); return s || null; };

/** Partnernetzwerk: Profil, Status (mit Voraussetzungen), Referrals mit geprüfter Weitergabe. Nichts wird gesendet oder automatisch weitergegeben. */
export class PartnerService {
  repo: Repo; now: () => Date;
  constructor(d: { repo: Repo; now?: () => Date }) { this.repo = d.repo; this.now = d.now ?? (() => new Date()); }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }

  async list(f: { status?: PartnerStatus | PartnerStatus[]; q?: string } = {}) {
    const p: unknown[] = [this.owner]; let w = 'p.owner_id=$1';
    if (f.status) { p.push(Array.isArray(f.status) ? f.status : [f.status]); w += ` and p.status = any($${p.length})`; }
    if (f.q) { p.push(`%${f.q}%`); w += ` and (p.company_name ilike $${p.length} or p.industry ilike $${p.length} or p.region ilike $${p.length})`; }
    return (await this.pool.query(`select p.*, (select count(*)::int from referrals r where r.owner_id=p.owner_id and r.destination_partner_id=p.id and r.status in ('SENT','CLOSED')) as outgoing,
      (select count(*)::int from referrals r where r.owner_id=p.owner_id and r.source_partner_id=p.id) as incoming from partners p where ${w} order by p.company_name`, p)).rows;
  }
  async get(id: string) { return (await this.pool.query('select * from partners where id=$1 and owner_id=$2', [id, this.owner])).rows[0] ?? null; }
  async forLead(leadId: string) { return (await this.pool.query('select * from partners where lead_id=$1 and owner_id=$2', [leadId, this.owner])).rows[0] ?? null; }
  /** Partnerstatus eines Leads (NONE, wenn der Lead kein Partnerprofil hat). */
  async statusForLead(leadId: string): Promise<PartnerStatus> { return ((await this.forLead(leadId))?.status ?? 'NONE') as PartnerStatus; }

  async create(i: Partial<Record<(typeof EDITABLE)[number], unknown>> & { lead_id?: string | null; lead_industries?: string[] }): Promise<string> {
    const name = text(i.company_name, 200); if (!name) throw new Error('Firmenname fehlt.');
    const cols = ['owner_id', 'company_name']; const vals: unknown[] = [this.owner, name];
    for (const k of EDITABLE) { if (k === 'company_name' || i[k] === undefined) continue; cols.push(k); vals.push(k === 'radius_km' ? (i[k] === '' || i[k] === null ? null : Number(i[k])) : k === 'started_at' || k === 'community_status' ? (text(i[k]) ?? (k === 'community_status' ? 'NONE' : null)) : text(i[k], k === 'notes' ? 20000 : 4000)); }
    if (i.lead_id) { cols.push('lead_id'); vals.push(i.lead_id); }
    if (i.lead_industries) { cols.push('lead_industries'); vals.push(i.lead_industries.map((x) => String(x).trim()).filter(Boolean)); }
    const r = await this.pool.query(`insert into partners(${cols.join(',')}) values (${vals.map((_, n) => `$${n + 1}`).join(',')}) returning id`, vals);
    await this.pool.query("insert into partner_status_log(owner_id, partner_id, from_status, to_status, reason) values ($1,$2,null,'PARTNER_CANDIDATE','Angelegt')", [this.owner, r.rows[0].id]);
    return r.rows[0].id as string;
  }
  /** Aus einem Lead einen Partner-Kandidaten machen (nur öffentliche Firmendaten aus dem Lead; idempotent). */
  async fromLead(leadId: string): Promise<{ id: string; created: boolean }> {
    const ex = await this.forLead(leadId); if (ex) return { id: ex.id, created: false };
    const l = (await this.pool.query('select company_name, phone, email, website_url, city, sub_industry, industry, contact_blocked from leads where id=$1 and owner_id=$2', [leadId, this.owner])).rows[0];
    if (!l) throw new Error('Lead nicht gefunden');
    if (l.contact_blocked) throw new Error('Dieser Lead ist gesperrt (Do not contact) und kann kein Partner-Kandidat werden.');
    const id = await this.create({ company_name: l.company_name, phone: l.phone, email: l.email, website: l.website_url, industry: l.sub_industry ?? l.industry, region: l.city, lead_id: leadId });
    return { id, created: true };
  }
  async update(id: string, patch: Record<string, unknown>) {
    const sets: string[] = []; const p: unknown[] = [id, this.owner];
    for (const k of EDITABLE) if (patch[k] !== undefined) { p.push(k === 'radius_km' ? (patch[k] === '' ? null : Number(patch[k])) : k === 'started_at' || k === 'community_status' ? text(patch[k]) ?? (k === 'community_status' ? 'NONE' : null) : text(patch[k], k === 'notes' ? 20000 : 4000)); sets.push(`${k}=$${p.length}`); }
    if (patch.lead_industries !== undefined) { p.push(String(patch.lead_industries).split(/[,;\n]/).map((x) => x.trim()).filter(Boolean)); sets.push(`lead_industries=$${p.length}`); }
    if (!sets.length) return;
    if (patch.company_name !== undefined && !text(patch.company_name)) throw new Error('Firmenname fehlt.');
    for (const k of ['notes', 'services', 'referral_preferences', 'interesting_leads', 'uninteresting_leads']) if (patch[k] !== undefined) assertNoInsuranceCoupling(String(patch[k]));
    const r = await this.pool.query(`update partners set ${sets.join(', ')}, updated_at=now() where id=$1 and owner_id=$2`, p); if (!r.rowCount) throw new Error('Partner nicht gefunden');
  }
  async setCriteria(id: string, c: Criteria) {
    const clean: Criteria = {}; for (const k of CRITERIA) clean[k] = !!c[k];
    const r = await this.pool.query('update partners set criteria=$3, updated_at=now() where id=$1 and owner_id=$2', [id, this.owner, JSON.stringify(clean)]); if (!r.rowCount) throw new Error('Partner nicht gefunden');
  }
  async setStatus(id: string, to: PartnerStatus, reason = '', actor = 'user') {
    const p = await this.get(id); if (!p) throw new Error('Partner nicht gefunden');
    const chk = checkTransition(p.status, to, p.criteria ?? {}, { contactPerson: p.contact_person }); if (!chk.ok) throw new Error(chk.reason);
    await this.repo.tx(async (c) => {
      await c.query(`update partners set status=$3, updated_at=now(), started_at = case when $3='ACTIVE_PARTNER' then coalesce(started_at, current_date) else started_at end where id=$1 and owner_id=$2`, [id, this.owner, to]);
      await c.query('insert into partner_status_log(owner_id, partner_id, from_status, to_status, reason, actor) values ($1,$2,$3,$4,$5,$6)', [this.owner, id, p.status, to, reason.slice(0, 300) || null, actor]);
    });
  }
  async log(id: string) { return (await this.pool.query('select * from partner_status_log where partner_id=$1 and owner_id=$2 order by at desc', [id, this.owner])).rows; }

  async matchesForLead(leadId: string): Promise<MatchPartner[]> {
    const l = (await this.pool.query('select id, sub_industry, industry, city, contact_blocked from leads where id=$1 and owner_id=$2', [leadId, this.owner])).rows[0]; if (!l) return [];
    const actives = (await this.pool.query("select id, company_name, status, industry, region, radius_km, lead_industries, services from partners where owner_id=$1 and status='ACTIVE_PARTNER' and (lead_id is null or lead_id <> $2)", [this.owner, leadId])).rows;
    return matchPartners(l, actives);
  }

  // ---------- Referrals ----------
  async referrals(f: { partnerId?: string; leadId?: string; status?: string } = {}) {
    const p: unknown[] = [this.owner]; let w = 'r.owner_id=$1';
    if (f.partnerId) { p.push(f.partnerId); w += ` and (r.destination_partner_id=$${p.length} or r.source_partner_id=$${p.length})`; }
    if (f.leadId) { p.push(f.leadId); w += ` and r.lead_id=$${p.length}`; }
    if (f.status) { p.push(f.status); w += ` and r.status=$${p.length}`; }
    return (await this.pool.query(`select r.*, l.company_name as lead_name, dp.company_name as destination_name, sp.company_name as source_name from referrals r left join leads l on l.id=r.lead_id
      left join partners dp on dp.id=r.destination_partner_id left join partners sp on sp.id=r.source_partner_id where ${w} order by r.created_at desc`, p)).rows;
  }
  async referralById(id: string) { return (await this.pool.query('select * from referrals where id=$1 and owner_id=$2', [id, this.owner])).rows[0] ?? null; }

  /** Schritt 1: Vorschlag/Entwurf. Nur zu AKTIVEN Partnern und nie für gesperrte Leads. Es wird nichts übermittelt. */
  async proposeOutgoing(leadId: string, partnerId: string): Promise<string> {
    const [l, p] = await Promise.all([this.pool.query('select contact_blocked, company_name from leads where id=$1 and owner_id=$2', [leadId, this.owner]), this.get(partnerId)]);
    if (!l.rows[0]) throw new Error('Lead nicht gefunden'); if (!p) throw new Error('Partner nicht gefunden');
    if (l.rows[0].contact_blocked) throw new Error('Gesperrter Lead (Do not contact) – keine Weitergabe.');
    if (p.status !== 'ACTIVE_PARTNER') throw new Error('Leads können nur an aktive Partner weitergegeben werden.');
    const open = (await this.pool.query("select id from referrals where owner_id=$1 and lead_id=$2 and destination_partner_id=$3 and status in ('PROPOSED','CONFIRMED')", [this.owner, leadId, partnerId])).rows[0]; if (open) return open.id;
    return (await this.pool.query("insert into referrals(owner_id, direction, destination_partner_id, lead_id, company_name) values ($1,'OUTGOING',$2,$3,$4) returning id", [this.owner, partnerId, leadId, l.rows[0].company_name])).rows[0].id;
  }
  /** Genau die Daten, die weitergegeben würden (Vorschau und Snapshot). */
  async payload(leadId: string, fields: ReferralField[], note = ''): Promise<Record<string, string>> {
    const l = (await this.pool.query('select company_name, sub_industry, industry, city, address, phone, email, website_url from leads where id=$1 and owner_id=$2', [leadId, this.owner])).rows[0]; if (!l) throw new Error('Lead nicht gefunden');
    const map: Record<ReferralField, string | null> = { company_name: l.company_name, industry: l.sub_industry ?? l.industry, city: l.city, address: l.address, phone: l.phone, email: l.email, website: l.website_url, note: note || null };
    const out: Record<string, string> = {}; for (const f of fields) if (map[f]) out[f] = String(map[f]); return out;
  }
  /** Schritt 2: Kai bestätigt (Empfänger gesehen, Daten gesehen, Rechtsgrundlage dokumentiert). Danach „Weitergegeben“ – immer manuell durch Kai. */
  async confirm(id: string, o: { fields: string[]; legalBasis: string; reviewed: boolean; note?: string }) {
    const r = await this.referralById(id); if (!r) throw new Error('Referral nicht gefunden'); if (r.status !== 'PROPOSED') throw new Error('Nur ein Vorschlag kann bestätigt werden.');
    if (r.direction !== 'OUTGOING' || !r.lead_id) throw new Error('Nur ausgehende Referrals mit Lead können bestätigt werden.');
    if (!o.reviewed) throw new Error('Bitte bestätigen, dass Empfänger und Daten geprüft wurden.');
    const basis = (o.legalBasis ?? '').trim(); if (basis.length < 10) throw new Error('Bitte die Rechtsgrundlage bzw. Zustimmung dokumentieren (mind. 10 Zeichen, z. B. „Einwilligung des Inhabers am 12.10. im Telefonat“).');
    const fields = [...new Set([...o.fields, ...(o.note ? ['note'] : [])])].filter((f): f is ReferralField => (REFERRAL_FIELDS as readonly string[]).includes(f)); if (!fields.length) throw new Error('Bitte mindestens eine Angabe zur Weitergabe auswählen.');
    if (!fields.includes('company_name')) throw new Error('Der Firmenname gehört zu jeder Weitergabe.');
    const [l, p] = await Promise.all([this.pool.query('select contact_blocked from leads where id=$1 and owner_id=$2', [r.lead_id, this.owner]), this.get(r.destination_partner_id)]);
    if (l.rows[0]?.contact_blocked) throw new Error('Gesperrter Lead (Do not contact) – keine Weitergabe.'); if (!p || p.status !== 'ACTIVE_PARTNER') throw new Error('Der Empfänger ist kein aktiver Partner.');
    if (o.note) assertNoInsuranceCoupling(o.note);
    const snap = await this.payload(r.lead_id, fields, o.note ?? '');
    await this.pool.query("update referrals set status='CONFIRMED', shared_fields=$3, legal_basis=$4, confirmed_at=now(), updated_at=now() where id=$1 and owner_id=$2", [id, this.owner, JSON.stringify(snap), basis]);
    return { snapshot: snap, containsContact: fields.some((f) => REFERRAL_CONTACT_FIELDS.includes(f)) };
  }
  async markSent(id: string) {
    const r = await this.pool.query("update referrals set status='SENT', sent_at=now(), updated_at=now() where id=$1 and owner_id=$2 and status='CONFIRMED' returning id", [id, this.owner]);
    if (!r.rowCount) throw new Error('Nur ein bestätigtes Referral kann als weitergegeben markiert werden.');
  }
  async cancel(id: string) { const r = await this.pool.query("update referrals set status='CANCELLED', updated_at=now() where id=$1 and owner_id=$2 and status in ('PROPOSED','CONFIRMED')", [id, this.owner]); if (!r.rowCount) throw new Error('Referral kann nicht abgebrochen werden.'); }
  async setOutcome(id: string, o: { accepted?: boolean; contacted?: boolean; converted?: boolean; estimatedValueCents?: number | null; notes?: string }) {
    const r = await this.referralById(id); if (!r) throw new Error('Referral nicht gefunden');
    if (r.direction === 'OUTGOING' && !['SENT', 'CLOSED'].includes(r.status)) throw new Error('Ergebnisse gibt es erst nach der Weitergabe.');
    if (o.estimatedValueCents !== undefined && o.estimatedValueCents !== null && (!Number.isInteger(o.estimatedValueCents) || o.estimatedValueCents < 0)) throw new Error('Geschätzter Wert muss eine ganze Zahl ≥ 0 sein.');
    if (o.notes) assertNoInsuranceCoupling(o.notes);
    await this.pool.query(`update referrals set accepted=coalesce($3,accepted), contacted=coalesce($4,contacted), converted=coalesce($5,converted), estimated_value_cents=coalesce($6, estimated_value_cents), notes=coalesce($7, notes), updated_at=now() where id=$1 and owner_id=$2`,
      [id, this.owner, o.accepted ?? null, o.contacted ?? null, o.converted ?? null, o.estimatedValueCents ?? null, o.notes ?? null]);
  }
  async close(id: string) { await this.pool.query("update referrals set status='CLOSED', updated_at=now() where id=$1 and owner_id=$2 and status='SENT'", [id, this.owner]); }
  /** Empfehlung eines Partners an uns (eingehend). */
  async recordIncoming(partnerId: string, i: { companyName: string; leadId?: string | null; notes?: string; estimatedValueCents?: number | null }): Promise<string> {
    if (!(await this.get(partnerId))) throw new Error('Partner nicht gefunden'); const name = text(i.companyName, 200); if (!name) throw new Error('Firmenname fehlt.');
    if (i.notes) assertNoInsuranceCoupling(i.notes);
    return (await this.pool.query("insert into referrals(owner_id, direction, source_partner_id, lead_id, company_name, status, accepted, notes, estimated_value_cents) values ($1,'INCOMING',$2,$3,$4,'SENT',true,$5,$6) returning id", [this.owner, partnerId, i.leadId ?? null, name, i.notes ?? null, i.estimatedValueCents ?? null])).rows[0].id;
  }

  /** Kennzahlen je Partner: übermittelte/erhaltene Leads, Gespräche, Aufträge, Wert, letzte Aktivität. */
  async stats(partnerId: string) {
    const r = (await this.pool.query(`select
        count(*) filter (where direction='OUTGOING' and destination_partner_id=$2 and status in ('SENT','CLOSED'))::int as outgoing,
        count(*) filter (where direction='INCOMING' and source_partner_id=$2)::int as incoming,
        count(*) filter (where contacted)::int as conversations,
        count(*) filter (where converted)::int as converted,
        count(*) filter (where lead_id in (select lead_id from orders where owner_id=$1))::int as orders,
        coalesce(sum(estimated_value_cents) filter (where converted),0)::int as value_cents,
        max(updated_at) as last_activity
      from referrals where owner_id=$1 and (destination_partner_id=$2 or source_partner_id=$2)`, [this.owner, partnerId])).rows[0];
    return r as { outgoing: number; incoming: number; conversations: number; converted: number; orders: number; value_cents: number; last_activity: Date | null };
  }
}
