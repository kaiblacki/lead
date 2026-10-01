# Einrichtung

Drei Stufen – jede funktioniert für sich:

1. **Demo-Modus** (ohne Konten, ohne Schlüssel) – alles lokal ausprobieren
2. **Eigene Datenbank + Mock-Dienste** (Supabase) – echte Arbeitsumgebung, weiterhin nichts Echtes
3. **Live** – Schritt für Schritt echte Dienste einschalten, sobald die Schlüssel da sind

## 1. Demo-Modus (5 Minuten)

Node ≥ 22.18 und ein lokales PostgreSQL (`psql` im PATH; Verbindung über `PGHOST/PGUSER/PGPASSWORD`).

```
npm install
npm run demo:db                     # Datenbank „agency_os“ mit Supabase-Ersatzschema + allen Migrationen
export DATABASE_URL=postgres://<benutzer>:<passwort>@localhost:5432/agency_os   # falls nicht postgres:postgres
npm run demo                        # http://127.0.0.1:3000  ·  Passwort: demo-passwort-123
```
`npm run demo` erzwingt `APP_MODE=mock` und `CONFIG_DIR=config.mock`, legt beim ersten Start vier Beispielsuchen an und verwendet nie echte Dienste – auch wenn Schlüssel in der Umgebung stehen.
Tests: `npm run test:all` (Unit-Tests, danach lokale Test-Datenbank `dbtest` mit HTTP-, Ende-zu-Ende- und Browser-Tests; Chromium wird gefunden über `CHROMIUM_PATH` oder `/opt/pw-browsers`).

## 2. Eigene Datenbank (Supabase) mit Mock-Diensten

1. supabase.com → New project → Region **Central EU (Frankfurt)** → Datenbankpasswort speichern.
2. SQL Editor → nacheinander den Inhalt von `supabase/migrations/0001_core.sql` bis `0013_provider_cost_currency.sql` einfügen und jeweils **Run** (Reihenfolge einhalten).
3. Authentication → Users → **Add user**. Die **User UID** ist `OWNER_ID`.
4. Project Settings → Database → **Connection string** (URI) → `DATABASE_URL` (Passwort einsetzen).
5. `.env` anlegen (`cp .env.example .env`), mindestens setzen: `DATABASE_URL`, `OWNER_ID`, `DASHBOARD_PASSWORD` (≥ 12 Zeichen, zufällig). `APP_MODE=mock` lassen.
6. Start: `node --env-file=.env src/serve.ts` (oder `npm run serve` mit exportierten Variablen).
7. Eigene Preise und Agenturdaten: `config/agency.json` und **alle** `[Platzhalter]` in `config/pricing.json` ersetzen (rechtlich prüfen lassen). Zum Üben statt dessen `CONFIG_DIR=config.mock`.

Die DB-Verbindung umgeht Row Level Security (Server-Zugriff mit `owner_id`-Filter); `DATABASE_URL` niemals in Git oder ins Frontend. Supabase Free pausiert inaktive Projekte – für den Livebetrieb Pro-Plan und Backups aktivieren.

## 3. Live schalten – Dienst für Dienst

Unter **Einstellungen → Provider** steht je Dienst, ob Mock oder echt aktiv ist und warum. `APP_MODE=live` schaltet alles auf „echt, wo ein Schlüssel vorhanden ist“; einzelne Dienste lassen sich mit `PROVIDER_PLACES|AI|PAYMENTS|HOSTING|CRAWLER|RENDER=mock|real` festlegen. Fordert man „echt“ ohne Schlüssel an, bleibt der Mock aktiv und der Grund wird angezeigt – es wird nie stillschweigend gemischt.

| Dienst | Variablen | Zuerst prüfen |
|---|---|---|
| **OpenStreetMap (Suche ohne Schlüssel)** | `APP_MODE=live`, optional `OSM_CONTACT` | wird automatisch genutzt, wenn kein Google-Key gesetzt ist; kleine Suche mit 5 Leads, Daten sind lückenhafter als bei Google |
| Google Places (Suche) | `GOOGLE_PLACES_API_KEY` | `node src/cli.ts providers`, dann eine kleine Suche mit 5 Leads; Kosten im Budget-Limit „Places-Anfragen pro Lauf“ |
| **Websuche für die Anreicherung (Brave Search API)** | `BRAVE_SEARCH_API_KEY` (nur als Umgebungsvariable – nie in Chat, Repository oder Client-Code), `APP_MODE=live` | Preis 5 USD je 1.000 Anfragen; Budget 10 €/Monat und 2 €/Tag in `config/pipeline.json`. Zuerst **`npm run enrich:check -- --ensure-run`** (5 Leads, harte Anfragen-Obergrenze, Bericht VORHER → NACHHER, nichts wird gesendet oder erstellt), siehe unten |
| Crawler + Browser-Tiefenprüfung | `PROVIDER_CRAWLER=real`, Chromium (`CHROMIUM_PATH`) | wenige bekannte Websites per CSV-Import; Ergebnisse gegen die eigene Einschätzung lesen |
| KI (Gesprächseinstieg, Änderungswünsche) | `ANTHROPIC_API_KEY`, optional `ANTHROPIC_MODEL` | Ausgaben werden geprüft (nur belegte Gründe, keine Versprechen); Budget-Limits in den Einstellungen |
| Zahlungen (Stripe) | `STRIPE_SECRET_KEY` (`sk_test_…` zuerst), `STRIPE_WEBHOOK_SECRET` | Stripe CLI: `stripe listen --forward-to http://127.0.0.1:3000/webhooks/stripe`; Testkarte `4242 4242 4242 4242`; ganzen Weg bis „Wartung aktiv“ durchspielen. Ereignisse: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`, `customer.subscription.deleted`, `invoice.payment_failed` |
| Hosting der Kundenseiten | `VERCEL_TOKEN` (+ `VERCEL_TEAM_ID`) oder Ordner `HOSTING_DIR` | zuerst Ordner-Modus, dann Vercel mit einer Testseite |
| E-Mail (Benachrichtigungen an dich, Zahlungs-/Freigabe-Links an Kunden) | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Einstellungen → „E-Mail und Benachrichtigungen“: Adresse eintragen, **Test-E-Mail senden**; alles Gesendete steht im **Postausgang**. Zugangsdaten werden nur über verschlüsselte Verbindung gesendet |
| WhatsApp (nur mit Opt-in) | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` | Versand nur über die Kontaktregeln (Kanal aktiv, Einwilligung, Limit); Meta erlaubt Neukontakten nur Vorlagen |
| Verzeichnisse, Social-Daten | – | **noch nicht gebaut** (nur Mock), siehe docs/STATUS.md |

#### Brave-Schlüssel und der 5-Lead-Test
- **Lokal (Mac/Linux):** im Projektordner, im selben Terminalfenster: `export BRAVE_SEARCH_API_KEY='…'` und `test -n "$BRAVE_SEARCH_API_KEY" && echo "Brave-Key ist gesetzt"`. Danach `npm run enrich:check -- --ensure-run` (legt bei Bedarf eine lokale Datenbank `agency_live` an, wenn `DATABASE_URL` nicht gesetzt ist; fehlende Migrationen meldet das Skript, `--migrate` spielt sie lokal ein).
- **Claude-Code-Cloud-Sitzung:** ein `export` auf dem eigenen Rechner erreicht die Cloud-Umgebung nicht. Die Variable `BRAVE_SEARCH_API_KEY` in den Einstellungen der Cloud-Umgebung anlegen (Menü der Umgebung in der Titelleiste → Bearbeiten → „API credentials“ bzw. Umgebungsvariable) und eine **neue** Sitzung auf dem Branch starten. Die Datenbank der Cloud-Umgebung ist flüchtig: der Suchlauf wird mit `--ensure-run` kostenlos neu angelegt.
- Ohne Schlüssel: `npm run enrich:check -- --dry-run` zeigt Auswahl und Zustand VORHER, ohne Anfrage. Der Bericht (Markdown + JSON) liegt in `out/enrich-check/` (nicht im Git).
- Danach **stoppen**: die übrigen Leads werden erst nach ausdrücklicher Bestätigung angereichert (Dashboard „Daten“ → Enrichment starten oder `enrichBatch`).

Reihenfolge-Empfehlung: Places → Crawler → KI → Stripe (Test) → Hosting → erst dann Stripe live. Nach jedem Schritt Dashboard → Einstellungen → Provider prüfen.

## Betrieb mit Docker (öffentlich, mit HTTPS)

Stripe-Webhooks und Kundenlinks brauchen eine öffentliche HTTPS-Adresse. Das Dashboard ist ein dauerhafter Node-Server (nicht für Vercel-Serverless geeignet) – passend sind Hetzner, Fly.io, Railway, Render o. ä.

```
docker build -t agency-os .                    # mit Browser-Test der Kundenseiten: --build-arg WITH_CHROMIUM=1
docker run -d --env-file .env \
  -e PUBLIC_BASE_URL=https://deine-domain.de -e TRUST_PROXY=1 \
  -v agency-out:/app/out -p 3000:3000 agency-os
```
- Produktionsbefehl im Image: `node src/serve.ts` (läuft als Benutzer `node`). Beendet sich mit Fehlermeldung, wenn `DASHBOARD_PASSWORD` (≥ 12 Zeichen), `DATABASE_URL` oder `OWNER_ID` fehlen.
- Health-Check: `GET /healthz` (im Image eingebaut). Alle Variablen: `.env.example`.
- Davor einen Reverse-Proxy mit HTTPS (Caddy/nginx); `TRUST_PROXY=1` nur dahinter setzen.
- `MAINTENANCE_AUTORUN=1` führt fällige Wartungsprüfungen stündlich aus; sonst Knopf im Dashboard oder `node src/cli.ts maintenance` per Cron.
- Hinweis: Das Docker-Image wurde in der Entwicklungsumgebung **nicht gebaut oder gestartet** (kein Docker vorhanden); Dockerfile und Pfade sind statisch geprüft (`test/unit/security.test.ts`). Beim ersten Build Ausgabe prüfen.

## Vor dem ersten echten Kunden
- Rechnungen: `config/agency.json → invoice` vollständig ausfüllen (Name, Anschrift, USt-IdNr. oder Steuernummer, Steuersatz, ggf. Kleinunternehmer, Brutto/Netto) und vom Steuerberater prüfen lassen.
- Datenschutzerklärung und Impressum der eigenen Agentur; AGB/Vertragstext prüfen lassen, USt-Behandlung klären.
- Rechtsgrundlage für Telefon-Kaltakquise klären, bevor die Telefonakquise in den Einstellungen freigegeben wird (UWG § 7). E-Mail/WhatsApp nur mit dokumentierter Einwilligung.
- Wartungs-Abo: Kündigungsbedingungen im Angebot festlegen.
