# Projektstatus – AI Agency OS

Stand: Ende der Mock-Ausbaustufe. Zahlen stammen aus dem letzten vollständigen Testlauf (`npm run test:all`).

## Gesamtbild

| Kennzahl | Wert |
|---|---|
| **Lokaler MVP mit Mock-Diensten** (alles aus dem Auftrag, ohne externe Konten) | **≈ 95 %** gebaut und automatisch getestet |
| **Bereit für den Betrieb mit echten Diensten** | **≈ 60 %** – 7 von 10 echten Adaptern sind gebaut, **aber noch kein einziger gegen den echten Dienst gelaufen**; 3 Adapter fehlen; Rechtstexte/Preise fehlen |
| Automatische Tests | **174** (104 Unit + 70 Datenbank/HTTP/Ende-zu-Ende/Browser), alle grün; Typprüfung `tsc --strict` sauber |
| Code | ca. 6.300 Zeilen Anwendung, ca. 2.700 Zeilen Tests, 7 Migrationen, 11 Branchenvorlagen |

Begründung der Prozentzahlen: Der lokale Umfang ist vollständig; die restlichen ~5 % sind bekannte Lücken ohne Schlüsselbedarf (siehe „Noch nicht gebaut“, z. B. Mehrbenutzer-Verwaltung, Benachrichtigungen). „Bereit für echten Betrieb“ wird vor allem dadurch begrenzt, dass die echten Adapter nur mit nachgestellten HTTP-Antworten getestet sind und die rechtlichen Angaben (Preise, AGB, Impressum) bewusst leer sind.

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
| 24 | **E-Mail** | SMTP-Adapter (STARTTLS/TLS, Schutz gegen Header-Einschleusung), Postausgang-Seite (auch im Mock sichtbar, als „nur aufgezeichnet“ gekennzeichnet), Test-Mail, Betreiber-Benachrichtigungen (Zahlung, Freigabe, Änderungswunsch, Wartungsproblem), Kunden-Mails aus dem Auftrag per Knopfdruck (Zahlungs-/Freigabe-Link, „online“), Sperrliste wird beachtet. Kein automatischer Versand an Interessenten | Unit (Fake-SMTP-Server) + DB |
| 23 | **Demo-Start** | `npm run demo:db` + `npm run demo`: komplettes System mit Beispieldaten ohne Konten | von Hand geprüft |

## NUR MIT API-KEY / ECHTEM DIENST TESTBAR (Code vorhanden, aber nie gegen den echten Dienst gelaufen)

| Adapter | Braucht | Stand |
|---|---|---|
| Google Places (Suche, Details) | `GOOGLE_PLACES_API_KEY` | gebaut, gegen nachgestellte Antworten getestet; Radius, Feldmaske, Anfragenzähler vorhanden |
| HTTP-Crawler (robots.txt, SSRF-Schutz) | Netzwerk + echte Websites | gebaut; Verhalten auf echten, „schmutzigen“ Websites ungeprüft |
| Playwright-Render / Tiefenprüfung | Chromium + echte Websites | gebaut; der gleiche Browser läuft bereits in der QA eigener Seiten |
| Anthropic (Gesprächseinstieg, Änderungswünsche) | `ANTHROPIC_API_KEY` | gebaut mit gleichen Prüfregeln wie der Mock; Antwortqualität und Kosten ungeprüft |
| Stripe (Checkout, Webhooks, Abo) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, Stripe CLI | gebaut, mit signierten Testereignissen geprüft; Abo-Verlängerung/Zahlungsausfall/Kündigung werden verarbeitet, aber nur simuliert getestet |
| SMTP-E-Mail | SMTP-Zugangsdaten | gebaut, gegen einen lokalen Fake-SMTP-Server getestet (inkl. Anmeldung, Fehler); nie gegen einen echten Mail-Anbieter |
| Vercel-/Ordner-Hosting | `VERCEL_TOKEN` | Ordner-Variante lokal geprüft; Vercel nicht |
| Docker-Image | Docker | Dockerfile, Healthcheck, Produktionsbefehl, Variablen dokumentiert und statisch geprüft; **nie gebaut oder gestartet** |
| Echter iPhone-Safari-Test | Gerät | Mobil-Tests liefen in Chromium (Geräteprofil), nicht auf einem iPhone |

## NOCH NICHT GEBAUT

| Was | Warum / Hinweis |
|---|---|
| Echte Adapter für **Verzeichnisse** (z. B. Gelbe Seiten), **Social-Daten** (Instagram/Facebook), **WhatsApp** | Schnittstelle + Mock stehen; Nutzungsbedingungen der Quellen und rechtliche Klärung (UWG § 7) vorab nötig. Bis dahin nichts Automatisches |
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
