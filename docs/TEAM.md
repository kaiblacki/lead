# Mitarbeiter-Vertrieb (Team-System)

Ziel: Kai weist Leads zu, Mitarbeiter arbeiten selbstständig aus einem eigenen Arbeitsplatz, Kai sieht jederzeit, was passiert ist. Alles bleibt in der bestehenden Pipeline; das System **sendet nichts**.

## Anmeldung und Rollen
- **ADMIN**: bisheriges Dashboard-Passwort (`DASHBOARD_PASSWORD`) mit beliebigem Benutzernamen, oder ein Mitarbeiterkonto mit Rolle ADMIN.
- **TEAM_LEAD** (Teamleitung): sieht Team, weist Leads zu, liest Gespräche/Notizen, gibt Feedback. Kein Zugriff auf Einstellungen, Preise/Angebote, Aufträge/Zahlungen, Kunden, Community, Suche, Kosten.
- **SALES** (Vertrieb): nur `/work` (Mein Tag, Meine Leads, Rückrufe, Aufgaben, Übergaben, Training) und nur eigene Leads.
- Mitarbeiter legt der Admin unter **Team → + Mitarbeiter anlegen** an (Login + Startpasswort, mind. 8 Zeichen, nur als scrypt-Hash gespeichert). Status ACTIVE / PAUSED / DISABLED (deaktiviert = keine Anmeldung, keine neuen Leads).
- Rechte werden zentral im Server geprüft (`src/team/rules.ts → pathAllowed`), nicht nur durch ausgeblendete Menüs.

## Lead-Zuweisung (Team → Lead-Zuweisung)
Filter: Branche, Region, Radius, Priorität, Website-Status, Verkaufschance, Partnerpotenzial, Kontaktierbarkeit, Anzahl. Erst „Passende Leads zählen“, dann „N Leads zuweisen“. Arten: MANUAL (Lead-Seite → VERLAUF → Zuweisung), BATCH_ASSIGNMENT, ROUND_ROBIN (mehrere Mitarbeiter gewählt). AUTO_RULE ist nicht aktiv – Kai entscheidet. Zugewiesen werden nur freie, nicht gesperrte, nicht pausierte Leads an aktive Mitarbeiter.
Pro Lead: `assigned_to_user_id`, `assigned_at`, `assigned_by`, `assignment_source`, `assignment_status` (UNASSIGNED, ASSIGNED, IN_PROGRESS, COMPLETED, RETURNED, TRANSFERRED).
**Sperre gegen Doppelbearbeitung:** Öffnet jemand den Lead im Arbeitsplatz, wird er 30 Minuten gesperrt („Wird gerade von Max bearbeitet.“). Abgelaufene Sperren sind frei; Admin/Teamleitung können lösen.

## Arbeitsplatz (SALES)
Mein Tag (Zahlen, Fortschritt gegen Tagesziele, **ARBEIT STARTEN**) → **Nächster Lead** (fällige Rückrufe → Aufgaben → Priorität/Handlungspriorität; nur zum Anruf freigegebene, nicht gesperrte Leads) → Lead-Seite in einer Ansicht: Telefon, Ziel, „Das weiß das System“, „Das soll ich sagen“ (Sales Copilot), Playbook, schrittweiser Gesprächsablauf, Notiz, E-Mail, Historie.
**Playbooks** A–E (Keine Website, Website verbessern, Partnerschaft, Bedarfsanalyse, Website + Partnerschaft). Das System empfiehlt; eine Kampagne kann eines vorgeben.
**Ergebnisse** (große Buttons): Nicht erreicht · Kein Interesse · Rückruf · Website interessant · Demo gewünscht · Partnerschaft · Bedarfsanalyse · Mehrere Themen · Angebot gewünscht · An Kai übergeben · Nicht mehr kontaktieren. Bei Interesse/Übergabe ist eine **Notiz Pflicht**; bei Rückruf Datum + Uhrzeit.
**Folgeaktionen:** über die bestehende Pipeline (Statuswechsel, Rückruf-/Follow-up-Aufgaben). „Demo gewünscht“ und „Angebot gewünscht“ **erstellen nichts automatisch**, sondern legen eine Aufgabe für Kai an. „Nicht mehr kontaktieren“ sperrt den Lead.
**Übergabe an Kai:** Grund (Website-Angebot, Partnergespräch, Bedarfsanalyse, Großkunde, Sonderfall, Mehrere Themen), Notiz, Interesse, Rückrufwunsch, nächster Schritt → Team → Übergaben.
**E-Mail:** Entwurf = `DRAFT`. „Versendet“ (`SENT`) kann nur vermerkt werden, wenn eine dokumentierte E-Mail-Freigabe existiert und der Mitarbeiter ausdrücklich bestätigt, die Mail selbst gesendet zu haben.
**Kontaktfreigabe** (abgeleitet, nie automatisch erlaubt): CALL_APPROVED (Telefonakquise freigegeben + Lead bereit), EMAIL_PERMISSION (dokumentierte Einwilligung), CONTACT_REVIEW_REQUIRED, DO_NOT_CONTACT.
**Training:** `/work/training` – nur erfundene Firmen, nichts wird gespeichert, kein echter Lead.

## Admin-Cockpit
- **Team**: Tabelle je Mitarbeiter (zugewiesen, neu, bearbeitet, Anrufversuche, E-Mails, erreicht, interessiert, Demos, Rückrufe, Übergaben, erledigt, letzte Aktivität), Zeitraum heute/Woche/Monat/benutzerdefiniert. **Jede Zahl ist anklickbar** und zeigt die Leads dahinter (Firma, Mitarbeiter, Kanal, Ergebnis, Notiz, Zeit).
- **Team-Aktivität**: Filter (Mitarbeiter, Datum, Branche, Region, Kampagne, Playbook, Kanal, Ergebnis, Leadstatus, Priorität), Quoten (Reach, Interest, Demo, Handoff, Follow-up-Erledigung) und Aufschlüsselung nach Branche/Region/Priorität/Playbook für faire Vergleiche. Keine Rangliste.
- **Mitarbeiterprofil**: heute/Woche, Ziele, zugewiesene Leads (alle, mit Kanal/Ergebnis/Notiz/nächster Aktion), letzte Kontaktversuche, Feedback, Protokoll.
- **Lead → VERLAUF**: Zuweisung und lückenlose Kontakt-Historie (wer, wann, Kanal, Ergebnis, Notiz). Einträge werden nur ergänzt; die Datenbank verbietet Änderungen an Kontaktversuchen und Audit-Einträgen.
- **Kampagnen**: Name, Regeln, Mitarbeiter, Anzahl, Playbook; Fortschritt (zugewiesen, bearbeitet, offen, erreicht, interessiert, Demo, Übergaben).
- **Tagesziele** je Mitarbeiter (Anrufversuche, erreichte Kontakte, qualifizierte Gespräche, Follow-ups). Keine Provisionen oder Vergütung.
- **Audit-Protokoll** (Team → Audit): LOGIN, LEAD_OPENED, LEAD_ASSIGNED, CONTACT_ATTEMPT, CALL_RESULT, EMAIL_DRAFTED, EMAIL_SENT_MARKED, NOTE_ADDED, TASK_CREATED, TASK_COMPLETED, DEMO_REQUESTED, HANDOFF_CREATED u. a. Nicht löschbar.

## Definitionen der Kennzahlen
Erreicht = Telefonversuch mit anderem Ergebnis als „Nicht erreicht“. Interessiert = Website interessant / Demo gewünscht / Angebot gewünscht. Qualifiziert = Interessiert + Partnerschaft + Bedarfsanalyse + Mehrere Themen + Übergabe. E-Mails = nur als versendet bestätigte. Zahlen sind Zählungen der gespeicherten Kontaktversuche, keine Schätzung.

## Grenzen
Mitarbeiter-Login nutzt HTTP-Basic-Auth wie das bisherige Dashboard (HTTPS im Betrieb Pflicht). Es gibt keine Passwort-Zurücksetzen-Funktion – der Admin setzt ein neues Passwort im Profil. Kontaktversuche aus dem alten Admin-Anruf-Ablauf werden ebenfalls erfasst (Mitarbeiter „Admin“).
