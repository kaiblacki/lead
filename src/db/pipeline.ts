import type pg from 'pg';
import type { Repo } from './repo.ts';
import type { AppConfig } from '../core/config.ts';
import { computePriority, PRIORITIES, type Priority, type PriorityInput } from '../scoring/priority.ts';
import type { MatchRecord } from '../dedupe/match.ts';

export type ExistingLead = MatchRecord & { id: string; source: string; ref: string; status: string };

/** Priorität A–D, Notizen, Website-Module und Dubletten-Verwaltung. Alles pro Besitzer (owner_id) getrennt. */
export class PipelineStore {
  repo: Repo; cfg: AppConfig; now: () => Date;
  constructor(d: { repo: Repo; cfg: AppConfig; now?: () => Date }) { this.repo = d.repo; this.cfg = d.cfg; this.now = d.now ?? (() => new Date()); }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }

  // ---------- Priorität ----------
  async priorityInput(leadId: string, c: pg.Pool | pg.PoolClient = this.pool): Promise<PriorityInput | null> {
    const l = (await c.query('select * from leads where id=$1 and owner_id=$2', [leadId, this.owner])).rows[0]; if (!l) return null;
    const [o, a, d, f] = await Promise.all([
      c.query('select score, dimensions from opportunities where lead_id=$1 and owner_id=$2 order by created_at desc, id desc limit 1', [leadId, this.owner]),
      c.query('select id, status, overall_quality from audits where lead_id=$1 and owner_id=$2 order by created_at desc, id desc limit 1', [leadId, this.owner]),
      c.query('select 1 from demos where lead_id=$1 and owner_id=$2 and not revoked limit 1', [leadId, this.owner]),
      c.query("select key, value from lead_facts where lead_id=$1 and owner_id=$2 and key in ('email','businessStatus','social')", [leadId, this.owner]),
    ]);
    const fails = a.rows[0] ? Number((await c.query("select count(*)::int n from findings where audit_id=$1 and owner_id=$2 and status='fail'", [a.rows[0].id, this.owner])).rows[0].n) : 0;
    const dq = o.rows[0]?.dimensions?.dataQuality?.value;
    const sub = this.cfg.taxonomy.sub(l.sub_industry);
    const closed = f.rows.some((x) => x.key === 'businessStatus' && /CLOSED_PERMANENTLY/.test(JSON.stringify(x.value)));
    const recentSocial = f.rows.some((x) => x.key === 'social' && x.value?.lastPostAt && Date.parse(x.value.lastPostAt) > this.now().getTime() - 180 * 86400000);
    const operational = f.rows.some((x) => x.key === 'businessStatus' && /OPERATIONAL/.test(JSON.stringify(x.value)));
    return {
      websiteState: l.website_state, auditStatus: a.rows[0]?.status ?? null, websiteScore: l.website_state === 'none' ? null : a.rows[0]?.overall_quality ?? null, salesOpportunity: o.rows[0]?.score ?? null,
      hasPhone: !!l.phone, hasEmail: !!l.email || f.rows.some((x) => x.key === 'email'), closed, active: operational || Number(l.review_count ?? 0) > 0 || recentSocial, localIndustry: !!sub,
      clearWeaknesses: fails, hasDemo: d.rowCount! > 0, dataQuality: typeof dq === 'number' ? dq : null, blocked: !!l.contact_blocked,
    };
  }
  /** Setzt die automatische Priorität neu. Eine manuelle Priorität bleibt maßgeblich (effective_priority). */
  async recomputePriority(leadId: string, c: pg.Pool | pg.PoolClient = this.pool): Promise<{ auto: Priority; effective: Priority; reason: string } | null> {
    const inp = await this.priorityInput(leadId, c); if (!inp) return null;
    const r = computePriority(inp, this.cfg.pipeline.priority);
    const row = (await c.query('update leads set auto_priority=$3, effective_priority=coalesce(manual_priority, $3), priority_reason=$4, priority_updated_at=now() where id=$1 and owner_id=$2 returning manual_priority, effective_priority', [leadId, this.owner, r.priority, r.reason])).rows[0];
    return { auto: r.priority, effective: row.effective_priority, reason: r.reason };
  }
  async setManualPriority(leadId: string, p: Priority | null) {
    if (p !== null && !PRIORITIES.includes(p)) throw new Error('Priorität muss A, B, C oder D sein.');
    const r = await this.pool.query('update leads set manual_priority=$3, effective_priority=coalesce($3, auto_priority), priority_updated_at=now() where id=$1 and owner_id=$2 returning auto_priority', [leadId, this.owner, p]);
    if (!r.rowCount) throw new Error('Lead nicht gefunden');
    await this.repo.event(this.pool, leadId, 'priority_override', { manual: p, auto: r.rows[0].auto_priority, actor: 'user' });
  }

  // ---------- Notizen ----------
  async note(leadId: string): Promise<{ body: string; created_at: Date; updated_at: Date } | null> {
    return (await this.pool.query('select body, created_at, updated_at from lead_notes where lead_id=$1 and owner_id=$2', [leadId, this.owner])).rows[0] ?? null;
  }
  async saveNote(leadId: string, body: string) {
    if (body.length > 20000) throw new Error('Notiz ist zu lang (max. 20.000 Zeichen).');
    if (!(await this.pool.query('select 1 from leads where id=$1 and owner_id=$2', [leadId, this.owner])).rowCount) throw new Error('Lead nicht gefunden');
    await this.pool.query('insert into lead_notes(owner_id, lead_id, body) values ($1,$2,$3) on conflict (lead_id) do update set body=$3, updated_at=now()', [this.owner, leadId, body]);
    await this.repo.event(this.pool, leadId, 'note_saved', { chars: body.length, actor: 'user' });
  }

  // ---------- Demo-Empfehlung, Layout, Module ----------
  async setDemoRecommended(leadId: string) { await this.pool.query("update leads set demo_decision='recommended' where id=$1 and owner_id=$2 and demo_decision is null", [leadId, this.owner]); }
  async setModuleState(leadId: string, st: { family?: string | null; recommended?: string[]; selected?: string[] | null }) {
    const sets: string[] = []; const p: unknown[] = [leadId, this.owner];
    if (st.family !== undefined) { p.push(st.family); sets.push(`demo_family=$${p.length}`); }
    if (st.recommended) { p.push(JSON.stringify(st.recommended)); sets.push(`modules_recommended=$${p.length}`); }
    if (st.selected !== undefined) { p.push(st.selected === null ? null : JSON.stringify(st.selected)); sets.push(`modules_selected=$${p.length}`); }
    if (sets.length) await this.pool.query(`update leads set ${sets.join(', ')} where id=$1 and owner_id=$2`, p);
  }

  // ---------- Dubletten ----------
  /** Bereits vorhandene Leads im Suchgebiet (Rechteck um das Zentrum) – für den Abgleich neuer Treffer. */
  async nearby(center: { lat: number; lng: number }, radiusKm: number): Promise<ExistingLead[]> {
    const dLat = radiusKm / 111 + 0.02, dLng = radiusKm / (111 * Math.cos((center.lat * Math.PI) / 180)) + 0.02;
    const r = await this.pool.query(
      `select id, company_name, phone, email, website_url, address, postal_code, city, lat, lng, sub_industry, source, source_ref, status from leads
        where owner_id=$1 and (lat is null or (lat between $2 and $3 and lng between $4 and $5)) limit 20000`, [this.owner, center.lat - dLat, center.lat + dLat, center.lng - dLng, center.lng + dLng]);
    return r.rows.map((x) => ({ id: x.id, source: x.source, ref: x.source_ref, status: x.status, name: x.company_name, phone: x.phone, email: x.email, website: x.website_url, address: x.address, postalCode: x.postal_code, city: x.city,
      point: x.lat !== null && x.lng !== null ? { lat: x.lat, lng: x.lng } : null, subIndustry: x.sub_industry }));
  }
  async addAlias(leadId: string, source: string, ref: string) { await this.pool.query('insert into lead_aliases(owner_id, lead_id, source, source_ref) values ($1,$2,$3,$4) on conflict (owner_id, source, source_ref) do nothing', [this.owner, leadId, source, ref]); }
  async leadOfRef(source: string, ref: string): Promise<string | null> {
    const r = await this.pool.query('select id from leads where owner_id=$1 and source=$2 and source_ref=$3 union all select lead_id from lead_aliases where owner_id=$1 and source=$2 and source_ref=$3 limit 1', [this.owner, source, ref]);
    return r.rows[0]?.id ?? null;
  }
  async addCandidate(leadId: string, otherId: string, score: number, reasons: string[]) {
    if (leadId === otherId) return;
    if (leadId > otherId) [leadId, otherId] = [otherId, leadId];       // je Paar nur ein Eintrag, egal in welcher Reihenfolge gefunden
    await this.pool.query('insert into lead_match_candidates(owner_id, lead_id, other_lead_id, score, reasons) values ($1,$2,$3,$4,$5) on conflict (lead_id, other_lead_id) do nothing', [this.owner, leadId, otherId, score, JSON.stringify(reasons)]);
    await this.pool.query("update leads set review_flag='possible_duplicate' where owner_id=$1 and id = any($2)", [this.owner, [leadId, otherId]]);
  }
  async candidatesOf(leadId: string) {
    return (await this.pool.query(`select c.id, c.score, c.reasons, c.status, l.id lead_id, l.company_name, l.city, l.phone, l.website_url, l.address from lead_match_candidates c
      join leads l on l.id = case when c.lead_id=$1 then c.other_lead_id else c.lead_id end where (c.lead_id=$1 or c.other_lead_id=$1) and c.owner_id=$2 and c.status='open' order by c.score desc`, [leadId, this.owner])).rows;
  }
  async openCandidateCount() { return Number((await this.pool.query("select count(*)::int n from lead_match_candidates where owner_id=$1 and status='open'", [this.owner])).rows[0].n); }
  async dismissCandidate(id: string) {
    const r = await this.pool.query("update lead_match_candidates set status='dismissed', resolved_at=now() where id=$1 and owner_id=$2 and status='open' returning lead_id, other_lead_id", [id, this.owner]);
    if (!r.rowCount) throw new Error('Eintrag nicht gefunden');
    await this.clearFlag([r.rows[0].lead_id, r.rows[0].other_lead_id]);
    return r.rows[0].lead_id as string;
  }
  private async clearFlag(ids: string[]) {
    await this.pool.query(`update leads l set review_flag=null where owner_id=$1 and id = any($2) and review_flag='possible_duplicate'
      and not exists (select 1 from lead_match_candidates c where c.owner_id=$1 and c.status='open' and (c.lead_id=l.id or c.other_lead_id=l.id))`, [this.owner, ids]);
  }
  /** Manuelle Zusammenführung: `drop` wird in `keep` aufgenommen (Fakten und Quellenkennungen bleiben erhalten). Nur ohne Verkaufsvorgang am gelöschten Lead. */
  async mergeLeads(keepId: string, dropId: string) {
    if (keepId === dropId) throw new Error('Gleicher Lead.');
    await this.repo.tx(async (c) => {
      const rows = (await c.query('select id, source, source_ref, status from leads where owner_id=$1 and id = any($2)', [this.owner, [keepId, dropId]])).rows;
      const keep = rows.find((r) => r.id === keepId), drop = rows.find((r) => r.id === dropId); if (!keep || !drop) throw new Error('Lead nicht gefunden');
      for (const t of ['offers', 'orders', 'demos', 'contact_history']) if ((await c.query(`select 1 from ${t} where lead_id=$1 and owner_id=$2 limit 1`, [dropId, this.owner])).rowCount) throw new Error('Der zu entfernende Lead hat bereits Vorgänge (Demo/Angebot/Kontakt) – bitte stattdessen den anderen Lead entfernen oder die Prüfung verwerfen.');
      await c.query(`insert into lead_facts(owner_id, lead_id, key, value, source, source_url, note, quality, captured_at)
        select owner_id, $1, key, value, source, source_url, note, quality, captured_at from lead_facts f where f.lead_id=$2 and f.owner_id=$3
          and not exists (select 1 from lead_facts g where g.lead_id=$1 and g.key=f.key and g.value=f.value and g.source=f.source)`, [keepId, dropId, this.owner]);
      await c.query('update lead_aliases set lead_id=$1 where lead_id=$2 and owner_id=$3 and not exists (select 1 from lead_aliases a where a.lead_id=$1 and a.source=lead_aliases.source and a.source_ref=lead_aliases.source_ref)', [keepId, dropId, this.owner]);
      await c.query('insert into lead_aliases(owner_id, lead_id, source, source_ref) values ($1,$2,$3,$4) on conflict (owner_id, source, source_ref) do update set lead_id=$2', [this.owner, keepId, drop.source, drop.source_ref]);
      await c.query("update lead_match_candidates set status='merged', resolved_at=now() where owner_id=$1 and ((lead_id=$2 and other_lead_id=$3) or (lead_id=$3 and other_lead_id=$2))", [this.owner, keepId, dropId]);
      await c.query('delete from lead_match_candidates where owner_id=$1 and (lead_id=$2 or other_lead_id=$2)', [this.owner, dropId]);
      await c.query('delete from lead_aliases where owner_id=$1 and lead_id=$2', [this.owner, dropId]);
      await c.query('delete from leads where id=$1 and owner_id=$2', [dropId, this.owner]);
      await this.repo.event(c, keepId, 'leads_merged', { dropped: dropId, actor: 'user' });
    });
    await this.clearFlag([keepId]);
  }
}
