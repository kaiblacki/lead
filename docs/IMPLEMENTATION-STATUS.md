# Implementation Status (zentrale Wahrheit für Claude + Codex)

## Current state
Letzter grüner Commit: siehe `git log` (Baseline-Commit „chore: stabilize local development baseline“)
Branch: claude/supabase-vercel-setup-17lr75 · Remote: kaiblacki/lead

## Baseline (Mac, Node 24.21, Postgres.app 18.6)
- Typecheck: GREEN
- Unit: GREEN (178/178, mit CHROMIUM_PATH)
- DB: GREEN (152 pass, 0 fail, 1 skipped – siehe Known issues)
- Browser (E2E/Mobile, Chromium aus Playwright-Cache): GREEN (in DB-Lauf enthalten)
- Demo-Launcher: GREEN (start → HTTP 200, status 23/23 Migrationen, stop)

### Lokaler Testaufruf (Mac)
```
export CHROMIUM_PATH="$HOME/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
export PATH=/Applications/Postgres.app/Contents/Versions/latest/bin:$PATH PGHOST=127.0.0.1 PGUSER=postgres TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/dbtest
npx tsc -p . && npm test && bash test/run-db-tests.sh
```
(TCP statt Socket, weil Postgres.app den Socket-Zugriff erst nach Bestätigung eines macOS-Dialogs erlaubt.)

## Current phase
Phase 1 – Baseline: DONE (Commit siehe git log). Phasen 2–36 des Master-Leitfadens sind laut docs/STATUS.md/TEAM.md größtenteils bereits gebaut (Team-System, Navigation, Rollen, Zuweisung, Arbeitsplatz, Playbooks, Kontaktversuche, Übergaben, Cockpit, Kampagnen, Audit, Training). Nächster Schritt: Abgleich Master-Leitfaden ↔ Bestand (Lücken-Liste), danach Lücken nach Priorität P1→P3.

## Completed
- Baseline (SMTP-Test-Fixture, Postgres, DB-Tests, Demo-Launcher)

## Open
- Abgleich Leitfaden ↔ Bestand, Lücken schließen (P1: echte Sessions/Login statt Basic-Auth, Security-Review)
- Security-Review und Performance-Review durch Codex

## Known issues
- test/db/demo-start.test.ts „Anmeldung unmöglich“ wird übersprungen, wenn der lokale Server trust-Auth hat (Postgres.app). Auf Server mit Passwortpflicht läuft er.
- Projekt läuft lokal gegen PostgreSQL 18; CI/Doku nennen 16 – nicht gegen 16 getestet.

## Manual blockers
- Keine. (Optional: in Postgres.app den Socket-Zugriffsdialog bestätigen.)

## Last Codex review
Baseline-Diff (SMTP-Fixture, demo-start-Test): Critical 0, High 0.
- MEDIUM Skip-Prüfung bildet Launcher-Rückfälle nicht ab → Accepted: Prüfung entfernt, Test reagiert jetzt auf das echte Launcher-Ergebnis (Exit 0 = trust-Auth → skip), Server/DB werden aufgeräumt.
- MEDIUM Probe ohne Timeout/end() → hinfällig durch obige Änderung.
- LOW QUIT ohne 221-Abwarten (Ursache des ECONNRESET) → Accepted: smtp.ts wartet kurz auf 221; Fixture schluckt keine Fehler mehr, sondern prüft `errors == []`.
Stabilität: email.test.ts 8× hintereinander grün.
