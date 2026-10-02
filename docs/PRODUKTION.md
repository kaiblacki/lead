# Produktivbetrieb – Backup, Wiederherstellung, Migrationen

Alles hier läuft **nur auf deinen ausdrücklichen Aufruf**. Nichts wird automatisch ausgeführt, nichts wird gesendet, Zugangsdaten werden nie ausgegeben.

## Voraussetzungen
- `DATABASE_URL` als Umgebungsvariable (Supabase/Postgres), siehe `SETUP.md`. Den Wert nie in Chats, Logs oder Commits schreiben.
- `pg_dump` und `psql` (Paket `postgresql-client`).
- Ordner `backups/` (ist in `.gitignore`) und `out/` (ebenfalls ignoriert).

## 1. Backup
```bash
npm run ops -- backup
```
Schreibt `backups/backup-<Zeitstempel>.sql` (Rechte 0600). Das Backup enthält Kundendaten: nicht committen, verschlüsselt/sicher ablegen. Empfehlung: vor jeder Migration und mindestens wöchentlich; zusätzlich die Backups des Datenbankanbieters (z. B. Supabase-Point-in-Time-Recovery) aktivieren.

## 2. Wiederherstellung prüfen (ohne die echte Datenbank anzufassen)
```bash
npm run ops -- restore-check            # neuestes Backup
npm run ops -- restore-check backups/backup-20261002-120000.sql
```
Legt eine Wegwerf-Datenbank `restore_check_<Zeit>` an, spielt das Backup ein, prüft die Tabellen (u. a. `leads`) und löscht sie wieder. Ein Backup, das nie wiederhergestellt wurde, ist nur eine Vermutung – bitte regelmäßig prüfen.

### Echte Wiederherstellung (Notfall)
1. App stoppen (Kill Switch im Dashboard, dann Dienst anhalten).
2. Neue, leere Datenbank anlegen; `psql -v ON_ERROR_STOP=1 -f backups/<datei>.sql "$NEUE_DATABASE_URL"`.
3. `DATABASE_URL` auf die neue Datenbank stellen, Dienst starten, `npm run ops -- migrate:plan` – offene Migrationen erscheinen als Plan.
4. Dashboard prüfen: Leads, Aufträge, Kunden, Zahlungen (manuelle Bestätigungen!) stichprobenartig kontrollieren.

## 3. Migrationen: Trockenlauf → Freigabe → Anwendung
```bash
npm run ops -- migrate:plan             # Trockenlauf: zeigt offene Migrationen + Hinweise auf DROP/DELETE/TRUNCATE/…
npm run ops -- backup
npm run ops -- migrate:approve <Hash>   # deine ausdrückliche Freigabe, Hash steht im Plan
npm run ops -- migrate:apply
```
- Der Plan (`out/migrate-plan.md`) verändert nichts.
- `migrate:apply` verweigert, wenn: keine Freigabe, Freigabe gehört zu einem anderen Plan (Inhalt geändert), kein Backup oder Backup älter als 24 Stunden.
- Jede Migration läuft in einer eigenen Transaktion; bei einem Fehler wird nur diese zurückgerollt, die Meldung nennt bereits angewendete Dateien.
- Migrationen sind nummeriert (`NNNN_*.sql`), werden der Reihe nach angewendet und sind – wo sinnvoll – idempotent (`if not exists`). Angewendete Dateien stehen in `public.schema_migrations`; Stände aus dem Demo-Launcher (`public.demo_migrations`) werden mitgezählt.

## 4. Checkliste vor dem echten Betrieb
- [ ] Preise aus `config/packages.json` (Status `INTERNAL_DRAFT_PRICE`) von dir freigegeben
- [ ] Partnerbedingungen, Angebots-, Vertrags- und Datenschutztexte rechtlich geprüft (Weitergabe von Leads nur mit Rechtsgrundlage und deiner Bestätigung)
- [ ] Zahlungsanbieter und Domain-Anbindung: **noch nicht angebunden** (Zahlungen werden manuell bestätigt, Veröffentlichung ist ein manueller Schritt) – spätere, separate Aufgabe
- [ ] HTTPS, `DASHBOARD_PASSWORD`, Schlüssel nur als Umgebungsvariablen
- [ ] Backup-Routine eingerichtet und `restore-check` mindestens einmal erfolgreich
- [ ] Brave-Echttest (separat, siehe CLAUDE.md) – unabhängig von diesem Dokument

## Grenzen
- `restore-check` braucht das Recht, Datenbanken anzulegen; bei verwalteten Anbietern ggf. nicht erlaubt – dann Backup in einer lokalen Postgres-Instanz prüfen.
- Der Risiko-Scan der Migrationen ist ein Hinweis, keine Garantie. Plan bitte lesen.
