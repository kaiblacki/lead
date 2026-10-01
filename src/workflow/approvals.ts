import type pg from 'pg';
import type { Repo } from '../db/repo.ts';

/**
 * Allgemeiner Freigabe-Workflow: Das System darf analysieren, empfehlen und vorbereiten – ausführen erst nach Bestätigung durch den Nutzer.
 * Zustände: NOT_REQUIRED → RECOMMENDED → AWAITING_APPROVAL → APPROVED → COMPLETED (oder REJECTED).
 * Jetzt genutzt für DEMO_CREATE; EMAIL_SEND, FOLLOW_UP_SEND, PREMIUM_ANALYSIS und PUBLISH_WEBSITE sind vorgesehen (noch nicht umgesetzt).
 */
export type ApprovalAction = 'DEMO_CREATE' | 'EMAIL_SEND' | 'FOLLOW_UP_SEND' | 'PREMIUM_ANALYSIS' | 'PUBLISH_WEBSITE';
export type ApprovalState = 'NOT_REQUIRED' | 'RECOMMENDED' | 'AWAITING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'COMPLETED';
export const APPROVAL_LABEL: Record<ApprovalState, string> = { NOT_REQUIRED: 'nicht nötig', RECOMMENDED: 'empfohlen', AWAITING_APPROVAL: 'wartet auf Bestätigung', APPROVED: 'bestätigt', REJECTED: 'abgelehnt', COMPLETED: 'erledigt' };
const OPEN: ApprovalState[] = ['RECOMMENDED', 'AWAITING_APPROVAL', 'APPROVED'];
type Db = pg.Pool | pg.PoolClient;

export class ApprovalStore {
  repo: Repo;
  constructor(repo: Repo) { this.repo = repo; }
  private get owner() { return this.repo.ownerId; }
  private db(c?: Db): Db { return c ?? this.repo.pool; }

  /** Letzter Eintrag je Lead und Aktion. */
  async latest(leadId: string, action: ApprovalAction, c?: Db) {
    return (await this.db(c).query('select * from approvals where lead_id=$1 and owner_id=$2 and action=$3 order by requested_at desc, id desc limit 1', [leadId, this.owner, action])).rows[0] ?? null;
  }
  async stateOf(leadId: string, action: ApprovalAction = 'DEMO_CREATE', c?: Db): Promise<ApprovalState> { return ((await this.latest(leadId, action, c))?.state ?? 'NOT_REQUIRED') as ApprovalState; }

  /** Das System empfiehlt. Eine abgelehnte oder erledigte Aktion wird nicht erneut vorgeschlagen. */
  async recommend(leadId: string, action: ApprovalAction, reason: string, payload: object = {}, c?: Db): Promise<ApprovalState> {
    const cur = await this.latest(leadId, action, c);
    if (cur && OPEN.includes(cur.state)) { await this.db(c).query('update approvals set reason=$2 where id=$1 and state=$3', [cur.id, reason, 'RECOMMENDED']); return cur.state; }
    if (cur && (cur.state === 'REJECTED' || cur.state === 'COMPLETED')) return cur.state;
    await this.db(c).query("insert into approvals(owner_id, lead_id, action, state, reason, payload) values ($1,$2,$3,'RECOMMENDED',$4,$5)", [this.owner, leadId, action, reason, JSON.stringify(payload)]);
    return 'RECOMMENDED';
  }
  /** Die Empfehlung gilt nicht mehr (z. B. nach neuer Bewertung). Hat der Nutzer schon reagiert, bleibt der Vorgang. */
  async withdraw(leadId: string, action: ApprovalAction, c?: Db) { await this.db(c).query("update approvals set state='NOT_REQUIRED' where lead_id=$1 and owner_id=$2 and action=$3 and state='RECOMMENDED'", [leadId, this.owner, action]); }

  /** Der Nutzer hat „erstellen“ geklickt: jetzt wartet der Vorgang auf die Bestätigung. */
  async request(leadId: string, action: ApprovalAction, reason = 'Vom Nutzer angefordert', c?: Db) {
    const cur = await this.latest(leadId, action, c);
    if (cur?.state === 'AWAITING_APPROVAL' || cur?.state === 'APPROVED') return cur.state as ApprovalState;
    if (cur?.state === 'RECOMMENDED') await this.db(c).query("update approvals set state='AWAITING_APPROVAL', decided_by=null where id=$1", [cur.id]);
    else await this.db(c).query("insert into approvals(owner_id, lead_id, action, state, reason) values ($1,$2,$3,'AWAITING_APPROVAL',$4)", [this.owner, leadId, action, reason]);
    await this.repo.event(this.db(c), leadId, 'approval_requested', { action, actor: 'user' });
    return 'AWAITING_APPROVAL' as ApprovalState;
  }
  /** Bestätigung durch den Nutzer. Ohne vorherige Anforderung nicht möglich. */
  async approve(leadId: string, action: ApprovalAction, by = 'user', c?: Db) {
    const r = await this.db(c).query("update approvals set state='APPROVED', decided_at=now(), decided_by=$4 where lead_id=$1 and owner_id=$2 and action=$3 and state='AWAITING_APPROVAL' returning id", [leadId, this.owner, action, by]);
    if (!r.rowCount) throw new Error('Keine Anforderung, die bestätigt werden kann.');
    await this.repo.event(this.db(c), leadId, 'approval_approved', { action, actor: by });
  }
  async cancel(leadId: string, action: ApprovalAction, c?: Db) { await this.db(c).query("update approvals set state='RECOMMENDED' where lead_id=$1 and owner_id=$2 and action=$3 and state='AWAITING_APPROVAL'", [leadId, this.owner, action]); }
  async complete(leadId: string, action: ApprovalAction, payload: object = {}, c?: Db) {
    await this.db(c).query("update approvals set state='COMPLETED', completed_at=now(), payload = payload || $4::jsonb where lead_id=$1 and owner_id=$2 and action=$3 and state in ('RECOMMENDED','AWAITING_APPROVAL','APPROVED')", [leadId, this.owner, action, JSON.stringify(payload)]);
  }
  /** Ablehnung bleibt gespeichert; das System schlägt dieselbe Aktion nicht erneut vor. */
  async reject(leadId: string, action: ApprovalAction, by = 'user', reason?: string, c?: Db) {
    const r = await this.db(c).query("update approvals set state='REJECTED', decided_at=now(), decided_by=$4, reason=coalesce($5, reason) where lead_id=$1 and owner_id=$2 and action=$3 and state in ('RECOMMENDED','AWAITING_APPROVAL','APPROVED')", [leadId, this.owner, action, by, reason ?? null]);
    if (!r.rowCount) await this.db(c).query("insert into approvals(owner_id, lead_id, action, state, reason, decided_at, decided_by) values ($1,$2,$3,'REJECTED',$4,now(),$5)", [this.owner, leadId, action, reason ?? 'Vom Nutzer abgelehnt', by]);
    await this.repo.event(this.db(c), leadId, 'approval_rejected', { action, actor: by });
  }
  /** Ablehnung zurücknehmen: danach darf das System wieder empfehlen. */
  async reopen(leadId: string, action: ApprovalAction, c?: Db) { await this.db(c).query("update approvals set state='NOT_REQUIRED' where lead_id=$1 and owner_id=$2 and action=$3 and state='REJECTED'", [leadId, this.owner, action]); }
}
