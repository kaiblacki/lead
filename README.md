# AI Agency OS – Phase 1 (Core MVP)

Findet Unternehmen, die wahrscheinlich eine neue Website brauchen, prüft ihre Websites, bewertet sie nachvollziehbar und bereitet ein Verkaufsargument vor. **Es wird nichts automatisch gesendet.**

Plan und Architektur: `docs/ARCHITEKTUR.md`

## Nutzung (Node ≥ 22.18, keine Abhängigkeiten)

```
npm test                                   # Tests ohne Datenbank
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
Tests mit Datenbank: `npm run test:db` (legt lokale Test-DB `dbtest` an, 18 Tests).

## Phase 2/3: Demo und Angebot
- `node src/cli.ts demo examples/leads.csv --n 2` erzeugt eine Demo-Datei zur Ansicht (`out/demo.html`).
- Im Dashboard: pro Lead „Demo erstellen" (8 Branchen-Templates + Allgemein, automatische Auswahl) → geheimer Link `/d/<64 Zeichen>`, ohne Login abrufbar, `noindex`, 30 Tage gültig, widerrufbar, mit Abrufzähler. Die Demo ist deutlich als „Unverbindliche Demo / Beispiel" gekennzeichnet, nutzt nur Daten aus dem Lead, keine fremden Bilder und kein JavaScript.
- „Angebot erstellen" baut ein Angebot aus `config/pricing.json` (Leistungsumfang, Preis, Anzahlung, Rest, Wartung, Korrekturrunden). Ablauf: Entwurf → Freigabe → „als von mir versendet markieren" (nur aus Status INTERESTED). Es wird nichts automatisch versendet.
- CRM-Status lässt sich pro Lead Schritt für Schritt setzen (nur erlaubte Übergänge, mit Notiz).
- **Vor dem ersten Einsatz ausfüllen:** `config/agency.json` (Agenturname, Kontakt) und die `[Platzhalter]` in `config/pricing.json` (Lieferzeit, USt-Hinweis, Vertragsbedingungen, rechtlich prüfen lassen). Das Dashboard warnt, solange Platzhalter offen sind.

## Konfiguration
- `config/scoring.json` – Gewichte und Schwellen des Opportunity Scores
- `config/pricing.json` – Angebote, Preise, Anzahlung, Wartung
- `config/agency.json` – Absenderangaben der Demo
- Limits: `src/guardrails/budget.ts`

## Datenbank
`supabase/migrations/0001_core.sql` (RLS an, Events append-only). Test: `test/rls_test.sql` gegen lokale Postgres-DB.

## Bekannte Grenzen
- Das Dashboard ist eine schlanke Node-Seite (kein Next.js). Für Vercel-Hosting müsste es portiert werden; bis dahin lokal oder auf einem eigenen Server betreiben.
- Places-Suche nutzt den Radius noch nicht (Textsuche nach Branche + Region).
- Design/Mobile werden aus HTML-Indikatoren abgeleitet, noch ohne Rendering/Screenshots.

## Phase 3–5: Bestellung, Zahlung, Produktion, Freigabe, Veröffentlichung, Wartung
Ablauf im Dashboard (Lead-Detailseite, Karte „Bestellung"):
1. Angebot versendet → **Bestellung anlegen** → **Anzahlungs-Link erstellen** (Stripe Checkout). Den Link schickst du dem Kunden.
2. Stripe meldet die Zahlung per Webhook (`POST /webhooks/stripe`, Signatur Pflicht, Betrag und Währung werden gegengeprüft, Wiederholungen sind wirkungslos) → Status `IN_PRODUCTION`, Projekt wird aus den Lead-Daten angelegt.
3. **Projektdaten** ausfüllen (Kontakt, Öffnungszeiten, Texte, Impressum-Angaben) und bestätigen, dass die Rechtstexte rechtlich geprüft sind. **Produzieren + QA** baut die Seite und prüft sie (Pflichtangaben, Platzhalter, Links, tel/mailto, Impressum, Barrierefreiheits-Grundlagen, externe Ressourcen; dazu ein echter Browsertest bei 375/390/430/1280 px auf seitliches Scrollen, Tap-Ziele ≥ 40 px, JS-/Ladefehler). Behebbare Fehler werden automatisch korrigiert und neu geprüft (2 Runden). Nur bei bestandener QA geht es in die Kundenfreigabe.
4. Der Kunde bekommt einen privaten Link `/r/<Token>` mit Vorschau und den Knöpfen FREIGEBEN / ÄNDERUNG ANFORDERN. Änderungswünsche erscheinen im Dashboard; du pflegst sie in den Projektdaten ein und baust neu. **Die Änderungen führt kein KI-Agent aus, das machst du.** Nach der Freigabe geht der Kunde direkt zum Restzahlungs-Checkout.
5. Nach bestätigter Restzahlung (`FULLY_PAID`) → **Veröffentlichen** (oder automatisch mit `AUTO_DEPLOY=1`). Ohne `VERCEL_TOKEN` schreibt der Deployer in `out/sites/<name>/`.
6. Danach **Wartungs-Link (Abo)** und **Wartungscheck** (erreichbar, HTTPS, Impressum/Datenschutz vorhanden, Kontaktlinks).

Die Zahlungslogik ist im Code nicht zu umgehen: keine Produktion ohne Anzahlung, keine Veröffentlichung ohne Restzahlung, Wartung erst nach Veröffentlichung (siehe `src/orders/status.ts`).

**Nicht gegen die echten Dienste getestet:** `StripeProvider` und `VercelDeployer` sind mit gemockten HTTP-Antworten und selbst signierten Webhooks geprüft, aber noch nie gegen Stripe oder Vercel gelaufen. Erst mit Stripe-**Testschlüsseln** (`sk_test_…`) und der Stripe CLI (`stripe listen --forward-to …/webhooks/stripe`) durchspielen, dann erst live.
Wiederkehrende Abo-Rechnungen (Verlängerung, Zahlungsausfall, Kündigung) werden noch nicht verarbeitet, nur der Start des Abos.

## Phase 6: Social Media
Lead-Detailseite → „Content-Kalender öffnen". Die Engine erzeugt für 1–12 Wochen Entwürfe: 2 Feed-Posts pro Woche und Plattform (Instagram, Facebook, bei B2B-nahen Branchen LinkedIn), Stories, Reel-Ideen, monatlich eine Blog-Gliederung und ein Newsletter-Gerüst.
- **Branchenwechsel = anderes Profil** (`src/social/profiles.ts`: Zielgruppe, Ton, Themen, Hashtags, Plattformen). Die Engine (`src/social/generate.ts`) bleibt gleich. 8 Profile + Allgemein.
- **Keine erfundenen Fakten:** Leistungen, Öffnungszeiten und Angebote erscheinen nur, wenn du sie einträgst. Ohne Angabe werden stattdessen Fragen, Kontakt-Posts und Ideen für eigene Fotos/Videos verwendet.
- **Regulierte Branchen** (Zahnarzt, Versicherung): keine Ratschläge, an jedem Eintrag ein Hinweis auf Heilmittel-/Finanzwerberecht.
- Alle Einträge sind Entwürfe. Freigabe nur, wenn der Text gültig ist (Länge je Plattform, keine Platzhalter). Bearbeiten setzt auf Entwurf zurück. Export der freigegebenen als CSV. **Es wird nichts automatisch gepostet.**
- Die Texte sind Vorlagen, keine KI-Texte. Eine KI-Verfeinerung (mit denselben Regeln) ist möglich, aber noch nicht gebaut.

## Bewusst noch nicht gebaut
Automatischer Versand (E-Mail/Messenger) und Antwort-Klassifizierung (rechtlich riskant, UWG § 7), KI-Sales-Agent, KI-gestützte Umsetzung von Änderungswünschen, automatisches Posten in sozialen Netzwerken, Wartungsberichte per E-Mail, Verarbeitung von Abo-Verlängerungen/Kündigungen, Hosting des Dashboards auf Vercel. Begründung: `docs/ARCHITEKTUR.md`.
