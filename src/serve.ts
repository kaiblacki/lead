import { Repo } from './db/repo.ts';
import { buildContext } from './context.ts';
import { createApp } from './dashboard/server.ts';

const env = process.env;
const password = env.DASHBOARD_PASSWORD;
if (!password || password.length < 12) { console.error('DASHBOARD_PASSWORD fehlt oder ist kürzer als 12 Zeichen.'); process.exit(1); }
const host = env.HOST ?? '127.0.0.1';
const port = Number(env.PORT ?? 3000);
const baseUrl = (env.PUBLIC_BASE_URL ?? `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`).replace(/\/$/, '');

const repo = Repo.fromEnv();
const ctx = buildContext(repo, { baseUrl });
const interrupted = await ctx.runs.markInterrupted();
if (interrupted) console.warn(`${interrupted} unterbrochene(r) Suchlauf/Läufe als gestoppt markiert.`);
const app = createApp(ctx, { password, baseUrl, trustProxy: env.TRUST_PROXY === '1', autoDeploy: env.AUTO_DEPLOY === '1' });
app.listen(port, host, () => {
  console.log(`Dashboard: ${baseUrl} (Benutzername beliebig, Passwort = DASHBOARD_PASSWORD)`);
  for (const s of ctx.registry.status) console.log(`  ${s.kind.padEnd(10)} ${s.name.padEnd(20)} ${s.mode.padEnd(5)} ${s.note}`);
});

// Wartungsprüfungen regelmäßig ausführen (stündlich), wenn gewünscht.
if (env.MAINTENANCE_AUTORUN === '1') {
  setInterval(() => { ctx.maintenance.runDue().then((r) => r.checked && console.log(`Wartung: ${r.checked} geprüft, ${r.failed} mit Problemen`)).catch((e) => console.error('Wartungslauf fehlgeschlagen:', e.message)); }, 3600_000).unref();
}
const shutdown = () => { app.close(() => repo.close().finally(() => process.exit(0))); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
