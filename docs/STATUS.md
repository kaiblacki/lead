# Projektstatus – AI Agency OS

Stand: Ende der Mock-Ausbaustufe. Zahlen stammen aus dem letzten vollständigen Testlauf (`npm run test:all`).

## Gesamtbild

| Kennzahl | Wert |
|---|---|
| **Lokaler MVP mit Mock-Diensten** (alles aus dem Auftrag, ohne externe Konten) | **≈ 95 %** gebaut und automatisch getestet |
| **Bereit für den Betrieb mit echten Diensten** | **≈ 60 %** – 9 von 10 echten Adaptern sind gebaut, **aber noch kein einziger gegen den echten Dienst gelaufen**; 1 Adapter fehlt (Social-Daten; Verzeichnis nur über OSM); Rechtstexte/Preise fehlen |
| Automatische Tests | **188** (108 Unit + 80 Datenbank/HTTP/Ende-zu-Ende/Browser), alle grün; Typprüfung `tsc --strict` sauber |
| Code | ca. 6.300 Zeilen Anwendung, ca. 2.700 Zeilen Tests, 7 Migrationen, 11 Branchenvorlagen |

Begründung der Prozentzahlen: Der lokale Umfang ist vollständig; die restlichen ~5 % sind bekannte Lücken ohne Schlüsselbedarf (siehe „Noch nicht gebaut“, z. B. Mehrbenutzer-Verwaltung, Benachrichtigungen). „Bereit für echten Betrieb“ wird vor allem dadurch begrenzt, dass die echten Adapter nur mit nachgestellten HTTP-Antworten getestet sind und die rechtlichen Angaben (Preise, AGB, Impressum) bewusst leer sind.

## Kern-Abnahmetest „Völklingen + 30 km + Nagelstudios“ (Stand)
- **Vorbereitet und offline getestet:** echter OSM-Provider gegen nachgestellte OSM-Antworten → Zusammenführen → Website vorhanden/fehlt → Analyse → Digital Need → Sales Opportunity → sortierte Anrufliste („Heute anrufen“); Lücken bleiben als Leads mit `DATA ENRICHMENT NEEDED` erhalten, fehlende Angaben stehen als „nicht verfügbar“, OSM-Attribution im Dashboard (`test/db/osm-acceptance.test.ts`).
- **Live-Lauf gegen die echten OSM-Server: erfolgt** (Nominatim + Overpass, ohne Schlüssel, nichts gesendet). Ergebnis „Völklingen + 30 km + Nagelstudios“: 201 Unternehmen, davon 74 laut OSM-Kategorie/Name eindeutig Nagelstudios; 39 mit Website, 161 ohne (OSM hat oft keinen Website-Eintrag → Anreicherung nötig); 78 mit Telefon; 187 mit Datenlücken; 15 Websites analysiert, 24 Websites lieferten dem Crawler HTTP 403/503 (Bot-Schutz) und stehen auf „Erneut prüfen“; 176 Scores, 46 TOP-Leads. Hinweis: 201 entspricht der Obergrenze des Laufs – es kann mehr geben.
- Anthropic und Google Places sind noch nicht angeschlossen (Reihenfolge laut Plan: erst OSM live, dann Anthropic, dann Google Places als Anreicherung).

## BEREITS VOLLSTÄNDIG (lokal gebaut, automatisch getestet, ohne Schlüssel lauffähig)

| # | Baustein | Was es kann | Geprüft durch |
|---|---|---|---|
| 1 | **Lead-Intelligence-Suche** | Ort, Radius, Branche/Unterbranche, Website-Status, mobile Probleme, Terminbuchung, Social, Größe, Bewertung, Telefon/E-Mail nötig, Mindest-Scores, Kontaktstatus, Sortierung; Schnellsuche („Völklingen + 30 km + Nagelstudios ohne Website“, auch freie Formulierungen) mit Beispielen zum Antippen; Vorfilter sparen Analysen; CSV-Import | Unit + DB + Browser |
| 2 | **Provider-Architektur** | 10 Schnittstellen (Places, Verzeichnis, Crawler, Render, Social, KI, Zahlung, E-Mail, WhatsApp, Hosting), je ein Mock; Umschalten per `APP_MODE`/`PROVIDER_*`; „echt ohne Schlüssel“ bleibt sichtbar Mock | Unit |
| 3 | **Analyse in 11 Dimensionen** → Digital Need + Sales Opportunity | erklärbar (Beitrag je Dimension), Zustände gemessen/abgeleitet/„nicht verfügbar“/„nicht zuverlässig ermittelbar“, Datenqualitätsfaktor, Gewichte in den Einstellungen änderbar (Konfigurations-Hash im Snapshot) | Unit + DB |
| 4 | **Firmenprofil** | jede Angabe mit Quelle, Datum, Qualität; Konflikte zwischen Quellen sichtbar; nichts erfunden | Unit + DB |
| 5 | **Website-Audit** | ✅⚠️❌ mit Beleg: HTTPS, Ladezeit, Mobile, Impressum/Datenschutz, Kontakt, Buchung, CTA, Technik; Single-Page-Seiten → „nicht prüfbar“ statt Raten | Unit + DB |
| 6 | **Sales-Opportunity-Liste + Verkaufs-Brief** | Priorität A–D, Verkaufsgründe mit Beleg, empfohlene Leistung, Auftragswert nur als Schätzung der Preisliste, Gesprächseinstieg (freigabepflichtig), Einwände, nächste Aktion; KI-Ausgabe wird auf erlaubte Gründe/Versprechen geprüft | Unit + DB |
| 7 | **Kontaktstrategie** | Bereitschaftsstatus mit Begründung (Bereit für Anruf, E-Mail-Einwilligung nötig, WhatsApp-Opt-in, manuell prüfen, gesperrt); **keine echten Nachrichten** | Unit + DB |
| 8 | **Call-Center „Meine heutigen Calls“** | Tagesziel, Rückrufe zuerst, 8 Ergebnis-Schaltflächen bewegen den Lead automatisch durch die Pipeline, Notizen, Sperrliste per Klick, Mobil-Bedienung | DB + Browser |
| 9 | **Demo-Generator** | individuelle Demo je Lead, privater Link, 30 Tage, widerrufbar, `noindex`, nur belegte Daten | DB + E2E |
| 10 | **Angebot** | aus `config/pricing.json`; mit offenen Platzhaltern nur Entwurf – Freigabe/„Gekauft“ wird blockiert | DB + E2E |
| 11 | **Produktions-Workflow** | Status sichtbar: Anzahlung offen → bezahlt → Produktion → QA → Kundenfreigabe → freigegeben → Restzahlung → veröffentlicht → Wartung; nicht umgehbar | Unit + E2E |
| 12 | **Mock-Stripe** | Checkout-Seite, signierte Webhook-Ereignisse durch denselben Code wie echtes Stripe, Anzahlung/Restzahlung/Abo simulierbar, Wiederholungen wirkungslos | Unit + DB + Browser |
| 13 | **Template-Engine** | 11 Branchenvorlagen als Datendateien (Friseur, Nagelstudio, Kosmetik, Zahnarzt, Handwerker, Restaurant, Immobilien, Autowerkstatt, Fitness, Versicherung, Allgemein), mobil-first, ohne JavaScript | Unit + Browser-QA |
| 14 | **QA-Agent** | statische Prüfung (Platzhalter, Pflichtangaben, Links, Impressum, Barrierefreiheit) mit automatischer Korrektur + **echter Browsertest** bei 375/390/430/1280 px | Unit + E2E |
| 15 | **Kundenfreigabe** | privater Link mit Vorschau; Freigeben → Restzahlung; Änderungswunsch → Produktion zurückgesetzt → (Mock-)KI setzt um oder „manuell nötig“ → QA → neue Vorschau | E2E + Browser |
| 16 | **Veröffentlichung** | erst nach vollständiger Zahlung und nur freigegebener Stand; Mock-Hosting unter `/hosted/<name>/` | E2E |
| 17 | **Wartung** | Kunde, Website, Monatspreis, Status, letzte/nächste Prüfung, Fehler, offene Aufgaben, Monatsbericht; Ausfall- und Abo-Probleme simulierbar; Plan pausieren/kündigen | DB + E2E |
| 18 | **Analytics** | Umsatz, wiederkehrend (MRR/ARR), Ø Auftragswert, Trichter mit Konversionsraten (monoton, nie > 100 %), Zeiträume | DB |
| 19 | **Learning-Loop-Datenstruktur** | Snapshot je Bewertung + Ergebnisse (Anruf, Stufen, gewonnen/verloren), Export CSV/JSON ohne Firmen-/Kontaktdaten, Score-Bänder vs. Ergebnis. *Bewusst kein Machine Learning.* | DB + E2E |
| 20 | **Social-Media-Engine (Entwurfsebene)** | Content-Kalender je Branchenprofil (10 Branchenprofile + Allgemein), nur belegte Fakten, unzulässige Werbeversprechen blockiert, Freigabe-Workflow, CSV-Export. Nichts wird veröffentlicht | Unit + DB |
| 21 | **Sicherheit/Compliance** | Audit-Log (nur anfügbar, CSV), Opt-out/Sperrliste, Kontakt-Historie, Quellenangaben, Datenaufbewahrung mit Löschplan, Kill-Switch, Rate-Limits, Login-Sperre, CSRF, CSP, Budget-Limits (Leads, Analysen, KI-Kosten, Places, Crawler), Mandantentrennung (RLS + `owner_id`), keine Geheimnisse im Code (Scan-Test) | Unit + DB + Browser |
| 22 | **Mobile Dashboard** | alle 26 Seiten (21 Dashboard-Ansichten + 5 Kundenseiten) bei 375/390/430 px im echten Browser: kein seitliches Scrollen, Tap-Ziele ≥ 44 px, keine Fehler; Touch-Klickstrecken für Suche, Calls, Kundenfreigabe, Mock-Zahlung | Browser-Tests |
| 24 | **E-Mail** | SMTP-Adapter (STARTTLS/TLS, Schutz gegen Header-Einschleusung), Postausgang-Seite (auch im Mock sichtbar, als „nur aufgezeichnet“ gekennzeichnet), Test-Mail, Betreiber-Benachrichtigungen (Zahlung, Freigabe, Änderungswunsch, Wartungsproblem), Kunden-Mails aus dem Auftrag per Knopfdruck (Zahlungs-/Freigabe-Link, „online“), Sperrliste wird beachtet. Tagesübersicht (ab 7 Uhr, einmal täglich, auch per Knopf/CLI). Kein automatischer Versand an Interessenten | Unit (Fake-SMTP-Server) + DB |
| 25 | **Rechnungen** | fortlaufende Nummer (RE-Jahr-0001), Netto-/Brutto-/Kleinunternehmer-Berechnung, nur für bezahlte Zahlungen, unveränderlicher Schnappschuss, druckbar/als PDF speichern; blockiert, solange Agenturdaten (`config/agency.json → invoice`) Platzhalter sind. **Steuerlich prüfen lassen** | Unit + DB |
| 26 | **DSGVO-Werkzeuge** | je Lead Auskunft (JSON mit allen Daten) und Löschung inkl. Sperrliste; Kunden mit Auftrag geschützt (Aufbewahrungspflichten) | DB |
| 23 | **Demo-Start** | `npm run demo:db` + `npm run demo`: komplettes System mit Beispieldaten ohne Konten | von Hand geprüft |

## NUR MIT API-KEY / ECHTEM DIENST TESTBAR (Code vorhanden, aber nie gegen den echten Dienst gelaufen)

| Adapter | Braucht | Stand |
|---|---|---|
| Google Places (Suche, Details) | `GOOGLE_PLACES_API_KEY` | gebaut, gegen nachgestellte Antworten getestet; Radius, Feldmaske, Anfragenzähler vorhanden |
| HTTP-Crawler (robots.txt, SSRF-Schutz) | Netzwerk + echte Websites | gebaut; Verhalten auf echten, „schmutzigen“ Websites ungeprüft |
| Playwright-Render / Tiefenprüfung | Chromium + echte Websites | gebaut; der gleiche Browser läuft bereits in der QA eigener Seiten |
| Anthropic (Gesprächseinstieg, Änderungswünsche) | `ANTHROPIC_API_KEY` | gebaut mit gleichen Prüfregeln wie der Mock; Antwortqualität und Kosten ungeprüft |
| Stripe (Checkout, Webhooks, Abo) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, Stripe CLI | gebaut, mit signierten Testereignissen geprüft; Abo-Verlängerung/Zahlungsausfall/Kündigung werden verarbeitet, aber nur simuliert getestet |
| Brave Search API (Websuche für die Anreicherung) | `BRAVE_SEARCH_API_KEY` | Adapter gebaut und gegen nachgestellte Antworten **und gegen die echte Fehlerantwort der API** (ungültiger Schlüssel → HTTP 422 `SUBSCRIPTION_TOKEN_INVALID`) getestet; **eine erfolgreiche Suche mit gültigem Schlüssel hat es noch nie gegeben** – erster echter Lauf: `npm run enrich:check -- --ensure-run` (5 Leads) |
| OpenStreetMap-Quelle (Nominatim/Overpass, **ohne Schlüssel**, wird bei `APP_MODE=live` ohne Google-Key genutzt) | Internet | gebaut, mit nachgestellten Antworten getestet; echte Server nie abgefragt. Telefon/Website fehlen in OSM oft (→ „nicht verfügbar“) |
| WhatsApp Business Cloud API | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` | gebaut, mit nachgestellten Antworten getestet; Meta erlaubt Neukontakten nur freigegebene Vorlagen, Freitext-Versand ist dort nicht möglich; Versand nur über die Kontaktregeln |
| SMTP-E-Mail | SMTP-Zugangsdaten | gebaut, gegen einen lokalen Fake-SMTP-Server getestet (inkl. Anmeldung, Fehler); nie gegen einen echten Mail-Anbieter |
| Vercel-/Ordner-Hosting | `VERCEL_TOKEN` | Ordner-Variante lokal geprüft; Vercel nicht |
| Docker-Image | Docker | Dockerfile, Healthcheck, Produktionsbefehl, Variablen dokumentiert und statisch geprüft; **nie gebaut oder gestartet** |
| Echter iPhone-Safari-Test | Gerät | Mobil-Tests liefen in Chromium (Geräteprofil), nicht auf einem iPhone |

## NOCH NICHT GEBAUT

| Was | Warum / Hinweis |
|---|---|
| Echte Adapter für **Verzeichnisse** (z. B. Gelbe Seiten) und **Social-Daten** (Instagram/Facebook) | Schnittstelle + Mock stehen; Nutzungsbedingungen der Quellen (kein Scraping gegen deren Regeln) müssen vorab geklärt sein; Instagram/Facebook brauchen Meta-Zugriff |
| Automatisches Posten in sozialen Netzwerken | Engine erzeugt nur Entwürfe |
| Antwort-Klassifizierung, KI-Sales-Agent, Chat | bewusst später |
| Lernen aus den Daten (Gewichte automatisch anpassen) | Datenstruktur und Export sind da; Auswertung/Anpassung erst mit echten Ergebnissen sinnvoll |
| Mehrbenutzer, Rollen, Passwort-Zurücksetzen | aktuell ein Betreiber (Basic-Auth + `owner_id`) |
| Push-Benachrichtigungen aufs Handy, Erinnerung bei Rückrufen | E-Mail-Benachrichtigungen für Zahlungen/Freigaben/Wartung sind da; Rückrufe stehen in „Calls“ |
| Rechnungs-/Steuerdokumente, Vertragstexte | Angaben in `config/pricing.json` und `config/agency.json` sind bewusst Platzhalter und rechtlich zu prüfen |
| Monatsbericht per E-Mail an den Kunden | Bericht im Dashboard vorhanden |

## Durch die neuen Tests gefundene und behobene Fehler
1. **Formulare im echten Browser abgelehnt:** wegen `Referrer-Policy: no-referrer` sendet der Browser `Origin: null`; die Herkunftsprüfung wies *jedes* Formular ab (auch „Freigeben“ des Kunden). Jetzt `same-origin` + toleranter Prüfung (CSRF-Token bleibt die Hauptsicherung).
2. **Bestätigungen gingen verloren** bei Weiterleitungen mit Anker (`#dokumente`) – Hinweis-ID stand hinter dem `#`.
3. **QA schlug bei Firmennamen mit `&`, `'`, `"` dauerhaft fehl** (Impressum-Prüfung verglich unübersetzten HTML-Text).
4. **Schnellsuche verstand „Nagelstudios ohne Website“ und „Website verbesserungswürdig“ nicht** (Filter und Branche im selben Teil).
5. **Trichter konnte über 100 % Konversion zeigen** (z. B. Demos → Angebote 300 %); jetzt echter Trichter.
6. Social-Texte mit Heil-/Garantieversprechen ließen sich freigeben; serverseitige Prüfung ergänzt.
7. Kleinigkeiten: Sicherheits-Header bei `/healthz` und 405, Status 413 bei zu großen Formularen, deutsche Statusnamen statt Rohwerten, Tabellenumbrüche auf dem Handy.

## Bekannte Grenzen
- Die Mock-Welt ist deterministisch und klein (erfundene Firmen rund um Saarbrücken); sie beweist die Abläufe, nicht die Trefferqualität im echten Markt.
- Scoring-Gewichte sind begründete Startwerte; Kalibrierung braucht echte Anruf-Ergebnisse (Learning-Loop-Export).
- Die Datenbank-Verbindung nutzt den Server-Zugang (umgeht RLS) – Mandantentrennung erfolgt über `owner_id` im Code und ist durch Tests abgesichert; RLS schützt zusätzlich bei direktem Client-Zugriff.
- Der Mock-Crawler/-Render liefert geschätzte Messwerte (als „geschätzt“ markiert).

## Empfohlene nächste Schritte (sobald Schlüssel vorliegen)
1. `config/agency.json` + `config/pricing.json` ausfüllen und rechtlich prüfen.
2. Places-Key → 5-Lead-Testsuche; Crawler real an bekannten Websites gegenprüfen.
3. Anthropic-Key → Gesprächseinstiege gegenlesen; Kosten im Budget beobachten.
4. Stripe-Testmodus → kompletten Weg bis „Wartung aktiv“ einmal real durchspielen; Abo-Ereignisse prüfen.
5. Hosting (Ordner → Vercel), Docker-Build auf dem Zielserver.
6. Telefonakquise erst nach Klärung der Rechtsgrundlage freigeben; erste echte Anrufe → Ergebnisse speisen den Learning Loop.

## Lead-Analyse- und Priorisierungsmaschine

- **Zwei Scores:** `website_score` (100 = sehr gute Website; ohne Website `null`, Status `NO_WEBSITE`) und `sales_opportunity` (100 = sehr interessant). Gespeichert in `lead_analysis` (Migration `0010_analysis_tiers.sql`).
- **Auto-Demo nur ohne Website** (`config/sales.json` → `autoDemo`); bei Firmen mit Website entscheidet der Nutzer („Demo erstellen“ / „Überspringen“).
- **KI-Stufen** MASS (regelbasiert, kostenlos), DEEP, PREMIUM – Modelle in `config/ai.json` oder `ANTHROPIC_MODEL_MASS|DEEP|PREMIUM`. Jeder Aufruf wird mit Modell, Aufgabe, Token, Kosten und Lead in `ai_usage` protokolliert; unveränderte Grundlage wird per Hash nicht erneut berechnet. Ohne `ANTHROPIC_API_KEY` läuft der Mock-Adapter (Kosten 0).
- **E-Mail-Status** `draft → review_required → legally_cleared → sent` (+ `follow_up_due`, `do_not_contact`); ohne Freigabe wird nie gesendet.
- **Telefonansicht** „Was soll ich am Telefon sagen?“ und Aufgabe „Demo fertig – anrufen“ in „Heute anrufen“.
- Agentur-Daten (Betreiber Kai Schwarz) zentral in `config/agency.json`.

## Lokale Akquise-Pipeline (Suchgröße → Quellen → Dedupe → Analyse → Priorität → Demo)

- **Suchgrößen:** SMALL 50 (Standard) / MEDIUM 200 / LARGE 500 (`config/pipeline.json`). Je Lauf gespeichert: Suche-ID, Suchbegriff, Ort, Radius, gewünschte/gefundene Anzahl (Roh → Dedupe → gespeichert), Start/Ende, Quellen, Kosten (OSM/Websuche/KI/Demo/Gesamt), Fehler, Status `queued | discovering | enriching | analyzing | complete | partial | failed`.
- **Quellen (`src/sources/`):** OSM (Modi `PUBLIC_DEMO` | `LOCAL_EXTRACT` | `COMMERCIAL_PROVIDER`, `OSM_MODE`), WEB_SEARCH (Brave, `BRAVE_SEARCH_API_KEY`; ohne Schlüssel Mock/keine Quelle), DIRECT_WEBSITE (bis 5 Seiten je Domain), GOOGLE_PLACES (optional, aus). Jede Angabe: Wert + Quelle + Quell-URL + Zeitpunkt + Qualität (`lead_facts`).
- **Dedupe:** `src/dedupe/` – MATCH (zusammenführen, Alias bleibt), POSSIBLE_MATCH (nur Prüfliste), NO_MATCH. Schwellen in `config/pipeline.json`.
- **Priorität A–D:** automatisch aus Fakten (`src/scoring/priority.ts`), manuell überschreibbar (`auto_priority`, `manual_priority`, `effective_priority`, `priority_reason`).
- **Auto-Demo:** höchstens `autoDemo.maxPerSearch` (5) je Suchlauf für die höchst priorisierten Firmen ohne Website; Rest `demo_decision = recommended` („Demo empfohlen“).
- **Demo v2:** Layout-Familien SERVICE / APPOINTMENT / GASTRO_RETAIL, wählbare Module (empfohlen ≠ ausgewählt), Demo passt sich an (gleicher Link).
- **Dashboard:** Liste mit Priorität/Filtern, Seite „Heute“, Lead-Seite mit Priorität, Modulen, Notizen, Dubletten-Prüfung.
- Nicht gebaut (bewusst): Angebots-/Vertrags-/Rechnungs-/Domain-/Abo-Automation, Benachrichtigungen nach außen. Es wird nichts gesendet.

## Freigabe-Regel, Enrichment, DATA_NEEDED (Stand dieser Version)

**Grundregel:** Das System darf analysieren, empfehlen und vorbereiten – nichts Relevantes für einen einzelnen Lead wird ohne deine Bestätigung ausgeführt. Automatisch erlaubt: von dir gestartete Suche, Discovery, Dedupe, MASS-Analyse, Scores, Priorisierung, Empfehlungen und budgetkonformes Web-Enrichment. Nicht automatisch: Demo erstellen, Nachrichten, Veröffentlichung, Vertrag, Premium außerhalb des Budgets.

- **Freigaben** (`approvals`, `src/workflow/approvals.ts`): `NOT_REQUIRED → RECOMMENDED → AWAITING_APPROVAL → APPROVED → COMPLETED` oder `REJECTED`. Genutzt für `DEMO_CREATE`; `EMAIL_SEND`, `FOLLOW_UP_SEND`, `PREMIUM_ANALYSIS`, `PUBLISH_WEBSITE` sind vorgesehen, aber nicht umgesetzt.
- **Demo:** nur Empfehlung (`demo_recommendation`, Begründung). „Demo erstellen“ → Bestätigungsseite → erst dann wird gebaut. Ablehnung bleibt gespeichert. Module: empfohlen ≠ ausgewählt, vor der Erstellung änderbar.
- **DATA_NEEDED** (`work_status`): weder Telefon noch geschäftliche E-Mail. Getrennt von A/B/C/D. Ansicht „Daten“ (`/enrichment`). `contactability`: READY, PHONE_ONLY, EMAIL_ONLY, WEB_FORM_ONLY, SOCIAL_ONLY, NO_CONTACT_DATA; `preferred_contact_channel`.
- **Web-Enrichment** (`src/enrich/`): Brave (`BRAVE_SEARCH_API_KEY`; ohne Schlüssel `provider_unavailable`). ≤ 3 Suchen je Lead, nur bei fehlender Website/fehlenden Kontaktdaten, Reihenfolge A → B → interessante C, D nie. Treffer werden bewertet (Name, Ort, PLZ, Adresse, Telefon, Branche, Impressum, Kontakt): VERIFIED / LIKELY (übernommen, mit Prüfhinweis) / UNCERTAIN (nicht übernommen, manuell prüfen) / REJECTED. Danach Website-Abruf (bis 5 Seiten), Neubewertung, Priorität, Empfehlung.
- **Budget** (`config/pipeline.json` → `enrichment`): `monthly_enrichment_budget_eur` 10, `daily_enrichment_budget_eur` 2. Bei Erreichen: kein weiterer kostenpflichtiger Aufruf, Lauf läuft weiter, Leads bleiben `budget_blocked`/DATA_NEEDED. Cache je Lead (Hash, auch Misserfolge).
- **Nachträglich anreichern:** Lead-Seite „Enrichment erneut starten“, Ansicht „Daten“ „Enrichment für Daten beschaffen starten“.
- **Migration 0012:** bestehende Demos und Entscheidungen bleiben; frühere „empfohlen/übersprungen“ wurden zu Freigaben übernommen.

## Anreicherungs-Check: kontrollierter Echttest mit 5 Firmen (Stand dieser Version)

**Ziel:** erst beweisen, dass die Datenanreicherung mit echten Firmen funktioniert – bevor die übrigen Leads angereichert werden. Kein neuer Funktionsblock.

- **Kosten mit Währung:** Brave Search API „Search“ = **5 USD je 1.000 Anfragen = 0,005 USD (0,5 US-Cent) je Anfrage** (`config/pipeline.json → sources.WEB_SEARCH.pricing`, in USD; 5 USD Anbieter-Guthaben je Monat). Je Websuche-Runde speichert `enrichment_log` `provider_cost_amount` + `provider_cost_currency` (+ `fx_eur_per_usd`); `cost_cents` ist ausdrücklich **EUR-Cent** für das interne Budget (Umrechnung `config/ai.json → eurPerUsd`). Das interne Sicherheitsbudget bleibt in EUR: **10 €/Monat, 2 €/Tag**, brutto (ohne das Anbieter-Guthaben). USD und EUR werden nie vermischt (Migration 0013, Anzeige in `/enrichment` und im Lauf-Bericht).
- **Keine blinde Zuordnung:** Ein Brave-Treffer allein macht nie eine Website zur Firmenwebsite. Geprüft wird die **Startseite der Domain** (nicht die Unterseite des Treffers): Firmenname (Titel/Domain), Ort, PLZ, Straße + Hausnummer, Telefon, Branche außerhalb des Firmennamens, Impressum, Kontaktangaben und – wichtig bei OSM-Leads ohne Adresse – der **Standort der Website-Adresse** (per Nominatim geocodiert) im Vergleich zum OSM-Punkt. Stimmt der Ort nicht, ist die Adresse weit weg, der Name zu kurz/allgemein oder die Seite nicht abrufbar, bleibt es höchstens UNCERTAIN (→ „manuell prüfen“, nichts wird übernommen); zwei gleich gute Domains → UNCERTAIN. Verzeichnisse, Portale, Buchungs- und Jobseiten (Das Örtliche, Gelbe Seiten, golocal, Planity, Treatwell …) gelten nie als eigene Website.
- **Nachvollziehbarkeit:** je Lead werden Suchanfragen, Treffer, geprüfte Kandidaten (Begründung/Vorbehalte, Adresse laut Website, Abstand) und die Entscheidung gespeichert (`enrichment_log.found.trace`, Lead-Seite „Enrichment-Protokoll“). Jede gefundene Angabe steht als Fakt mit Quelle (`website-crawl` = direkt von der Website gelesen, `web-search` = Fund der Websuche, ungeprüft) und Quell-URL.
- **Prüfskript** `npm run enrich:check -- [--ensure-run] [--dry-run] [--lead "Name"]… [--max-leads 5] [--max-requests 15] [--run <id>] [--out <ordner>] [--json] [--migrate]` (`src/enrich/check.ts`, `scripts/enrich-check.sh`): wählt höchstens 5 bestehende DATA_NEEDED-Leads (Standard: Saar Schere, Hair Loft, Haarstudio Tanja, HAARgenau, Tamer), setzt eine **harte Obergrenze für Anfragen** (Standard 15; danach wird nichts mehr gesendet), reichert sie an und schreibt den Bericht VORHER → NACHHER (Markdown + JSON in `out/enrich-check/`): Anfragen/Treffer, Kandidaten mit Einstufung VERIFIED/LIKELY/UNCERTAIN/REJECTED und Gründen, gefundene Telefon/E-Mail/Kontaktformular/WhatsApp/Instagram/Facebook mit Quelle, neuer Website-Status/-Score, Verkaufschance, Priorität A–D mit Grund, Kontaktierbarkeit, work_status, Demo-Empfehlung, Kosten je Lead und gesamt (USD + EUR), Hochrechnung. **Sicherheitsprüfung:** keine Demo, kein Postausgang, keine Freigabe über „empfohlen“ hinaus, kein Lead in eine Handlungsstufe (Kontakt/Demo/Angebot …) – sonst Exit-Code 3. **Prüfliste (maschinell, im Bericht):** (1) kein Namensvetter falsch zugeordnet – jede übernommene Website braucht einen Orts-/Standortbeleg, Namensvettern in anderer Stadt/Region werden abgewiesen; (2) keine Verzeichnisdaten ungeprüft übernommen – Telefon/E-Mail/Kontaktformular nur direkt von der übernommenen Website, Verzeichnis-Treffer werden nur gezählt; (3) keine Demo; (4) nichts gesendet (Postausgang, Kontaktprotokoll, E-Mail-Status); (5) Anfragen-Limit eingehalten; (6) Kosten in USD korrekt (Anfragen × 0,005 USD = Protokoll in der Datenbank). **Entscheidungshilfe:** „brauchbar“ = plausibel verifizierte Website + mindestens ein neuer Kontaktweg direkt von dort; ab 3 von 5 Empfehlung für die kontrollierte Anreicherung der übrigen Leads (erst nach Bestätigung), sonst zusätzliche Enrichment-Quellen statt derselben Suchanfragen. `--ensure-run` legt den Suchlauf „Saarlouis · 6 km · Friseur · SMALL“ kostenlos und **ohne** Websuche an, falls es ihn in der Datenbank noch nicht gibt. Ohne `BRAVE_SEARCH_API_KEY` bricht der Befehl vor jeder Anfrage ab und erklärt, wo der Schlüssel hingehört; `--dry-run` zeigt auch ohne Schlüssel Auswahl und Zustand VORHER.
- **Getestet (ohne den echten Brave-Dienst):** Adapter gegen nachgestellte Antworten und gegen die echte Fehlerantwort; Verifikation/Prüfskript mit Testdoubles (`test/db/enrich-check.test.ts`, `test/db/enrichment.test.ts`); zusätzlich eine **Probe an einer echten Salon-Website** mit nachgespielten Suchtreffern (Lead mit Adresse → VERIFIED 100/100; nur Name + Koordinaten → VERIFIED 88/100 über den Standort; Namensvetter in anderer Stadt → abgelehnt; Standort 2,6 km entfernt → UNCERTAIN/manuell prüfen). Die Probe fand einen echten Fehler (eine Telefonnummer wurde als PLZ gelesen), der behoben und per Test abgesichert ist. **Nicht gelaufen:** eine erfolgreiche Brave-Suche mit gültigem Schlüssel.
- **Für neue Sitzungen:** `CLAUDE.md` im Projektordner enthält die verbindlichen Regeln und die Anleitung für diesen Echttest (Befehl, Stopp danach, Bericht vollständig zeigen, sechs Prüfpunkte, Entscheidung).
- **Erwartung für die Salons ohne eigene Website:** Findet die Suche nur Verzeichnisse oder Buchungsportale, bleibt der Lead korrekt bei „nichts gefunden“/DATA_NEEDED – Telefonnummern aus Verzeichnistreffern werden bewusst nicht übernommen (eigene Entscheidung, nicht Teil dieses Tests).

## Schritt 2: Arbeitsliste (Ranking, Arbeitsansichten, Freigabe)
- **Standardsortierung:** kontaktierbare Leads zuerst (mit Telefon vor ohne), dann Priorität A→D, Verkaufschance, keine Website, schlechteste Website. **DATA_NEEDED steht getrennt am Ende** – auch bei hoher Verkaufschance (Ansicht „Daten beschaffen“).
- **Ansichten/Filter (`/leads`):** Jetzt bearbeiten (kontaktierbar, A/B), Bereit zum Kontakt, Heute anrufen, Daten beschaffen, Demo empfohlen/fertig/offen, Manuell prüfen, Telefon/E-Mail vorhanden, Angerufen, Interessiert, Später, Kein Interesse, A/B/C/D, MASS/DEEP/PREMIUM.
- **Browser-Abnahme:** `docs/abnahme-schritt2/browser-abnahme.ts` (Chromium gegen eine Kopie der Live-Datenbank; Demo nur über Anfordern → Bestätigung).

## V1-Stand (Schritt 3): offen bis zum echten Brave-Test
- **Fertig und geprüft:** Suchformular → OSM-Suche (SMALL/MEDIUM/LARGE) → Dedupe → Analyse → Priorität → Ranking → Dashboard → Lead-Seite/Telefonansicht → Notiz/Status → Demo-Empfehlung → Freigabe → Module → Demo. Echter SMALL-Lauf im Browser: Saarbrücken · 4 km · Friseur/Nagelstudio → 150 roh, 149 nach Dedupe, 50 analysiert, 118 s, 0 € Kosten.
- **Offen:** echte Web-Anreicherung. Ohne `BRAVE_SEARCH_API_KEY` in der ausführenden Umgebung bleibt sie `provider_unavailable`. Der Echttest (`npm run enrich:check -- --ensure-run`, siehe CLAUDE.md) ist vorbereitet. V1 ist erst fertig, wenn er gelaufen ist oder Brave ausdrücklich nicht für V1 verwendet wird – daher noch kein V1-Tag.
- **Hinweis:** „Manuell prüfen“ zählt die noch nicht freigegebene Telefonakquise nicht mehr als Unsicherheit; „Heute anrufen“ bleibt leer, bis die Telefonakquise in den Einstellungen freigegeben ist.


## Sales Copilot / Verkaufsassistent (Stand dieser Version)
Aus den vorhandenen Lead-Daten entsteht automatisch eine persönliche Gesprächsvorbereitung (Lead-Seite, Bereich „Verkaufsassistent“). Regelbasiert und kostenlos (MASS); `src/sales/copilot.ts` (reine Logik), `src/sales/copilot-service.ts` (Speichern, Cache, DEEP), `config/copilot.json` (Texte, Schwellen, Branchenprofile, Einwände), Migration `0014_sales_copilot.sql`.
- **Automatisch** für Priorität A/B, Verkaufschance ≥ 60 oder empfohlene Demo (`config/copilot.json → auto`); für D-/uninteressante Leads nur per Button „Verkaufsassistent erzeugen“.
- **Inhalt:** 30-Sekunden-Zusammenfassung, Gesprächsziel + nächste Aktion (`recommended_next_action`), persönlicher Einstieg (je nach Website-Lage), Vorstellung, drei getrennte Bereiche (Website / Bedarfsanalyse / Kooperation) mit Potenzial `website_potential`, `needs_analysis_potential`, `partnership_potential` (HIGH/MEDIUM/LOW/UNKNOWN), 5–10 Fragen, max. 5 Argumente (Aussage · Beleg · Nutzen), Demo-Erklärung, 9 Einwände, Gesprächsablauf, „Datenlage und Unsicheres“.
- **Faktenkontrolle:** nur Lead-Daten, Prüfbefunde, Quellen, Demo und Gesprächsnotizen; „in den verfügbaren Quellen keine Website gefunden“ statt „hat keine Website“; ohne Demo keine Behauptung, es sei etwas vorbereitet; keine Umsatz-/Mitarbeiter-/Kundenzahlen, keine Versicherungsprodukte, keine Kopplung von Website-Rabatt und Versicherung (Test `copilotViolation`).
- **Cache:** Hash der Eingabe; gleiche Daten → keine Neuberechnung. Ein Anruf-Ergebnis ändert die Daten → neue nächste Aktion. Priorität (auch manuell), Notizen und Module werden vom Assistenten nie verändert.
- **Anruf-Ergebnisse neu:** „Interessiert Website“, „Bedarfsanalyse interessant“, „Kooperation interessant“, „Mehrere Themen interessant“ (mind. zwei Themen), dazu Notiz, Rückruf und „Nächster Schritt“ (`contact_history.next_step/topics`, `leads.interest_topics`).
- **Dashboard:** Kennzeichen 🌐/🛡/🤝 in der Leadliste, Filter (Website-Potenzial hoch, Bedarfsanalyse interessant, Partnerpotenzial hoch, Demo vorhanden, Anrufen, Rückruf), „Heute bearbeiten“ kompakt mit Button „Verkaufsassistent öffnen“, Gesprächsziel in der Telefonansicht.
- **Kosten:** MASS 0 €. „Verkaufsassistent vertiefen“ (DEEP) formuliert nur Einstieg und Zusammenfassung mit KI aus denselben Fakten, geprüft (keine Zahlen, Preise, Produkte), gecacht, im KI-Kostenprotokoll; ohne `ANTHROPIC_API_KEY` ehrliche Meldung, keine Kosten. Tests: `test/unit/copilot.test.ts`, `test/db/copilot.test.ts`; Browser-Abnahme `docs/abnahme-schritt2/copilot-abnahme.ts`.

## Echter Durchlauf ohne Brave-Key (Praxistest)
Zwei echte SMALL-Läufe über das Dashboard (OSM, ohne Web-Enrichment): Trier 5 km Friseur → 11 von 50 mit Telefonnummer (39 DATA_NEEDED); Saarbrücken 4 km Friseur → 42 von 50 mit Telefonnummer. Die Datenlage in OpenStreetMap schwankt stark nach Region; ohne Web-Enrichment (Brave) bleibt „keine Website gefunden“ nur „in den verfügbaren Quellen“. Nach Freigabe der Telefonakquise rechnet das System alle vorhandenen Verkaufsassistenten neu (`CopilotService.refreshAll`), damit „Heute bearbeiten“/„Heute anrufen“ sofort „Anrufen“ statt „Daten beschaffen“ zeigen.

## Agency Growth OS (Stand dieser Version)
Aufbauend auf dem bestehenden System, nichts ersetzt. Alles regelbasiert, nichts wird gesendet, bezahlt oder veröffentlicht ohne deine ausdrückliche Bestätigung.
- **A Partner/Kontaktstrategie** (`/partners`, Migr. 0015): Partnerstatus als eigenständiges Kooperationsmodell, Lead-Weitergabe nur manuell nach Prüfung (Daten, Rechtsgrundlage, Empfänger) und Bestätigung; Textwächter gegen Kopplung an Versicherung (`src/core/compliance.ts`).
- **B Aufgaben/Follow-up** (`/tasks`, 0016) · **C Demo-Stufen** (0017) · **D Preise/Konfigurator** (`config/packages.json`, INTERNAL_DRAFT_PRICE, Partnerrabatt 50 % nur auf Paketpreis, separat als `partner_discount`, Marktrichtwert nur intern) · **E Angebote** (0018) · **F Auftragspipeline** mit manueller Zahlungsbestätigung und Veröffentlichungsfreigabe (0019).
- **G Scoring/Analytics** (0020, `config/growth.json`): Dimensionen + Handlungspriorität; Analytics-Ansichten Branchen/Regionen/Strategien/Partner/Kosten.
- **H Kunden** (`/customers`, 0021): Profil aus bezahltem Auftrag, Wartungsübersicht mit Änderungsbudget, Änderungswünsche (Freigabe nötig), Portal per Token-Link (`/c/<token>`, wird nicht automatisch versendet).
- **I Community** (`/community`, 0022): Opt-in Pflicht, 29 €/Monat bzw. 290 €/Jahr (Entwurf), aktive Partner kostenlos, Verzeichnis nur als interne Vorschau.
- **J UX**: Navigationsgruppen, Lead-Reiter (ÜBERSICHT … VERLAUF, `?tab=`), Schnellaktionen (nur Links), „Heute“ nach Handlungspriorität.
- **K Betrieb**: `npm run ops -- backup | restore-check | migrate:plan | migrate:approve | migrate:apply`, siehe `docs/PRODUKTION.md`.
- Tests: `npx tsc -p . && npm test && bash test/run-db-tests.sh`; Browser-Abnahme `test/db/e2e-browser.test.ts` (Screenshots mit `SHOTS_DIR=…`).
- Offen: finale Preise freigeben; Partner-/Angebots-/Vertragstexte rechtlich prüfen; echte Zahlungs-/Domain-Anbindung später; Brave-Echttest separat.

## Team-System (Mitarbeiter-Vertrieb)
Rollen ADMIN / TEAM_LEAD / SALES, Lead-Zuweisung (Batch, Round Robin, manuell), Sperren gegen Doppelbearbeitung, Mitarbeiter-Arbeitsplatz `/work` mit Gesprächsablauf, Playbooks und Sales Copilot, zentrale Kontaktversuche (`contact_attempts`, unveränderlich), Übergaben an Kai, Admin-Cockpit mit Drilldown, Kampagnen, Tagesziele, Training, unveränderliches Audit (`team_audit`). Navigation mit Gruppen, Breadcrumbs, Zurück-Links und Seitenübersicht `/menu`. Details: `docs/TEAM.md`. Tests: `test/db/team.test.ts`, `test/db/e2e-team.test.ts` (Browser, 390 px).
