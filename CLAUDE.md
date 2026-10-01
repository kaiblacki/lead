# AI Agency OS – Arbeitsregeln für Claude

Pipeline: OSM-Suche → Analyse/Scoring → Web-Anreicherung → Priorität A–D → Demo-**Empfehlung** → **der Nutzer (Kai) bestätigt** → Demo-Bau. Stand und Aufbau: `docs/STATUS.md`, Einrichtung: `SETUP.md`.

## Verbindliche Regeln (vom Nutzer vorgegeben)
- **Nichts senden:** keine E-Mails, kein WhatsApp, keine Zahlungen, keine Kontaktaufnahme. Auch nicht, nur weil irgendwo öffentlich eine E-Mail-Adresse steht.
- **Zentrale Regel:** Das System darf analysieren, empfehlen und vorbereiten. Nichts Relevantes für einen einzelnen Lead wird ohne Bestätigung von Kai ausgeführt: Demo erstellen, E-Mail, Follow-up, WhatsApp, Kontaktaufnahme, Veröffentlichung, Domain, Vertrag, kostenpflichtige Funktionen außerhalb des Budgets. Eine von Kai gestartete Suche darf im Budget anreichern (10 €/Monat, 2 €/Tag, `config/pipeline.json`).
- **Nichts erfinden:** fehlt eine Angabe → „nicht verfügbar“; bei Unsicherheit UNCERTAIN/„manuell prüfen“. Keine privaten oder versteckten Daten beschaffen.
- **Schlüssel nur als Umgebungsvariablen** – nie ausgeben, loggen, committen oder im Chat erfragen; der Brave-Key gehört nie ins Repository oder in Client-Code. Prüfen mit `test -n "$BRAVE_SEARCH_API_KEY" && echo gesetzt`, den Wert nie anzeigen.
- **Bestehende Tests müssen weiter laufen:** `npx tsc -p . && npm test && bash test/run-db-tests.sh`. Nichts neu bauen, keine zusätzlichen Features ohne Auftrag.
- Push nur auf den im Auftrag genannten Branch, keine Pull Request ohne Aufforderung.

## Echttest der Datenanreicherung (nächster Schritt, solange der Nutzer nichts anderes sagt)
Ziel: beweisen, dass die Anreicherung mit echten Firmen funktioniert – mit höchstens 5 Leads aus dem Saarlouis-Friseur-Lauf (SMALL).
1. **Voraussetzung:** `BRAVE_SEARCH_API_KEY` ist gesetzt. Wenn nicht: nichts starten, erklären, wo er hingehört (`SETUP.md`: Cloud-Umgebung → Variable anlegen → neue Sitzung; oder lokal `export`), und nicht nach dem Wert fragen.
2. **Ausführen:** `npm run enrich:check -- --ensure-run` (legt den Lauf bei Bedarf kostenlos ohne Websuche an; höchstens 5 Leads, harte Obergrenze 15 Anfragen). Nicht wiederholen und `--ignore-cache` nur auf ausdrücklichen Wunsch – beides kostet erneut Geld. Bricht der Lauf mit einem Anbieterfehler ab (ungültiger Schlüssel, Kontingent), die Meldung zeigen und nicht blind wiederholen.
3. **Danach STOPP.** Die übrigen Leads nicht anreichern (kein `enrichBatch`, kein „Enrichment starten“), keine Demo, keine Nachricht, kein Kontakt – bis Kai ausdrücklich bestätigt.
4. **Bericht zeigen, vollständig** (`out/enrich-check/*.md`, nicht nur zusammenfassen): je Lead VORHER → NACHHER mit Website gefunden?, VERIFIED/LIKELY/UNCERTAIN/REJECTED samt Gründen, Telefon, E-Mail, Kontaktformular, Social/WhatsApp, Quelle je Fund, neuer Website-Status, website_score, sales_opportunity, Priorität, contactability, work_status, Demo-Empfehlung, Anfragen und Kosten je Lead und gesamt.
5. **Die sechs Prüfpunkte** stehen als „Prüfliste (automatisch)“ im Bericht: Namensvetter, Verzeichnisdaten, Demo, Versand, 15-Anfragen-Limit, Kosten in USD. Zusätzlich die gefundenen Websites selbst gegenlesen (URL abrufen: gehört die Seite wirklich zu dieser Firma – Adresse, Ort, Impressum?) und das Ergebnis ehrlich benennen, auch wenn nichts gefunden wurde. Salons ohne eigene Website ergeben korrekt „nichts gefunden“; Telefonnummern aus Verzeichnissen werden bewusst nicht übernommen.
6. **Entscheidung:** Liefert der Test bei mindestens 3 von 5 Leads brauchbare, plausibel verifizierte Daten (Entscheidungshilfe im Bericht), ausdrücklich sagen, ob die Pipeline gut genug ist, die übrigen Leads (47 − 5) kontrolliert anzureichern – als Empfehlung, gestartet wird erst nach Bestätigung. Findet Brave kaum brauchbare Kontaktdaten: nicht dieselben Suchanfragen wiederholen, sondern zusätzliche Enrichment-Quellen vorschlagen.

Hinweise: Die Datenbank einer Cloud-Sitzung ist flüchtig (`--ensure-run` legt den Lauf neu an). Kosten: Brave 5 USD je 1.000 Anfragen = 0,005 USD je Anfrage, in USD protokolliert; das interne Budget rechnet in EUR (`config/ai.json → eurPerUsd`).
