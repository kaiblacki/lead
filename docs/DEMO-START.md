# Agency Lead OS lokal starten

## Start
```
cd ~/lead
npm run demo:start
```
Das Skript findet PostgreSQL selbst (Postgres.app, Homebrew oder `psql` im PATH), startet es falls nötig, legt die Datenbank `agency_demo`, die Migrationen und den Demo-Benutzer an, wählt einen freien Port (bevorzugt 3055), startet den Server, prüft per HTTP und öffnet den Browser. Am Ende steht **DEMO BEREIT** und die genaue Adresse im Terminal.

## Status
```
npm run demo:status
```
Zeigt PostgreSQL, Datenbank, Migrationen, Demo-Benutzer, Server, Port und URL.

## Stop
```
npm run demo:stop
```
Beendet nur den Demo-Server. PostgreSQL bleibt unberührt. Neustart: wieder `npm run demo:start` (Daten bleiben erhalten).

## Browser und Login
Die URL steht nach dem Start im Terminal (normalerweise http://127.0.0.1:3055). Login: beliebiger Benutzername; das Passwort steht im Terminal und in der Datei `.env.local` (Zeile `DASHBOARD_PASSWORD=`, lokal, nicht im Repository – dort änderbar). Danach: **Neue Suche** auf der Startseite (Ort, Radius, Branche, Größe, „Leads suchen“).

## Optional: Brave (Web-Anreicherung)
Ohne Schlüssel läuft alles mit OpenStreetMap-Daten. Mit Schlüssel in `.env.local` eine Zeile `BRAVE_SEARCH_API_KEY=…` ergänzen (nie ins Repository) und `npm run demo:stop && npm run demo:start`. Der Schlüssel wird nie angezeigt.

## Wenn etwas nicht klappt
- **„PostgreSQL ist auf diesem Rechner nicht installiert“:** Postgres.app von https://postgresapp.com installieren, einmal öffnen, „Initialize“ klicken, dann `npm run demo:start`.
- **„PostgreSQL ist installiert, aber es läuft kein Server“:** Postgres.app öffnen und auf „Start“ klicken (oder `brew services start postgresql@16`).
- **„keine Anmeldung klappt“:** in `.env.local` eine Zeile `DATABASE_URL=postgres://BENUTZER:PASSWORT@127.0.0.1:5432/agency_demo` ergänzen (Postgres.app: Benutzer = dein Mac-Benutzername, ohne Passwort).
- **Server startet nicht:** Log in `.demo/server.log`; `npm run demo:status` zeigt, was fehlt.
