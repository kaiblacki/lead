# Agency Lead OS – Demo starten

Echte öffentliche Firmendaten (OpenStreetMap). Es wird nichts gesendet, gewählt oder bezahlt. Voraussetzungen: Node ≥ 22.18, lokales PostgreSQL, `psql`.

## Starten
```
cd ~/Projekte/lead
git pull origin claude/supabase-vercel-setup-17lr75
npm install
bash scripts/setup-local-db.sh agency_demo          # einmalig (bei Fehler: PGUSER/PGPASSWORD setzen, siehe SETUP.md)
psql -d agency_demo -c "insert into auth.users(id) values ('00000000-0000-0000-0000-00000000b002') on conflict do nothing"
APP_MODE=live DATABASE_URL=postgres://postgres:postgres@localhost:5432/agency_demo \
  OWNER_ID=00000000-0000-0000-0000-00000000b002 DASHBOARD_PASSWORD=mein-demo-passwort-123 PORT=3000 node src/serve.ts
```
`DATABASE_URL` anpassen, falls dein PostgreSQL andere Zugangsdaten hat (Homebrew: `postgres://DEIN_MAC_BENUTZER@localhost:5432/agency_demo`).
Browser: **http://127.0.0.1:3000** (Benutzername beliebig, Passwort = `DASHBOARD_PASSWORD`).

## Ausprobieren
1. **Suche starten:** auf der Startseite Ort, Radius, Branche(n) und SMALL/MEDIUM/LARGE wählen → „Leads suchen“. (Ist der Ortsname mehrdeutig, z. B. „Neunkirchen“, kommt eine Meldung: Bundesland ergänzen.)
2. **Lead auswählen:** `Leads` – kontaktierbare Leads stehen oben, „Daten beschaffen“ getrennt; Arbeitsbereiche auf der Startseite.
3. **Telefonansicht:** im Lead „Was soll ich am Telefon sagen?“ (Einstieg, Argumente, Ziel). Es wird nie automatisch gewählt.
4. **Telefonakquise freigeben:** `Heute anrufen` → „Einstellungen öffnen“ → Telefonakquise freigeben (bewusst, mit Bestätigung) → die Anrufliste füllt sich.
5. **Notiz/Status:** im Lead Status setzen, Notiz speichern (bleibt nach Reload).
6. **Demo-Empfehlung:** Ansicht „Demo empfohlen“ – mit Begründung.
7. **Demo bestätigen:** „Demo erstellen“ → Bestätigungsseite (Layout, Module; „Funktionen ändern“) → „Ja, Demo erstellen“.
8. **Demo öffnen:** „Demo ansehen“ (Desktop und Handy; immer „Unverbindliche Demo“).

## Optional: Web-Anreicherung (Brave)
Ohne Schlüssel zeigt das Dashboard „Web-Anreicherung nicht aktiviert“ – alles andere läuft. Später: im selben Terminal `export BRAVE_SEARCH_API_KEY=…` (nie ins Repository), Server neu starten; Echttest: `npm run enrich:check -- --ensure-run` (siehe CLAUDE.md).
