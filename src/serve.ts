import { Repo } from './db/repo.ts';
import { createApp } from './dashboard/app.ts';
import { StripeProvider } from './payments/provider.ts';
import { FolderDeployer, VercelDeployer } from './deploy/adapters.ts';

const password = process.env.DASHBOARD_PASSWORD;
if (!password || password.length < 12) { console.error('DASHBOARD_PASSWORD fehlt oder ist kürzer als 12 Zeichen.'); process.exit(1); }
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);
const payments = process.env.STRIPE_SECRET_KEY ? (() => { const p = new StripeProvider(); return () => p; })() : undefined;
const deployer = process.env.VERCEL_TOKEN ? (() => { const d = new VercelDeployer(); return () => d; })() : (() => { const d = new FolderDeployer(); return () => d; })();
createApp(Repo.fromEnv(), { password, payments, deployer, baseUrl: process.env.PUBLIC_BASE_URL ?? `http://${host}:${port}`, autoDeploy: process.env.AUTO_DEPLOY === '1' }).listen(port, host, () => console.log(`Dashboard: http://${host}:${port} (Benutzername beliebig, Passwort = DASHBOARD_PASSWORD)`));
