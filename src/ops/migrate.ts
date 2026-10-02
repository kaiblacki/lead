import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Migrationen für den Produktivbetrieb: erst Plan (Trockenlauf), dann Freigabe durch Kai, dann Anwendung – nie automatisch. */
export const TRACKING_TABLE = 'public.schema_migrations';
export type Risk = { file: string; kind: 'DROP' | 'TRUNCATE' | 'DELETE' | 'ALTER_TYPE' | 'RENAME'; line: string };
export type Plan = { pending: string[]; applied: string[]; risks: Risk[]; hash: string; createdAt: string };

export const migrationFiles = (dir: string) => readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const RISKY: [Risk['kind'], RegExp][] = [['DROP', /\bdrop\s+(table|column|schema|index|policy|trigger|function|type)\b(?!\s+if\s+exists\s+\S*\s*;?\s*--\s*safe)/i], ['TRUNCATE', /\btruncate\b/i], ['DELETE', /\bdelete\s+from\b/i], ['ALTER_TYPE', /\balter\s+column\s+\S+\s+(set\s+data\s+)?type\b/i], ['RENAME', /\brename\b/i]];

/** Markiert Anweisungen, die Daten löschen oder verändern könnten – nur ein Hinweis für die Freigabe, keine Garantie. */
export function riskScan(file: string, sql: string): Risk[] {
  const out: Risk[] = [];
  for (const raw of sql.split('\n')) { const line = raw.replace(/--.*$/, '').trim(); if (!line) continue; for (const [kind, re] of RISKY) if (re.test(line)) { out.push({ file, kind, line: line.slice(0, 160) }); break; } }
  return out;
}
export const planHash = (pending: string[], dir: string) => createHash('sha256').update(pending.map((f) => `${f}\n${readFileSync(join(dir, f), 'utf8')}`).join('\n--\n')).digest('hex');

export function makePlan(dir: string, applied: string[], now = new Date()): Plan {
  const files = migrationFiles(dir); const done = new Set(applied); const pending = files.filter((f) => !done.has(f));
  return { pending, applied: files.filter((f) => done.has(f)), risks: pending.flatMap((f) => riskScan(f, readFileSync(join(dir, f), 'utf8'))), hash: planHash(pending, dir), createdAt: now.toISOString() };
}
export const planMarkdown = (p: Plan) => `# Migrationsplan (Trockenlauf – es wurde nichts verändert)\n\nErstellt: ${p.createdAt}\nPlan-Hash: \`${p.hash}\`\n\n## Offene Migrationen (${p.pending.length})\n${p.pending.length ? p.pending.map((f) => `- ${f}`).join('\n') : '- keine'}\n\n## Hinweise auf datenverändernde Anweisungen (${p.risks.length})\n${p.risks.length ? p.risks.map((r) => `- ${r.file}: **${r.kind}** – \`${r.line}\``).join('\n') : '- keine gefunden (keine Garantie, bitte trotzdem lesen)'}\n\n## Freigabe\nAnwenden nur nach: 1) frischem Backup (\`npm run ops -- backup\`), 2) deiner ausdrücklichen Freigabe: \`npm run ops -- migrate:approve ${p.hash}\`, 3) \`npm run ops -- migrate:apply\`.\n`;

const APPROVAL = 'migrate-approval.json';
export function writePlan(outDir: string, p: Plan) { mkdirSync(outDir, { recursive: true }); writeFileSync(join(outDir, 'migrate-plan.md'), planMarkdown(p)); writeFileSync(join(outDir, 'migrate-plan.json'), JSON.stringify(p, null, 1)); }
export function approve(outDir: string, hash: string, current: Plan, now = new Date()) {
  if (hash !== current.hash) throw new Error('Freigabe passt nicht zum aktuellen Plan (Hash). Bitte den Plan neu erzeugen und lesen.');
  if (!current.pending.length) throw new Error('Nichts freizugeben: keine offenen Migrationen.');
  mkdirSync(outDir, { recursive: true }); writeFileSync(join(outDir, APPROVAL), JSON.stringify({ hash, approvedAt: now.toISOString() }));
}
/** Voraussetzungen zur Anwendung: Freigabe zum aktuellen Plan + Backup (jünger als maxBackupAgeH). Wirft eine verständliche Fehlermeldung. */
export function assertMayApply(outDir: string, backupDir: string, current: Plan, now = new Date(), maxBackupAgeH = 24) {
  if (!current.pending.length) throw new Error('Keine offenen Migrationen.');
  const f = join(outDir, APPROVAL); if (!existsSync(f)) throw new Error('Keine Freigabe vorhanden. Erst Plan lesen und freigeben (migrate:approve <Hash>).');
  const a = JSON.parse(readFileSync(f, 'utf8')) as { hash: string };
  if (a.hash !== current.hash) throw new Error('Die Freigabe gehört zu einem anderen Plan – bitte neu freigeben.');
  const b = latestBackup(backupDir); if (!b) throw new Error('Kein Backup gefunden. Erst `npm run ops -- backup` ausführen.');
  const ageH = (now.getTime() - b.mtimeMs) / 3600000; if (ageH > maxBackupAgeH) throw new Error(`Das letzte Backup ist ${Math.round(ageH)} Stunden alt (erlaubt: ${maxBackupAgeH}). Bitte ein neues anlegen.`);
}
export function latestBackup(dir: string): { file: string; mtimeMs: number; size: number } | null {
  if (!existsSync(dir)) return null;
  const list = readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => { const s = statSync(join(dir, f)); return { file: join(dir, f), mtimeMs: s.mtimeMs, size: s.size }; }).filter((x) => x.size > 0).sort((a, b) => b.mtimeMs - a.mtimeMs);
  return list[0] ?? null;
}
type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
export async function appliedList(db: Db): Promise<string[]> {
  await db.query(`create table if not exists ${TRACKING_TABLE} (file text primary key, applied_at timestamptz not null default now())`);
  const own = (await db.query(`select file from ${TRACKING_TABLE}`)).rows.map((r) => r.file as string);
  const demo = (await db.query("select to_regclass('public.demo_migrations') as t")).rows[0].t ? (await db.query('select file from public.demo_migrations')).rows.map((r) => r.file as string) : [];
  return [...new Set([...own, ...demo])];
}
/** Wendet die offenen Migrationen einzeln in je einer Transaktion an. Bricht beim ersten Fehler ab (Rollback dieser Datei). */
export async function applyPending(client: Db, dir: string, plan: Plan): Promise<string[]> {
  const done: string[] = [];
  for (const f of plan.pending) {
    await client.query('begin');
    try { await client.query(readFileSync(join(dir, f), 'utf8')); await client.query(`insert into ${TRACKING_TABLE}(file) values ($1)`, [f]); await client.query('commit'); done.push(f); }
    catch (e) { await client.query('rollback'); throw new Error(`Migration ${f} fehlgeschlagen und zurückgerollt: ${e instanceof Error ? e.message : e}. Bereits angewendet: ${done.join(', ') || 'keine'}.`); }
  }
  return done;
}
