import { Repo } from './db/repo.ts';
import { createApp } from './dashboard/app.ts';

const password = process.env.DASHBOARD_PASSWORD;
if (!password || password.length < 12) { console.error('DASHBOARD_PASSWORD fehlt oder ist kürzer als 12 Zeichen.'); process.exit(1); }
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);
createApp(Repo.fromEnv(), { password }).listen(port, host, () => console.log(`Dashboard: http://${host}:${port} (Benutzername beliebig, Passwort = DASHBOARD_PASSWORD)`));
