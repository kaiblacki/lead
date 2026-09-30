# AI Agency OS – Phase 1 (Core MVP)

Findet Unternehmen, die wahrscheinlich eine neue Website brauchen, prüft ihre Websites, bewertet sie nachvollziehbar und bereitet ein Verkaufsargument vor. **Es wird nichts automatisch gesendet.**

Plan und Architektur: `docs/ARCHITEKTUR.md`

## Nutzung (Node ≥ 22.18, keine Abhängigkeiten)

```
npm test                                   # 13 Tests
node src/cli.ts analyze examples/leads.csv # Bericht: out/report.html
node src/cli.ts analyze examples/leads.csv --offline   # ohne Netzwerk
node src/cli.ts analyze --search "Friseur" --region "Saarland" --limit 20   # braucht GOOGLE_PLACES_API_KEY
```

CSV-Spalten: Firmenname, Branche, Adresse, Stadt, Telefon, Website, Instagram, Facebook (Trennzeichen `;` oder `,`).

## Konfiguration
- `config/scoring.json` – Gewichte und Schwellen des Opportunity Scores
- `config/pricing.json` – Angebote und Preise
- Limits: `src/guardrails/budget.ts`

## Datenbank
`supabase/migrations/0001_core.sql` (RLS an, Events append-only). Test: `test/rls_test.sql` gegen lokale Postgres-DB.

## Bekannte Grenzen
- Die Datenbank ist noch nicht an die CLI angeschlossen (Bericht als HTML-Datei statt Live-Dashboard).
- Places-Suche nutzt den Radius noch nicht (Textsuche nach Branche + Region).
- Design/Mobile werden aus HTML-Indikatoren abgeleitet, noch ohne Rendering/Screenshots.
