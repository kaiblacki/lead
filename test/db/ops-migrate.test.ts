import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { skip, DB_URL } from './helpers.ts';
import { appliedList, applyPending, makePlan } from '../../src/ops/migrate.ts';

/** Phase K: Migrationen wirklich anwenden – je Datei eine Transaktion, Fehler → Rollback dieser Datei, Tracking-Tabelle, bereits Angewendetes wird übersprungen. */
test('applyPending: Reihenfolge, Tracking, Rollback bei Fehler, zweiter Plan leer', { skip, timeout: 120_000 }, async () => {
  const c = new pg.Client({ connectionString: DB_URL }); await c.connect(); const t = `ops_probe_${Date.now()}`;
  try {
    const d = mkdtempSync(join(tmpdir(), 'opsmig-'));
    writeFileSync(join(d, '0001_a.sql'), `create table public.${t}_a(id int);`); writeFileSync(join(d, '0002_bad.sql'), `create table public.${t}_b(id int); select 1/0;`); writeFileSync(join(d, '0003_c.sql'), `create table public.${t}_c(id int);`);
    await c.query('drop table if exists public.schema_migrations'); let p = makePlan(d, await appliedList(c)); assert.equal(p.pending.length, 3);
    await assert.rejects(applyPending(c, d, p), /0002_bad\.sql fehlgeschlagen und zurückgerollt.*0001_a\.sql/);
    assert.ok((await c.query('select to_regclass($1) t', [`public.${t}_a`])).rows[0].t, 'erste Datei bleibt'); assert.equal((await c.query('select to_regclass($1) t', [`public.${t}_b`])).rows[0].t, null, 'fehlerhafte Datei zurückgerollt'); assert.equal((await c.query('select to_regclass($1) t', [`public.${t}_c`])).rows[0].t, null, 'danach nichts mehr');
    assert.deepEqual((await appliedList(c)).filter((f) => f.startsWith('000')).sort(), ['0001_a.sql']);
    writeFileSync(join(d, '0002_bad.sql'), `create table public.${t}_b(id int);`); p = makePlan(d, await appliedList(c)); assert.deepEqual(p.pending, ['0002_bad.sql', '0003_c.sql']);
    assert.deepEqual(await applyPending(c, d, p), ['0002_bad.sql', '0003_c.sql']); assert.equal(makePlan(d, await appliedList(c)).pending.length, 0);
  } finally { for (const x of ['a', 'b', 'c']) await c.query(`drop table if exists public.${t}_${x}`); await c.query('drop table if exists public.schema_migrations'); await c.end(); }
});
