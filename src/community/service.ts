import type { Repo } from '../db/repo.ts';
import { UserError } from '../dashboard/types.ts';
import { communityFee } from '../pricing/quote.ts';
import { insuranceCoupling } from '../core/compliance.ts';

const clean = (v: unknown, max: number) => { const t = String(v ?? '').trim(); return t ? t.slice(0, max) : null; };

/** Community-MVP: Mitglieder aus Partnern/Kunden, Verzeichnis nur mit Opt-in, Gebühr zentral (aktive Partner frei). Nie an Versicherungsverträge gekoppelt. */
export class CommunityService {
  repo: Repo; cfg: any; now: () => Date;
  constructor(o: { repo: Repo; cfg: any; now?: () => Date }) { this.repo = o.repo; this.cfg = o.cfg; this.now = o.now ?? (() => new Date()); }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }

  private async decorate(rows: any[]) {
    const partners = new Map<string, string>((await this.pool.query('select id, status from partners where owner_id = $1', [this.owner])).rows.map((p) => [p.id, p.status]));
    return rows.map((m) => { const ps = m.partner_id ? partners.get(m.partner_id) ?? null : null; const fee = communityFee(this.cfg, ps); return { ...m, partner_status: ps, fee, feeCents: m.status === 'ENDED' ? 0 : m.billing === 'YEARLY' ? fee.yearlyCents : fee.monthlyCents }; });
  }
  async list() { return this.decorate((await this.pool.query('select * from community_members where owner_id = $1 order by status, company_name', [this.owner])).rows); }
  async get(id: string) { return (await this.decorate((await this.pool.query('select * from community_members where id = $1 and owner_id = $2', [id, this.owner])).rows))[0] ?? null; }
  /** Verzeichnis: nur aktive Mitglieder mit Opt-in und ausdrücklicher Listung; nur die dafür freigegebenen Felder. */
  async directory() { return (await this.pool.query(`select id, company_name, industry, region, offer_text, contact_public from community_members where owner_id = $1 and status = 'ACTIVE' and opt_in and listed order by company_name`, [this.owner])).rows; }

  async invite(src: { partnerId?: string; customerId?: string; companyName?: string }): Promise<string> {
    let name = clean(src.companyName, 200), industry: string | null = null, region: string | null = null;
    if (src.partnerId) { const p = (await this.pool.query('select company_name, industry, region from partners where id = $1 and owner_id = $2', [src.partnerId, this.owner])).rows[0]; if (!p) throw new UserError('Partner nicht gefunden.'); name = p.company_name; industry = p.industry; region = p.region; }
    if (src.customerId) { const c = (await this.pool.query('select c.company_name, l.industry, l.city from customers c join leads l on l.id = c.lead_id where c.id = $1 and c.owner_id = $2', [src.customerId, this.owner])).rows[0]; if (!c) throw new UserError('Kunde nicht gefunden.'); name = c.company_name; industry = c.industry; region = c.city; }
    if (!name) throw new UserError('Name fehlt.');
    const ex = (await this.pool.query('select id from community_members where owner_id = $1 and (($2::uuid is not null and partner_id = $2) or ($3::uuid is not null and customer_id = $3))', [this.owner, src.partnerId ?? null, src.customerId ?? null])).rows[0]; if (ex) return ex.id;
    const r = await this.pool.query('insert into community_members(owner_id, partner_id, customer_id, company_name, industry, region) values ($1,$2,$3,$4,$5,$6) returning id', [this.owner, src.partnerId ?? null, src.customerId ?? null, name, industry, region]);
    if (src.partnerId) await this.pool.query("update partners set community_status = 'INVITED' where id = $1 and owner_id = $2 and community_status = 'NONE'", [src.partnerId, this.owner]);
    return r.rows[0].id as string;
  }
  /** Opt-in: nur ausdrücklich, mit Vermerk, wie er erteilt wurde. Ohne Opt-in keine Listung. */
  async recordOptIn(id: string, note: unknown) {
    const n = clean(note, 500); if (!n) throw new UserError('Bitte vermerke, wie die Einwilligung erteilt wurde (z. B. „mündlich am 12.10., per E-Mail bestätigt“).');
    await this.pool.query('update community_members set opt_in = true, opt_in_at = $3, opt_in_note = $4, updated_at = now() where id = $1 and owner_id = $2', [id, this.owner, this.now(), n]);
  }
  async withdrawOptIn(id: string) { await this.pool.query('update community_members set opt_in = false, listed = false, opt_in_at = null, updated_at = now() where id = $1 and owner_id = $2', [id, this.owner]); }
  async updateProfile(id: string, f: Record<string, unknown>) {
    const offer = clean(f.offer_text, 1000), pub = clean(f.contact_public, 300), notes = clean(f.notes, 4000);
    for (const t of [offer, pub, notes]) { const hit = t && insuranceCoupling(t); if (hit) throw new UserError('Community-Vorteile dürfen nicht an Versicherungsverträge geknüpft werden.'); }
    const billing = f.billing === 'YEARLY' ? 'YEARLY' : 'MONTHLY';
    await this.pool.query('update community_members set industry = $3, region = $4, offer_text = $5, contact_public = $6, billing = $7, notes = $8, updated_at = now() where id = $1 and owner_id = $2', [id, this.owner, clean(f.industry, 200), clean(f.region, 200), offer, pub, billing, notes]);
  }
  async setListed(id: string, listed: boolean) {
    const m = await this.get(id); if (!m) throw new UserError('Mitglied nicht gefunden.');
    if (listed && !m.opt_in) throw new UserError('Ohne ausdrückliches Opt-in darf das Mitglied nicht im Verzeichnis erscheinen.');
    if (listed && m.status !== 'ACTIVE') throw new UserError('Nur aktive Mitglieder können gelistet werden.');
    await this.pool.query('update community_members set listed = $3, updated_at = now() where id = $1 and owner_id = $2', [id, this.owner, listed]);
  }
  /** Mitgliedschaft starten (Beitrag wird nur angezeigt, nicht eingezogen) bzw. beenden. */
  async setStatus(id: string, to: string) {
    if (!['ACTIVE', 'ENDED'].includes(to)) throw new UserError('Ungültiger Status.');
    const m = await this.get(id); if (!m) throw new UserError('Mitglied nicht gefunden.');
    if (to === 'ACTIVE' && !m.opt_in) throw new UserError('Mitgliedschaft erst nach ausdrücklichem Opt-in.');
    await this.pool.query(`update community_members set status = $3, joined_at = case when $3 = 'ACTIVE' then coalesce(joined_at, $4) else joined_at end, ended_at = case when $3 = 'ENDED' then $4 else null end, listed = case when $3 = 'ENDED' then false else listed end, updated_at = now() where id = $1 and owner_id = $2`, [id, this.owner, to, this.now()]);
    if (m.partner_id) await this.pool.query('update partners set community_status = $3 where id = $1 and owner_id = $2', [m.partner_id, this.owner, to === 'ACTIVE' ? 'MEMBER' : 'NONE']);
  }
  async stats() {
    const rows = await this.list(); const active = rows.filter((m: any) => m.status === 'ACTIVE');
    return { members: active.length, invited: rows.filter((m: any) => m.status === 'INVITED').length, listed: active.filter((m: any) => m.listed).length, free: active.filter((m: any) => m.fee.free).length, paying: active.filter((m: any) => !m.fee.free).length,
      mrrCents: active.reduce((a: number, m: any) => a + (m.billing === 'YEARLY' ? Math.round(m.feeCents / 12) : m.feeCents), 0) };
  }
}
