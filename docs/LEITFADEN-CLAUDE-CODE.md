# Leitfaden für Claude Code – Agency Growth OS

Stand: Branch `claude/supabase-vercel-setup-17lr75`, 23 Migrationen, 178 Unit- und 153 DB-Tests grün. Dieses Dokument ist der Einstieg für jede neue Sitzung: **zuerst lesen, dann `CLAUDE.md`, `docs/STATUS.md`, `docs/TEAM.md`, `docs/PRODUKTION.md`, `SETUP.md`**.

## 1. Was das System ist
Ein Vertriebs-Betriebssystem für eine kleine Agentur (Besitzer: Kai). Pipeline: **OSM-Suche → Analyse/Scoring → Web-Anreicherung → Priorität A–D → Demo-Empfehlung → Kai bestätigt → Demo-Bau**, erweitert um Sales Copilot, Partner-Modell, Aufgaben, Preise/Angebote/Aufträge, Kunden/Wartung, Community, Analytics und ein **Mitarbeiter-Vertriebssystem** mit Admin-Kontrolle. Zero-Framework: Node ≥ 22 mit nativem TypeScript (nur Typ-Entfernung), `node:http`, Postgres via `pg`, keine Build-Stufe.

## 2. Unverrückbare Regeln (vom Nutzer, gelten immer)
1. **Nichts senden** (E-Mail, WhatsApp, Zahlungen, Kontakt). Auch nicht, weil irgendwo eine Adresse öffentlich steht.
2. **Nichts Relevantes pro Lead ohne Kais Bestätigung**: Demo erstellen, E-Mail, Follow-up, Kontaktaufnahme, Veröffentlichung, Domain, Vertrag, kostenpflichtige Funktionen außerhalb des Budgets (10 €/Monat, 2 €/Tag in `config/pipeline.json`).
3. **Nichts erfinden**: fehlt eine Angabe → „nicht verfügbar“; bei Unsicherheit UNCERTAIN/„manuell prüfen“.
4. **Schlüssel nur als Umgebungsvariablen** – nie ausgeben, loggen, committen, im Chat erfragen. `BRAVE_SEARCH_API_KEY` prüfen mit `test -n "$BRAVE_SEARCH_API_KEY" && echo gesetzt`.
5. **Drei Themen bleiben getrennt**: Website / Bedarfsanalyse (Versicherung) / Kooperation. Website-Rabatt, Partnerstatus und Community-Vorteile werden **nie** an Versicherungsverträge gekoppelt (technisch in `src/core/compliance.ts` + Textwächter).
6. **Bestehende Tests müssen grün bleiben**: `npx tsc -p . && npm test && bash test/run-db-tests.sh`. Keine Features ohne Auftrag, nichts neu bauen, nicht unnötig umstrukturieren.
7. **Push nur auf den im Auftrag genannten Branch**, keine Pull Request ohne Aufforderung. Commit-Nachrichten enden mit den Attributionszeilen aus der Sitzung.
8. Nach jeder größeren Phase testen; **nie Dateien ändern, während `run-db-tests.sh` läuft** (führt zu zufälligen „Datenbankfehler“-Fehlschlägen).
9. Nach dem Abarbeiten eines Auftrags **stoppen** und berichten; keine eigenmächtigen Zusatzfeatures. Berichte ehrlich (Fehlschläge, Auslassungen benennen).

## 3. Befehle
| Zweck | Befehl |
|---|---|
| Typecheck | `npx tsc -p .` |
| Unit-Tests | `npm test` |
| DB-Tests (alle) | `bash test/run-db-tests.sh` (legt Datenbank `dbtest` neu an, braucht lokales Postgres) |
| DB-Tests (einzelne) | `DB_TEST_FILES="test/db/team.test.ts" bash test/run-db-tests.sh` |
| Browser-Screenshots | `SHOTS_DIR=out/shots …` vor den E2E-Läufen |
| Demo lokal | `npm run demo:start | demo:status | demo:stop` (siehe `docs/DEMO-START.md`) |
| Anreicherungs-Echttest | `npm run enrich:check -- --ensure-run` (nur mit Brave-Key, höchstens 5 Leads) |
| Betrieb | `npm run ops -- backup | restore-check | migrate:plan | migrate:approve <Hash> | migrate:apply` |
Login lokal: beliebiger Benutzername + `DASHBOARD_PASSWORD` (Admin) – oder Mitarbeiter-Login mit eigenem Passwort.

## 4. Architektur (Wo liegt was)
- `src/context.ts` – verdrahtet alle Services (`ctx.leads, ctx.calls, ctx.team, ctx.quotes, ctx.offerFlow, ctx.orders, ctx.delivery, ctx.customers, ctx.community, ctx.growth, ctx.growthAnalytics, ctx.taskEngine, ctx.copilot, ctx.partners …`). **Reihenfolge der Konstruktion beachten** (z. B. `team` braucht `calls`, `taskEngine`, `growth`).
- `src/dashboard/server.ts` – HTTP-Server: Auth (Admin-Passwort oder Mitarbeiter-Login), Rollenprüfung (`pathAllowed`), CSRF (ein globales Token), Rate-Limits, Flash-Hinweise (`?f=`). Routen sind Arrays `Route[]` pro Seite und werden in `server.ts` registriert.
- `src/dashboard/pages/*.ts` – eine Datei je Bereich (`leads, work, team, offers, orders, customers, community, partners, tasks, today, analytics, overview, public …`). `render(r, {title, nav, body, crumbs?, back?})` aus `_page.ts`. HTML nur über `html\`…\`` (automatisches Escaping), Formulare über `postForm/postBtn`.
- `src/dashboard/nav.ts` + `ui.ts` – Navigationsgruppen je Rolle, Breadcrumb-Regeln (`RULES`), Layout, CSS. **Neue Seite = Route + Nav-Eintrag + Breadcrumb-Regel + Eintrag in /menu (automatisch aus Nav) + Test, dass sie 200 liefert.**
- CSP erlaubt **kein JavaScript** auf Dashboard-Seiten → Reiter/Abläufe sind serverseitig (`?tab=`, `?q=`), Tabs per `hidden` + CSS `:target`.
- `src/db/*` – Speicher-Klassen (Repo, LeadStore, AnalyticsStore, GrowthService, …). `src/*/service.ts` – Fachlogik je Bereich.
- `src/team/` – `rules.ts` (rein: Rollen, Zugriffsregeln, Ergebnisse, Metriken-SQL-Prädikate, Playbooks, Gesprächsablauf, Trainingsfälle), `auth.ts` (scrypt), `service.ts` (TeamService: Benutzer, Zuweisung, Sperren, Arbeitsplatz-Abfragen, Kontaktversuche, Übergaben, Kampagnen, Kennzahlen, Audit).
- `src/sales/copilot*.ts` – regelbasierter Verkaufsassistent (MASS, Hash-Cache), optional DEEP; `config/copilot.json`.
- `src/pricing`, `src/offers`, `src/orders`, `src/customers`, `src/community`, `src/partners`, `src/tasks`, `src/demo`, `src/site`, `src/enrich`, `src/search`, `src/scoring`, `src/ops`, `src/core` (config, compliance, status, text, time).
- `config/*.json` (+ `config.mock/` für Tests): `packages.json` (alle Preise, **INTERNAL_DRAFT_PRICE**), `growth.json` (Handlungspriorität), `copilot.json`, `pipeline.json`, `pricing.json`, `scoring.json`, `ai.json` …
- `supabase/migrations/NNNN_*.sql` – fortlaufend, wo sinnvoll idempotent. `scripts/` – Demo-Launcher, `ops.ts`, `enrich-check.sh`.
- `test/unit` (ohne DB) und `test/db` (mit Postgres; Helfer `test/db/helpers.ts`: `appSetup`, `seededApp(owner,{n,cfgDir,phone})`, `AUTH`).

## 5. Datenbank (Migrationen)
0001 Kern · 0002–0005 Analyse/Demos/Aufträge · 0006 Lead-Intelligence/Wartung · 0007–0010 E-Mail, OSM, Rechnungen, Analyse-Stufen · 0011 Pipeline (Priorität, Suchgrößen) · 0012 Anreicherung/DATA_NEEDED/Freigaben · 0013 Providerkosten (USD) · 0014 Sales Copilot · 0015 Partner/Referrals/Kontaktstrategie · 0016 Aufgaben · 0017 Demo-Stufen · 0018 Quotes/Angebote · 0019 manuelle Zahlungen · 0020 Growth-Scores/Handlungspriorität · 0021 Kunden/Änderungswünsche · 0022 Community · **0023 Team** (`staff_users`, `campaigns`, `contact_attempts`, `handoffs`, `team_audit`, `team_feedback`, Lead-Spalten `assigned_to_user_id…`, `contact_status`, `campaign_id`, `tasks.for_admin`).
Wichtig: `contact_attempts` (UPDATE verboten) und `team_audit` (UPDATE/DELETE verboten) sind per Trigger unveränderlich; Audit hat bewusst keinen FK auf Leads. **Neue Migration ⇒ auch `PROBES` in `scripts/demo/lib.ts` ergänzen**, sonst hält der Demo-Launcher sie für eingespielt.

## 6. Was gebaut ist (Funktionsstand)
**Kern:** Lead-Suche (OSM, Brave-Adapter), Analyse, Scoring, Priorität A–D, DATA_NEEDED, Anreicherung mit Budget und Verifikation (Namensvettern), Demo-System (Familien, Module, Stufen, Schnell-Demo nach Bestätigung), Kontaktregeln/Sperrliste, DSGVO-Export/Löschung, Mock-/Live-Provider.
**Growth OS (Phasen A–K):** Partner-Modell (7 Status, Referrals nur manuell mit Rechtsgrundlage), Kontaktstrategien, Aufgaben + Follow-up-Regeln, Preise zentral (Pakete, Add-ons, Wartung, Partnerrabatt 50 % nur auf Paketpreis, separat als `partner_discount`, Grund `ACTIVE_PARTNER`, manuelle Freigabe), Angebotsgenerator (Statuskette, Marktrichtwert nur intern), Auftragspipeline mit manueller Zahlungsbestätigung und Veröffentlichungsfreigabe, Scoring-Dimensionen + Handlungspriorität, Analytics-Ansichten, Kundenprofil + Wartungsübersicht + Änderungswünsche + Portal-Link (`/c/<token>`), Community (Opt-in Pflicht, 29 €/290 €, Partner frei, nur interne Verzeichnisvorschau), Lead-Reiter, Backup/Restore-Check/Migrationsplan mit Freigabe.
**Team-System:** Rollen ADMIN/TEAM_LEAD/SALES, Mitarbeiterprofile, Zuweisung (MANUAL/BATCH/ROUND_ROBIN; AUTO_RULE aus), Sperren (30 min), Arbeitsplatz `/work` (Mein Tag, nächster Lead, Gesprächsablauf, Playbooks A–E, Copilot-Texte, Notiz, E-Mail-Entwurf/„selbst versendet“, Übergabe an Kai, Aufgaben, Training mit erfundenen Firmen), Kontaktversuche zentral (auch aus dem alten Admin-Anruf-Ablauf über `calls.attemptSink`), Admin-Cockpit (`/team`, `/team/activity` mit Drilldown/Quoten/Aufschlüsselung, Profil, zugewiesene Leads, Kampagnen, Übergaben, Tagesziele, Audit), Navigation mit Gruppen, Breadcrumbs, Zurück-Links, `/menu`.

## 7. Wichtige Entwurfsentscheidungen (nicht versehentlich ändern)
- Staff-Ergebnisse laufen über `TeamService.recordResult` → bestehende `calls.applyResult` (Status, Aufgaben) mit `skipAttempt`; **„Demo gewünscht“/„Angebot gewünscht“ legen nur Aufgaben für Kai an** (`tasks.for_admin`), weil `applyResult('DEMO'|'OFFER'|'BOUGHT')` sonst automatisch Demo/Angebot/Bestellung erzeugen würde.
- Anruf nur bei `CALL_APPROVED` (Telefonakquise in den Einstellungen freigegeben **und** `contact_readiness = READY_FOR_MANUAL_CALL`); E-Mail „versendet“ nur mit dokumentierter Einwilligung (`CONSENT_EMAIL` in `contact_history`) + ausdrücklicher Bestätigung. Freigaben werden abgeleitet, nie automatisch erlaubt.
- Kennzahlen = Zählungen gespeicherter Kontaktversuche (`METRICS` in `src/team/rules.ts`, feste SQL-Prädikate, nie Nutzereingaben). Keine Rangliste, immer mit Branche/Region/Priorität/Playbook aufschlüsselbar.
- Rechte werden **im Server** geprüft (`pathAllowed`), SALES hat nur `/work*`; lead-spezifisch zusätzlich `TeamService.mayWork`.
- Alle Preise stehen in `config/packages.json`; niemals Preise im Code; Marktrichtwert nie im Kundenangebot.

## 8. Fallstricke aus der Entwicklung (Tests!)
- **Test-Uhr ist fest** (`NOW` in `test/db/helpers.ts`): in Tests `app.ctx.now()` statt `Date.now()` oder DB-`now()` verwenden (Sperren, Rückrufe, Zeiträume).
- Alle DB-Tests teilen eine Datenbank, jeder Test hat einen eigenen Owner: **Abfragen immer mit `owner_id` filtern** (z. B. `outbox`, `leads`), sonst wacklige Zahlen im Gesamtlauf.
- `seededApp` erzeugt standardmäßig 12 Leads (davon nur ~3 zum Anruf bereit); für mehr: `n: 40`/`60`. Contactability der Synthetik-Leads ist `PHONE_ONLY`.
- Hartkodierte Migrationsanzahlen vermeiden (Demo-Launcher-Test rechnet dynamisch).
- Navigation-/Pipeline-Tests prüfen Reiter-/Gruppenstruktur; bei Layout-Änderungen gezielt anpassen, nicht abschwächen.
- Playwright-Chromium ist vorinstalliert (`/opt/pw-browsers`); nicht `playwright install` ausführen. Browser-E2E: `test/db/e2e-browser.test.ts` (Growth OS), `test/db/e2e-team.test.ts` (Team, 390 px), `test/db/mobile.test.ts` (alle Seiten, Tap-Ziele ≥ 44 px, kein seitliches Scrollen).
- Native TS: keine `enum`, `import type` für Typen, Endung `.ts` in Imports.
- Der Hostname-/Origin-Check und das globale CSRF-Token gelten für alle Rollen; neue POST-Formulare brauchen `postForm`/`postBtn`.

## 9. Noch offen / nächste Schritte (nur nach Auftrag umsetzen)
**Vom Nutzer zu entscheiden / extern**
- Finale **Preise** freigeben (`config/packages.json`, Status `INTERNAL_DRAFT_PRICE`); Partnerbedingungen, Angebots-, Vertrags-, Datenschutztexte rechtlich prüfen; Playbook-/Trainingstexte (v. a. Bedarfsanalyse) inhaltlich freigeben; Rechtsgrundlage für Mitarbeiterzugriff, Notizen, Telefon/E-Mail klären.
- **Brave-Echttest** (CLAUDE.md-Abschnitt): braucht `BRAVE_SEARCH_API_KEY` in der Umgebung; höchstens 5 Leads, Bericht vollständig zeigen, danach stoppen; Entscheidung ≥ 3 von 5 brauchbar → Empfehlung für die übrigen Leads (Start erst nach Kais Bestätigung).
- Echte **Zahlungsanbindung** und **Domain-/Hosting-Anbindung** (heute: manuelle Bestätigung, Mock-Hosting); Git-Tag `agency-lead-os-demo-v1` noch nicht gepusht.
**Technische Verbesserungen (Vorschläge, kein Auftrag)**
1. Echte Sitzungen statt HTTP-Basic-Auth (Login-Seite, Cookie, „Passwort vergessen“, optional 2FA, Sperre nach Fehlversuchen je Konto).
2. `ctx.growth.refresh()` berechnet bei jeder Heute-/Sortier-Ansicht **alle** Leads neu → bei großen Beständen inkrementell oder per Job.
3. Paginierung/Limits für Team-Listen (`/team/:id/leads` begrenzt auf 500), Export (CSV) der Mitarbeiter-Aktivität.
4. Benachrichtigungen für Kai bei Übergaben/fälligen Rückrufen (nur intern, nichts an Kunden).
5. Team: Rückruf-/Termin-Erinnerungen im Mein-Tag, Zeiterfassung pro Anruf (`started_at/ended_at` sind vorbereitet), Kampagnen pausieren/abschließen, Leads zwischen Mitarbeitern umverteilen (Massenaktion), konfigurierbare AUTO_RULE (bewusst deaktiviert).
6. Übergabe-Workflow für Kai: aus einer Übergabe direkt „Demo vorbereiten“/„Angebot erstellen“ starten (weiterhin nur nach seiner Bestätigung).
7. Community: eigene öffentliche Verzeichnisseite als separater, von Kai bestätigter Veröffentlichungsschritt; Kundenportal erweitern (Dokumente, Rechnungen – nur nach Entscheidung).
8. CI (GitHub Actions) mit Postgres-Service für `tsc`, Unit- und DB-Tests; Backup-Zeitplan automatisieren (nur auf Kais Wunsch).
9. Datenschutz: Aufbewahrungs-/Löschkonzept für Kontaktversuche und Mitarbeiterdaten (Retention-Job existiert für Leads, nicht für Team-Daten).
10. Barrierefreiheit-Feinschliff und Screenreader-Test der Reiter/Breadcrumbs.

## 10. Arbeitsweise für neue Sitzungen
1. `git status`, `git log --oneline | head`, Branch prüfen; Auftrag lesen; bei Mehrdeutigkeit Standard wählen und nennen, nur bei echter Nutzerentscheidung nachfragen.
2. Aufgabenliste anlegen (TaskCreate), Phase für Phase: Migration → Service → Seite → Test → Gesamtlauf.
3. Nach jeder Phase: `npx tsc -p . && npm test`, dann DB-Tests (einzelne Dateien, am Ende alle). Fehler sofort beheben, nie Tests abschwächen oder überspringen.
4. Commit mit Attribution, `git push -u origin <Branch>`; Abschlussbericht ehrlich (Einschränkungen, manuell zu Entscheidendes), dann stoppen.
5. Doku aktuell halten (`docs/STATUS.md`, dieses Dokument bei Strukturänderungen).
