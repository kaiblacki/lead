# Einrichtung Schritt für Schritt

Zeitbedarf: ca. 45 Minuten. Reihenfolge einhalten.

## 1. Supabase (Datenbank)
1. supabase.com → New project → Region **Central EU (Frankfurt)** → Passwort speichern.
2. SQL Editor → nacheinander den Inhalt von `supabase/migrations/0001_core.sql` bis `0005_social.sql` einfügen und jeweils **Run**.
3. Authentication → Users → **Add user** (deine E-Mail + Passwort). Die **User UID** (UUID) kopieren → das ist `OWNER_ID`.
4. Project Settings → Database → **Connection string** (Session pooler oder Direct, URI) kopieren → `DATABASE_URL` (Passwort einsetzen).

## 2. Konfiguration
1. `cp .env.example .env` und ausfüllen: `DATABASE_URL`, `OWNER_ID`, `DASHBOARD_PASSWORD` (mind. 12 Zeichen, zufällig).
2. `config/agency.json`: Agenturname, Kontakt-E-Mail.
3. `config/pricing.json`: alle `[Platzhalter]` ersetzen (Lieferzeit, USt-Hinweis, Vertragsbedingungen – **rechtlich prüfen lassen**).
4. Optional `ANTHROPIC_API_KEY`, `GOOGLE_PLACES_API_KEY` (Places-Suche; ohne Key nur CSV-Import).

## 3. Lokal testen
```
npm install
npm test
node --env-file=.env src/cli.ts analyze examples/leads.csv --save
node --env-file=.env src/serve.ts      # http://127.0.0.1:3000  (Benutzername egal, Passwort = DASHBOARD_PASSWORD)
```
Zuerst mit 10–20 echten Leads per CSV testen und die Begründungen der Scores auf Plausibilität lesen.

## 4. Zahlungen testen (Stripe Testmodus)
1. dashboard.stripe.com → Testmodus → Developers → API keys → **Secret key (sk_test_…)** → `STRIPE_SECRET_KEY`.
2. Stripe CLI installieren, dann: `stripe listen --forward-to http://127.0.0.1:3000/webhooks/stripe` → der ausgegebene `whsec_…` ist `STRIPE_WEBHOOK_SECRET`.
3. Dashboard neu starten, einen Test-Lead bis „Angebot versendet" führen, Bestellung anlegen, Anzahlungs-Link öffnen und mit der Testkarte `4242 4242 4242 4242` bezahlen.
4. Prüfen: Bestellstatus springt auf `IN_PRODUCTION`. Den kompletten Ablauf bis „Wartung aktiv" einmal durchspielen.

## 5. Öffentlich betreiben (Server mit HTTPS)
Stripe-Webhooks und Kundenlinks brauchen eine öffentliche HTTPS-Adresse. Vercel eignet sich für das Dashboard in dieser Form **nicht** (dauerhafter Node-Server nötig). Geeignet: ein kleiner Server/Container (Hetzner, Fly.io, Railway, Render).
```
docker build -t agency-os .
docker run -d --env-file .env -e PUBLIC_BASE_URL=https://deine-domain.de -e TRUST_PROXY=1 -p 3000:3000 agency-os
```
Davor einen Reverse-Proxy mit HTTPS (Caddy/nginx). Stripe-Webhook-URL im Dashboard eintragen: `https://deine-domain.de/webhooks/stripe`, Ereignisse: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`, `customer.subscription.deleted`, `invoice.payment_failed`. Erst danach auf Live-Schlüssel (`sk_live_…`) wechseln.
Health-Check: `GET /healthz`.

## 6. Kundenseiten veröffentlichen
Ohne `VERCEL_TOKEN` schreibt „Veröffentlichen" nach `out/sites/<name>/` (im Container: Volume mounten oder Vercel-Token setzen). Mit Token (`VERCEL_TOKEN`, ggf. `VERCEL_TEAM_ID`) wird bei Vercel veröffentlicht. Domain des Kunden danach in Vercel verbinden.

## Vor dem ersten echten Kunden
- Datenschutzerklärung und Impressum deiner eigenen Agentur (`privacy.html` im Projekt `workmode-2030` ist nur ein Platzhalter).
- AGB/Vertragstext prüfen lassen, USt-Behandlung klären.
- Supabase Free pausiert inaktive Projekte: für den Livebetrieb Pro-Plan nehmen.
- Datensicherung: Supabase Backups aktivieren (Pro).
