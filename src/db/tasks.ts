import type { Repo } from './repo.ts';

export type TaskKind = 'CALL_DEMO_READY' | 'CALL_BACK' | 'FOLLOW_UP' | 'REVIEW';

/** Aufgaben/Erinnerungen je Lead (z. B. „Demo fertig – anrufen“). Später Grundlage für Benachrichtigungen. */
export class TaskStore {
  repo: Repo;
  constructor(repo: Repo) { this.repo = repo; }
  private get pool() { return this.repo.pool; }
  private get owner() { return this.repo.ownerId; }
  async ensure(leadId: string, kind: TaskKind, title: string, dueAt: Date = new Date()) {
    await this.pool.query("insert into lead_tasks(owner_id, lead_id, kind, title, due_at) values ($1,$2,$3,$4,$5) on conflict (lead_id, kind) where status = 'OPEN' do nothing", [this.owner, leadId, kind, title, dueAt]);
  }
  async complete(leadId: string, kinds: TaskKind[]) {
    await this.pool.query("update lead_tasks set status='DONE', done_at=now() where lead_id=$1 and owner_id=$2 and status='OPEN' and kind = any($3)", [leadId, this.owner, kinds]);
  }
  async open(leadId: string) { return (await this.pool.query("select kind, title, due_at from lead_tasks where lead_id=$1 and owner_id=$2 and status='OPEN' order by due_at", [leadId, this.owner])).rows as { kind: TaskKind; title: string; due_at: Date }[]; }
}
