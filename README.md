# AI Agency OS

Findet in einer Region Unternehmen, die wahrscheinlich eine (neue) Website brauchen, analysiert sie nachvollziehbar, sortiert sie nach Verkaufschance, bereitet Anrufe vor und begleitet den gesamten Weg bis zur laufenden Wartung:

```
Suche → Analyse → Qualifizierung → Anrufliste → Gespräch → Demo → Angebot → Anzahlung
      → Produktion → QA → Kundenfreigabe → Restzahlung → Veröffentlichung → Wartung
```

**Es wird nichts automatisch gesendet, angerufen, bezahlt oder veröffentlicht.** Ein Mensch gibt frei; ein Kill-Switch stoppt alles. Erster Produktbereich: Websites. Weitere Produkte (Social Media u. a.) hängen an derselben Pipeline.

- Was fertig ist, was nur mit Schlüsseln testbar ist und was fehlt: **[docs/STATUS.md](docs/STATUS.md)**
- Einrichtung (lokal, Supabase, Docker, Live-Schlüssel): **[SETUP.md](SETUP.md)**
- Ursprünglicher Architekturentwurf und rechtliche Risiken: [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md)

## In zwei Minuten ausprobieren (ohne Konten, ohne Schlüssel)

Voraussetzungen: Node ≥ 22.18 und ein lokales PostgreSQL.

```
npm install
npm run demo:db      # legt die lokale Demo-Datenbank an (einmalig)
npm run demo         # startet alles im Mock-Modus und füllt Beispieldaten
```

Dann http://127.0.0.1:3000 öffnen (Benutzername beliebig, Passwort `demo-passwort-123`). Alle Dienste sind Mocks: Unternehmen sind frei erfunden (`.example`-Domains, ungültige Telefonnummern), Zahlungen werden simuliert, „Veröffentlichen“ schreibt in einen lokalen Ordner.
Die Telefonakquise ist bewusst gesperrt – unter **Einstellungen → Telefonakquise** nach Bestätigung der rechtlichen Grundlage freigeben, dann füllt sich **Calls**.

### Der komplette Weg im Dashboard
1. **Suche**: Beispielsuche antippen (z. B. „Völklingen + 30 km + Nagelstudios + Website fehlt oder verbesserungswürdig“) oder Detailsuche/CSV-Import.
2. **Start / Leads**: die besten Chancen mit Begründung, 11 Dimensionen, Digital-Need- und Sales-Opportunity-Score; Detailseite mit Firmenprofil (Quelle, Datum, Qualität je Angabe), Website-Audit (✅⚠️❌), Verkaufsgründen, Gesprächseinstieg, Einwänden, Kontaktstrategie.
3. **Calls** („Meine heutigen Calls“): Anrufen (manuell), Ergebnis antippen – *Nicht erreicht / Kein Interesse / Rückruf / Interessiert / Demo / Angebot / Gekauft / Nicht mehr kontaktieren* – der Lead wandert automatisch durch die Pipeline.
4. **Demo** (privater Link `/d/<Token>`), **Angebot** (aus `config/pricing.json`), **Annehmen → Auftrag**.
5. **Aufträge**: Anzahlungs-Link → *Bezahlt (Simulation)* → Projektdaten → **Produzieren + QA** (inkl. echtem Browsertest) → Kunden-Link `/r/<Token>` (FREIGEBEN / ÄNDERUNG ANFORDERN) → Restzahlung → **Veröffentlichen** → Wartungs-Abo.
6. **Wartung**: Prüfungen, Aufgaben, Ausfall-/Abo-Probleme simulieren. **Analytics**: Umsatz, wiederkehrend, Trichter mit Konversionsraten, Learning-Loop-Export.

## Befehle

| Befehl | Zweck |
|---|---|
| `npm run demo:db` / `npm run demo` | Demo-Datenbank anlegen / Demo starten (Mock-Modus, `config.mock/`) |
| `npm run serve` | Dashboard mit eigener Konfiguration (`.env`, siehe SETUP.md) |
| `npm test` | Unit-Tests (keine Datenbank nötig) |
| `npm run test:db` | Datenbank-, HTTP-, End-to-End- und Browser-Tests (legt lokale Test-DB `dbtest` an) |
| `npm run acceptance` | Kern-Abnahmetest mit echten OpenStreetMap-Daten (Live-Modus, sendet nichts): „Völklingen + 30 km + Nagelstudios“, Bericht mit Kennzahlen |
| `npm run test:all` | Typprüfung + alle Tests |
| `node src/cli.ts providers` | zeigt je Dienst Mock oder echt |
| `node src/cli.ts search "<Suchsatz>"` · `import <csv>` · `seed` · `maintenance` · `retention [--execute]` | Kommandozeile |

## Aufbau

```
src/providers/     Schnittstellen + Mock- und echte Adapter (Places, Verzeichnis, Crawler, Render, Social, KI, Zahlung, E-Mail, WhatsApp, Hosting)
src/fixtures/      deterministische Testwelt (erfundene Firmen, 10 Website-Varianten)
src/audit/         Website-Audit mit belegten Befunden (pass/warn/fail/unknown)
src/scoring/       11 Dimensionen → Digital Need → Sales Opportunity (erklärbar, „nicht verfügbar“ statt Raten)
src/search/ calls/ contact/ sales/ offers/ orders/ maintenance/ social/ retention/ guardrails/   Fachlogik
src/site/ + templates/   Template-Engine (11 Branchenvorlagen als Datendateien), src/qa/ statische + Browser-QA
src/dashboard/     Server, Seiten, Sicherheit (Login, CSRF, Rate-Limits, CSP), kein JavaScript im Browser nötig
supabase/migrations/   Datenbankschema (RLS überall)      config/  Preise, Scoring, Agentur, Branchen      config.mock/  ausgefüllte Testwerte
```

## Sicherheit und Recht in Kürze
- Passwortschutz (Pflicht, ≥ 12 Zeichen), CSRF-Token, Login-Sperre, Rate-Limits, strenge CSP, Kundenlinks nur per geheimem Token (`noindex`).
- **Telefonakquise ist standardmäßig gesperrt** und braucht eine ausdrückliche Bestätigung (UWG § 7). E-Mail/WhatsApp-Versand braucht: Kanal aktiv + Plattformregeln bestätigt + dokumentierte Einwilligung je Lead + keine Sperrliste + Tageslimit. Sonst: „Manuelle Kontaktaufnahme erforderlich.“ Es gibt noch keinen echten E-Mail-/WhatsApp-Adapter.
- Sperrliste (Opt-out), Kontakt-Historie, Quellenangabe je Datum, Audit-Log (nur anfügbar) mit CSV-Export, Datenaufbewahrung mit Löschplan (Kunden- und Sperrdaten bleiben), Kill-Switch, Budget-Limits (Leads, Analysen, KI-Kosten pro Tag/Monat, Places-Anfragen, Crawler-Seiten).
- Keine Zugangsdaten im Code: nur Umgebungsvariablen (`.env.example`); ein Test scannt das Repository nach Schlüsseln.
- **Vor dem ersten echten Kunden:** `config/agency.json` und die `[Platzhalter]` in `config/pricing.json` ausfüllen (Lieferzeit, USt-Hinweis, Bedingungen – rechtlich prüfen lassen). Das Dashboard verhindert Freigabe und Versand von Angeboten, solange Platzhalter offen sind. Impressum/Datenschutz der Kundenseiten müssen vom Kunden/Anwalt bestätigt werden (Pflichthäkchen vor der QA).
