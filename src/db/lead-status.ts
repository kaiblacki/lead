import type pg from 'pg';
import type { Repo } from './repo.ts';
import { canTransition, findPath, transition, type Status } from '../core/status.ts';

/** Stufen, die für den Learning Loop als Ergebnis festgehalten werden. */
const OUTCOME_STAGES: Status[] = ['CONTACTED', 'REPLIED', 'INTERESTED', 'DEMO_CREATED', 'OFFER_SENT', 'OFFER_ACCEPTED', 'DEPOSIT_PAID', 'DEPLOYED', 'MAINTENANCE', 'IGNORED'];

export async function recordOutcome(repo: Repo, c: pg.PoolClient | pg.Pool, leadId: string, kind: 'call' | 'stage' | 'final', value: string, payload: object = {}) {
  const snap = (await c.query('select id from score_snapshots where lead_id=$1 and owner_id=$2 order by created_at desc limit 1', [leadId, repo.ownerId])).rows[0];
  await c.query('insert into lead_outcomes(owner_id, lead_id, snapshot_id, kind, value, payload) values ($1,$2,$3,$4,$5,$6)', [repo.ownerId, leadId, snap?.id ?? null, kind, value, JSON.stringify(payload)]);
}

/**
 * Einziger Weg, den Lead-Status zu ändern. Schreibt pro Schritt ein Audit-Ereignis und die Learning-Loop-Ergebnisse.
 * `path: true` darf mehrere erlaubte Schritte hintereinander gehen (z. B. Anruf-Ergebnis „interessiert“), sonst ist nur ein direkter Übergang erlaubt.
 */
export async function moveLead(repo: Repo, c: pg.PoolClient, leadId: string, target: Status, reason: string, actor: string, opts: { path?: boolean; within?: Status[] } = {}): Promise<Status[]> {
  const r = await c.query('select status from leads where id=$1 and owner_id=$2 for update', [leadId, repo.ownerId]);
  if (!r.rows[0]) throw new Error('Lead nicht gefunden');
  const from = r.rows[0].status as Status;
  if (from === target) return [];
  let steps: Status[];
  if (opts.path) { steps = findPath(from, target, opts.within); if (!steps.length) throw new Error(`Kein erlaubter Weg von ${from} nach ${target}`); }
  else { if (!canTransition(from, target)) throw new Error(`Übergang ${from} → ${target} ist nicht erlaubt`); steps = [target]; }
  let cur = from;
  for (const to of steps) {
    const ev = transition(leadId, cur, to, reason);
    await c.query('update leads set status=$1 where id=$2 and owner_id=$3', [to, leadId, repo.ownerId]);
    await repo.event(c, leadId, 'status_change', { from: ev.from, to: ev.to, reason, actor });
    if (OUTCOME_STAGES.includes(to) && !(to === 'IGNORED' && actor === 'system')) await recordOutcome(repo, c, leadId, 'stage', to, { from: cur, reason, actor });
    cur = to;
  }
  return steps;
}
