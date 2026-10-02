import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approve, assertMayApply, makePlan, planMarkdown, riskScan } from '../../src/ops/migrate.ts';

const mk = (files: Record<string, string>) => { const d = mkdtempSync(join(tmpdir(), 'mig-')); for (const [f, s] of Object.entries(files)) writeFileSync(join(d, f), s); return d; };
const NOW = new Date('2026-10-02T12:00:00Z');

test('Plan: nur offene Migrationen in Reihenfolge, Hash ändert sich mit dem Inhalt, Trockenlauf verändert nichts', () => {
  const d = mk({ '0001_a.sql': 'create table a(id int);', '0002_b.sql': 'create table b(id int);', '0003_c.sql': 'alter table b add column x int;', 'README.md': 'x' });
  const p = makePlan(d, ['0001_a.sql'], NOW); assert.deepEqual(p.pending, ['0002_b.sql', '0003_c.sql']); assert.deepEqual(p.applied, ['0001_a.sql']);
  const p2 = makePlan(d, ['0001_a.sql'], NOW); assert.equal(p2.hash, p.hash); writeFileSync(join(d, '0003_c.sql'), 'alter table b add column y int;'); assert.notEqual(makePlan(d, ['0001_a.sql'], NOW).hash, p.hash);
  assert.equal(makePlan(d, ['0001_a.sql', '0002_b.sql', '0003_c.sql'], NOW).pending.length, 0);
  assert.match(planMarkdown(p), /Trockenlauf – es wurde nichts verändert/);
});

test('Risiko-Scan markiert DROP/TRUNCATE/DELETE/ALTER TYPE/RENAME, ignoriert Kommentare und harmlose Anweisungen', () => {
  const sql = '-- drop table x;\ncreate table t(id int);\nalter table t add column c int;\ndrop table old;\ntruncate t;\ndelete from t where id=1;\nalter table t alter column c type text;\nalter table t rename to u;';
  const r = riskScan('0009_x.sql', sql); assert.deepEqual(r.map((x) => x.kind), ['DROP', 'TRUNCATE', 'DELETE', 'ALTER_TYPE', 'RENAME']);
  assert.equal(riskScan('0010.sql', 'create index if not exists i on t(id);').length, 0);
});

test('Anwenden nur mit Freigabe zum aktuellen Plan UND frischem Backup', () => {
  const d = mk({ '0001_a.sql': 'create table a(id int);' }); const out = mkdtempSync(join(tmpdir(), 'out-')); const bk = join(mkdtempSync(join(tmpdir(), 'bk-')), 'backups'); const p = makePlan(d, [], NOW);
  assert.throws(() => assertMayApply(out, bk, p, NOW), /Keine Freigabe/);
  assert.throws(() => approve(out, 'falscherhash', p, NOW), /passt nicht/);
  approve(out, p.hash, p, NOW); assert.throws(() => assertMayApply(out, bk, p, NOW), /Kein Backup/);
  mkdirSync(bk); const f = join(bk, 'backup-1.sql'); writeFileSync(f, 'select 1;'); utimesSync(f, new Date(NOW.getTime() - 30 * 3600000), new Date(NOW.getTime() - 30 * 3600000));
  assert.throws(() => assertMayApply(out, bk, p, NOW), /Stunden alt/);
  utimesSync(f, new Date(NOW.getTime() - 2 * 3600000), new Date(NOW.getTime() - 2 * 3600000)); assert.doesNotThrow(() => assertMayApply(out, bk, p, NOW));
  writeFileSync(join(d, '0002_b.sql'), 'create table b(id int);'); const p2 = makePlan(d, [], NOW); assert.throws(() => assertMayApply(out, bk, p2, NOW), /anderen Plan/);
  assert.throws(() => assertMayApply(out, bk, makePlan(d, ['0001_a.sql', '0002_b.sql'], NOW), NOW), /Keine offenen/);
});
