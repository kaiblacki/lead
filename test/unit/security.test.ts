import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { applyPatch, sanitizeContent } from '../../src/orders/delivery.ts';
import type { ProjectContent } from '../../src/orders/service.ts';

const tracked = () => execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter((f) => f && existsSync(f) && !/^(node_modules|package-lock\.json)/.test(f) && !/\.(png|jpg|ico|woff2?)$/.test(f));

test('Secrets-Scan: keine API-Keys, Tokens, privaten Schlüssel oder Passwörter im Repository', () => {
  const PATTERNS: [string, RegExp][] = [
    ['Stripe live key', /\b[sr]k_live_[A-Za-z0-9]{10,}/], ['Stripe test key', /\b[sr]k_test_[A-Za-z0-9]{16,}/], ['Stripe webhook secret', /\bwhsec_[A-Za-z0-9]{16,}/],
    ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{16,}/], ['OpenAI-style key', /\bsk-[A-Za-z0-9]{32,}/], ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}/],
    ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/], ['JWT', /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/],
    ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/], ['AWS key', /\bAKIA[0-9A-Z]{16}\b/], ['Vercel token', /\bvercel_[A-Za-z0-9]{20,}/],
    ['Postgres URL mit echtem Passwort', /postgres(?:ql)?:\/\/[^:\s/@]+:(?!pw@|password@|passwort@|\[|<|\$|\{|xxx|\*+@)[^@\s]{8,}@(?!localhost|127\.0\.0\.1)[\w.-]+\.(?:supabase\.co|pooler\.supabase\.com|neon\.tech|amazonaws\.com)/],
  ];
  const hits: string[] = [];
  for (const f of tracked()) {
    const text = readFileSync(f, 'utf8');
    for (const [name, re] of PATTERNS) { const m = re.exec(text); if (m) hits.push(`${f}: ${name} (${m[0].slice(0, 12)}…)`); }
  }
  assert.deepEqual(hits, []);
});

test('Secrets-Hygiene: .env ist nicht versioniert, .env.example enthält keine Werte, Docker-Image kopiert keine Geheimnisse', () => {
  const files = tracked();
  assert.ok(!files.some((f) => /^\.env($|\.(?!example))/.test(f)), '.env-Dateien dürfen nicht im Repo liegen');
  assert.match(readFileSync('.gitignore', 'utf8'), /^\.env$/m);
  const secretKeys = /^(ANTHROPIC_API_KEY|GOOGLE_PLACES_API_KEY|SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|VERCEL_TOKEN|DASHBOARD_PASSWORD)=(.*)$/gm;
  const example = readFileSync('.env.example', 'utf8');
  const filled = [...example.matchAll(secretKeys)].filter((m) => m[2].trim() !== '').map((m) => m[1]);
  assert.deepEqual(filled, [], 'Schlüssel in .env.example müssen leer sein');
  const docker = readFileSync('Dockerfile', 'utf8');
  assert.ok(!/COPY[^\n]*\.env/.test(docker) && !/ENV[^\n]*(KEY|TOKEN|SECRET|PASSWORD)=/.test(docker));
  assert.match(readFileSync('.dockerignore', 'utf8'), /^\.env/m);
});

test('Dokumentation: jede vom Code gelesene Umgebungsvariable steht in .env.example', () => {
  const used = new Set<string>();
  for (const f of tracked().filter((x) => x.startsWith('src/') && x.endsWith('.ts'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]{3,})/g)) used.add(m[1]);
  }
  const example = readFileSync('.env.example', 'utf8');
  const missing = [...used].filter((k) => !new RegExp(`^#?\\s*${k}=`, 'm').test(example));
  assert.deepEqual(missing, []);
  assert.ok(used.has('APP_MODE') && used.has('DASHBOARD_PASSWORD'));
});

test('Keine Zugangsdaten im Quelltext der Provider: Keys kommen nur aus der Umgebung und werden nie geloggt', () => {
  for (const f of tracked().filter((x) => x.startsWith('src/'))) {
    const t = readFileSync(f, 'utf8');
    // Der NAME einer Variablen in einer Fehlermeldung ist in Ordnung – ein WERT (Interpolation, env.X als Argument) nicht.
    assert.ok(!/console\.(?:log|info|warn|error)\([^;]*(?:\$\{[^}]*(?:env\.|apiKey|secret|token|password)|,\s*(?:(?:process\.)?env\.\w*(?:KEY|SECRET|TOKEN|PASSWORD)|\w*(?:apiKey|secretKey|password)\b))/i.test(t), `${f} loggt ein Geheimnis`);
  }
});

const base: ProjectContent = { companyName: 'Salon A', services: [{ title: 'Schnitt', text: 'Damen und Herren' }], legal: {}, phone: '0681 123456', email: 'a@b.de' } as ProjectContent;

test('Änderungswunsch-Patch: nur erlaubte Felder, Validierung von Telefon/E-Mail/URL, Unbekanntes wird abgelehnt', () => {
  assert.throws(() => applyPatch(base, { phone: 'abc' }), /Telefonnummer/);
  assert.throws(() => applyPatch(base, { email: 'kaputt' }), /E-Mail/);
  assert.throws(() => applyPatch(base, { bookingUrl: 'http://unsicher.example' }), /https/);
  assert.throws(() => applyPatch(base, { bookingUrl: 'javascript:alert(1)' }), /https/);
  const r = applyPatch(base, { phone: '0681 987654', companyName: 'Hack', legal: { owner: 'x' }, __proto__: { x: 1 }, removeService: 'gibtsnicht', addService: { title: 'Bart', text: 'Trimmen' } });
  assert.deepEqual(r.applied.sort(), ['addService', 'phone']); assert.deepEqual(r.rejected.sort(), ['companyName', 'legal', 'removeService']);
  assert.equal(r.content.companyName, 'Salon A'); assert.equal(r.content.services.length, 2); assert.equal(r.content.phone, '0681 987654');
  assert.equal(base.services.length, 1, 'Ausgangsdaten bleiben unverändert');
  // Nicht-Strings werden nicht angewendet
  assert.deepEqual(applyPatch(base, { phone: 12345, about: { a: 1 } }).applied, []);
});

test('sanitizeContent: Längenbegrenzung, Trimmen, maximal 12 Leistungen, leere Felder entfallen', () => {
  const c = sanitizeContent({ companyName: 'x'.repeat(500), phone: '+49 681 12345', services: Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, text: 'Text' })), about: ' '.repeat(5) });
  assert.equal(c.companyName.length, 120); assert.equal(c.services.length, 12); assert.equal(c.about, undefined);
  assert.throws(() => sanitizeContent({ companyName: 'A', phone: '12' }), /Telefonnummer/);
  assert.throws(() => sanitizeContent(null), /Firmenname/);
});

test('Dockerfile (nicht ausführbar getestet): kopierte Pfade existieren, Startbefehl/Healthcheck/Nicht-Root vorhanden, Migrationen vollständig', () => {
  const d = readFileSync('Dockerfile', 'utf8');
  for (const m of d.matchAll(/^COPY\s+(.+?)\s+\.\/?\S*$/gm)) for (const src of m[1].split(/\s+/)) assert.ok(existsSync(src), `COPY ${src} existiert nicht`);
  assert.match(d, /^USER node$/m); assert.match(d, /^HEALTHCHECK /m); assert.match(d, /^CMD \["node", "src\/serve\.ts"\]$/m); assert.ok(existsSync('src/serve.ts'));
  assert.match(d, /\/healthz/); assert.match(d, /EXPOSE 3000/);
  for (const k of ['config', 'config.mock', 'templates', 'src']) assert.ok(d.includes(`COPY ${k} `), `${k} fehlt im Image`);
  const ignore = readFileSync('.dockerignore', 'utf8');
  assert.match(ignore, /^\.env$/m); assert.ok(!/^config\.mock$|^templates$|^src$/m.test(ignore), 'notwendige Ordner dürfen nicht ausgeschlossen sein');
  // Migrationen lückenlos nummeriert
  const mig = execFileSync('ls', ['supabase/migrations'], { encoding: 'utf8' }).trim().split('\n');
  mig.forEach((f, i) => assert.ok(f.startsWith(String(i + 1).padStart(4, '0') + '_'), `Migration ${f} an Position ${i + 1}`));
});
