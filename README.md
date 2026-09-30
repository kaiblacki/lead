# AI Agency OS – Phase 1 (Core MVP)

Findet Unternehmen, die wahrscheinlich eine neue Website brauchen, prüft ihre Websites, bewertet sie nachvollziehbar und bereitet ein Verkaufsargument vor. **Es wird nichts automatisch gesendet.**

Plan und Architektur: `docs/ARCHITEKTUR.md`

## Nutzung (Node ≥ 22.18, keine Abhängigkeiten)

```
npm test                                   # 13 Tests (ohne Datenbank)
node src/cli.ts analyze examples/leads.csv # Bericht: out/report.html
node src/cli.ts analyze examples/leads.csv --offline   # ohne Netzwerk
node src/cli.ts analyze --search "Friseur" --region "Saarland" --limit 20   # braucht GOOGLE_PLACES_API_KEY
```

CSV-Spalten: Firmenname, Branche, Adresse, Stadt, Telefon, Website, Instagram, Facebook (Trennzeichen `;` oder `,`).

## Datenbank und Dashboard
```
npm install
cp .env.example .env    # DATABASE_URL, OWNER_ID, DASHBOARD_PASSWORD eintragen (Werte exportieren oder mit --env-file=.env starten)
node --env-file=.env src/cli.ts analyze datei.csv --save      # Lauf speichern (prüft Kill Switch, pausierte Leads, Limits aus der DB)
node --env-file=.env src/serve.ts                              # Dashboard auf http://127.0.0.1:3000
```
Dashboard: Lead-Liste mit Filtern, Detailseite (Begründung, Befunde mit Beleg, Verkaufsgrundlage, Verlauf), Pausieren, Retry, Ablehnen, Einstiegstext freigeben/bearbeiten, STOP-alles-Knopf, Budget-Limits, Score-Gewichte, Sperrliste.
Sicherheit: Passwortschutz (Pflicht, mind. 12 Zeichen), CSRF-Token, nur `127.0.0.1` standardmäßig. Die DB-Verbindung umgeht RLS – `DATABASE_URL` nur serverseitig und nie in Git.
Tests mit Datenbank: `npm run test:db` (legt lokale Test-DB `dbtest` an, 8 Tests).

## Konfiguration
- `config/scoring.json` – Gewichte und Schwellen des Opportunity Scores
- `config/pricing.json` – Angebote und Preise
- Limits: `src/guardrails/budget.ts`

## Datenbank
`supabase/migrations/0001_core.sql` (RLS an, Events append-only). Test: `test/rls_test.sql` gegen lokale Postgres-DB.

## Bekannte Grenzen
- Das Dashboard ist eine schlanke Node-Seite (kein Next.js). Für Vercel-Hosting müsste es portiert werden; bis dahin lokal oder auf einem eigenen Server betreiben.
- Places-Suche nutzt den Radius noch nicht (Textsuche nach Branche + Region).
- Design/Mobile werden aus HTML-Indikatoren abgeleitet, noch ohne Rendering/Screenshots.
