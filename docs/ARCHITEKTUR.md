# AI Agency OS – Architektur und Entwicklungsplan (Entwurf zur Freigabe)

> **Stand der Umsetzung:** Dies ist der ursprüngliche Entwurf (Analysephase). Der tatsächlich gebaute Stand, die Abweichungen und die Testabdeckung stehen in [`STATUS.md`](STATUS.md); Bedienung und Einrichtung in [`../README.md`](../README.md) und [`../SETUP.md`](../SETUP.md).
> Wichtigste Abweichungen vom Entwurf: schlanker Node-Server ohne Framework statt Next.js (kein Build, keine Abhängigkeiten außer `pg` und `playwright-core`); Suchläufe laufen im Serverprozess statt in einer separaten Job-Queue; **jeder externe Dienst hinter einem Provider-Interface mit Mock-Adapter** (`src/providers/`), damit das ganze System ohne Konten und Schlüssel läuft und getestet ist.

## 1. Kernidee in einem Satz

Eine Pipeline, in der jeder Lead eine **Zustandsmaschine** durchläuft. Jeder Übergang wird von einem **Worker** ausgeführt, durch **Policies** (Kontakt, Budget, Kill Switch) abgesichert und im **Audit Log** festgehalten. Ein Mensch kann an jedem Übergang pausieren, freigeben oder ablehnen.

## 2. Technische Module

| # | Modul | Aufgabe | Phase |
|---|-------|---------|-------|
| 1 | `core/leads` | Lead-Datenmodell, Deduplizierung, Statusautomat | 1 |
| 2 | `connectors/*` | Datenquellen (Google Places, CSV-Import, Verzeichnisse). Ein Interface `LeadSource`, je Quelle eine Implementierung | 1 |
| 3 | `auditor` | Website-Check: HTTP, HTTPS, Ladezeit, Mobile, Inhalt, CTA, Terminbuchung, Social-Links. Liefert **Belege** (Evidence) pro Befund | 1 |
| 4 | `scoring` | Opportunity Score aus gewichteten Regeln. Gewichte in der DB, kein Code | 1 |
| 5 | `sales-analysis` | KI erzeugt Verkaufsargument nur aus gespeicherten Befunden (Structured Output, Pflichtfeld „evidence_id") | 1 |
| 6 | `dashboard` | Lead-Liste, Filter, Detailseite mit Begründung, Pipeline-Board | 1 |
| 7 | `guardrails` | Kill Switch, KI-Budget, Rate Limits, Kontakt-Policy, Audit Log | 1 (Grundgerüst) |
| 8 | `templates` + `demo` | Branchen-Templates als Daten plus React-Komponenten, Demo-Rendering, Preview-Links | 2 |
| 9 | `offers` + `pricing` | Angebote aus zentraler Preis-Konfiguration | 3 |
| 10 | `outreach` | Kanal-Adapter, Kontaktprüfung, Antwort-Klassifizierung | 3 |
| 11 | `payments` | Stripe Checkout, Webhooks, Statusübergänge | 3 |
| 12 | `production` + `qa` | Site-Build aus Daten, QA-Agent mit Playwright | 4 |
| 13 | `review` | Kundenfreigabe, Änderungswünsche | 4 |
| 14 | `deploy` | Adapter-Interface (Vercel zuerst) | 4 |
| 15 | `maintenance` | Monitoring, Reports, Stripe-Abo | 5 |
| 16 | `social` | Content-Engine, branchenparametrisiert | 6 |
| 17 | `workflow` | Job-Queue und Regel-Engine, die alles verbindet | ab 1 (minimal) |

## 3. Architektur

```
Next.js (Dashboard, Preview, Checkout-Seiten)          [Vercel]
        │  Server Actions / Route Handlers (nur Server)
        ▼
Supabase: Postgres + Auth + Storage + RLS
        ▲
        │ liest Jobs, schreibt Ergebnisse
Worker (Node/TS)  ◄── Job-Tabelle `jobs` (Postgres, SKIP LOCKED)
  ├─ Connectors  (Google Places, CSV, …)
  ├─ Auditor     (fetch + PageSpeed API; später Playwright)
  ├─ AI Gateway  (Anthropic/OpenAI, Budget-Zähler, Logging)
  ├─ Mailer / Stripe / Deploy  (jeweils hinter Interface)
```

Entscheidungen:

- **Ein Repo, TypeScript durchgängig.** Pakete: `apps/web`, `apps/worker`, `packages/core`, `packages/connectors`, `packages/auditor`, `packages/ai`.
- **Worker getrennt von Vercel.** Audits und Playwright überschreiten Serverless-Zeitlimits. MVP: Worker läuft lokal oder als kleiner Container (Fly.io/Railway/Hetzner). Die Job-Queue liegt in Postgres, deshalb ist keine Extra-Infrastruktur nötig.
- **Alle Anbieter hinter Interfaces:** `LeadSource`, `AiProvider`, `Mailer`, `PaymentProvider`, `Deployer`, `Storage`.
- **KI darf nur aus Fakten formulieren.** Auditor schreibt Befunde (`findings` mit Beleg), KI bekommt nur diese. Ohne Beleg kein Argument. Das erfüllt „keine Probleme erfinden".
- **Score ist reiner Code.** Keine KI im Score. KI nur für Text.
- **Mehrmandantenfähigkeit:** zunächst ein Nutzer (du). `owner_id` in allen Tabellen, damit RLS sauber ist und später ausbaubar.

## 4. Datenbankstruktur (Kern, Phase 1)

```
leads(id, owner_id, company_name, industry, address, city, region, phone,
      website_url, google_maps_url, source, source_url, source_ref,
      opening_hours jsonb, description, status, status_reason,
      created_at, last_analyzed_at, paused bool, contact_blocked bool)
lead_socials(lead_id, platform, url, last_activity_at)
lead_runs(id, owner_id, industry, region, radius_km, limit, goal, status,
          counters jsonb)                        -- ein Suchauftrag
audits(id, lead_id, started_at, finished_at, status,
       website_score, mobile_score, design_score, content_score,
       conversion_score, technical_score, trust_score, social_score)
findings(id, audit_id, category, code, severity, summary, evidence jsonb)
          -- code z. B. NO_BOOKING, NO_HTTPS, SLOW_LOAD
scoring_configs(id, owner_id, name, is_active, weights jsonb, thresholds jsonb)
opportunities(id, lead_id, audit_id, config_id, score, category,
              breakdown jsonb, why_interesting text)
sales_packages(id, lead_id, opportunity_id, problems jsonb, chance text,
               recommended_offer text, price_cents, opener text, model,
               generated_at, approved_by, approved_at)
events(id, owner_id, lead_id, type, payload jsonb, created_at)  -- Audit Log, append-only
jobs(id, type, lead_id, payload, status, attempts, run_after, locked_at, error)
ai_usage(id, owner_id, lead_id, model, tokens_in, tokens_out, cost_cents, created_at)
budgets(owner_id, max_leads_per_run, max_audits_per_run, max_ai_req_per_lead,
        max_daily_cents, max_monthly_cents, kill_switch bool)
suppression_list(owner_id, kind, value, reason, created_at)   -- Opt-out / Sperrliste
```

Ab Phase 2–5 kommen hinzu: `templates`, `demos`, `offers`, `price_catalog`, `conversations`, `messages`, `orders`, `payments`, `projects`, `builds`, `qa_runs`, `reviews`, `deployments`, `maintenance_plans`. Sie werden erst dann entworfen, wenn sie gebraucht werden.

**Statusautomat** (`leads.status`): NEW → ANALYZING → QUALIFIED/IGNORED → DEMO_CREATED → CONTACTED → REPLIED → INTERESTED → OFFER_SENT → DEPOSIT_PENDING → DEPOSIT_PAID → PRODUCTION → CUSTOMER_REVIEW → APPROVED → FINAL_PAYMENT → DEPLOYED → MAINTENANCE. Übergänge nur über eine zentrale Funktion, die erlaubte Übergänge prüft und ein Event schreibt. Die Zahlungsstatus (Abschnitt 15 der Spezifikation) gehören zu `orders`, nicht zu `leads`.

**Sicherheit:** RLS auf allen Tabellen, Zugriff nur für `owner_id = auth.uid()`. Der Worker nutzt den Service-Key nur serverseitig, per Environment Variable. Nichts davon ins Frontend oder in Git.

## 5. Externe Dienste und Kosten

| Dienst | Zweck | Kosten (Größenordnung, bitte vor Nutzung prüfen) |
|---|---|---|
| Google Places API (New) | Firmen suchen, Kontaktdaten | nutzungsbasiert, pro Anfrage und je Datenfeld. Kostenfaktor Nr. 1 bei 100+ Leads. Feldmaske nutzen |
| PageSpeed Insights API | Mobile/Performance | kostenlos mit Kontingent |
| Anthropic/OpenAI | Verkaufstext, später Texte, QA, Chat | pro Token. Mit Budget-Limit. Kleines Modell für Klassifikation |
| Supabase | DB, Auth, Storage | Free/Pro ab ca. 25 $/Monat. Free pausiert inaktive Projekte |
| Vercel | Hosting Dashboard und Kunden-Sites | Hobby ist nicht für kommerziellen Einsatz, deshalb Pro |
| Worker-Hosting | Audits, Playwright | wenige €/Monat |
| Stripe | Zahlungen | Gebühren pro Transaktion |
| E-Mail-Dienst (z. B. Resend, Postmark) | Versand | ab Phase 3 |
| Domain/Mail-Reputation | Zustellbarkeit | ab Phase 3 |

Kosten pro Lead in Phase 1 (Suche + Audit + ein KI-Text) liegen voraussichtlich im niedrigen Cent-Bereich. Genaue Werte messen wir im Betrieb über `ai_usage` und Places-Zähler.

## 6. Sicherheits- und Compliance-Risiken

Dies ist keine Rechtsberatung. Vor dem Live-Gang mit echter Akquise bitte Anwalt oder IHK-Beratung hinzuziehen.

1. **Kaltakquise per E-Mail/Messenger/SMS (UWG § 7).** Im B2B-Bereich braucht E-Mail-Werbung grundsätzlich eine vorherige Einwilligung. Automatisierter Erstkontakt per E-Mail ist in Deutschland deshalb das größte Risiko. Telefon im B2B erfordert mindestens mutmaßliche Einwilligung. Empfehlung: **Outreach-Kanäle im MVP nur als Vorbereitung für manuellen Kontakt** (Brief, eigener Anruf, Kontaktformular des Unternehmens manuell). Automatisches Senden erst nach rechtlicher Klärung und pro Kanal freigeschaltet.
2. **DSGVO.** Geschäftsdaten von Einzelunternehmern (Friseur, Handwerker) sind oft personenbezogen. Nötig: Rechtsgrundlage dokumentieren, Informationspflicht (Art. 14) beim Erstkontakt, Löschkonzept, Sperrliste, Verarbeitungsverzeichnis. Keine Privatnummern und keine Daten aus nicht-öffentlichen Quellen.
3. **Nutzungsbedingungen der Datenquellen.** Google Places erlaubt kein dauerhaftes Speichern oder Scraping von Inhalten über das erlaubte Maß (u. a. nur `place_id` dauerhaft). Connector muss die AGB pro Quelle kodieren (z. B. Cache-Dauer). Kein Scraping von Instagram/Facebook/LinkedIn gegen deren Regeln. Social-Signale nur über offizielle APIs oder öffentliche Links auf der Firmenwebsite.
4. **Demo-Websites mit fremdem Firmennamen.** Name und Marke sind geschützt. Demo muss privat (nicht indexierbar, `noindex`, Zugriffs-Token), klar als „Unverbindliche Demo" gekennzeichnet und zeitlich begrenzt sein. Keine fremden Bilder oder Logos übernehmen.
5. **KI-Halluzination.** Falsche Behauptungen über eine Firma können wettbewerbs- oder persönlichkeitsrechtlich heikel sein. Gegenmaßnahme: nur belegte Befunde, menschliche Freigabe vor jedem Versand.
6. **Verträge und Zahlungen.** AGB, Widerrufs- und Leistungsbeschreibung, Anzahlungslogik, Steuern (USt), Rechnungsstellung. Abos brauchen klare Kündigungsbedingungen.
7. **Generierte Kundenseiten.** Impressum und Datenschutz müssen echt sein, Cookie-/Tracking-Regeln, Barrierefreiheit (BFSG gilt seit 2025 für bestimmte Angebote). QA-Agent blockiert Platzhalter.
8. **Kostenexplosion.** Budget-Zähler vor jedem KI- und Places-Aufruf, harte Abbruchbedingung, Kill Switch.
9. **Secrets.** Nur Environment Variables. Secret Scanning im Repo aktivieren.
10. **Autonomie-Risiko.** Fehler skalieren bei Automatisierung. Darum Stufenmodell: Jede Automatisierungsstufe (Senden, Angebot, Deploy) ist einzeln aktivierbar und startet im Modus „Mensch gibt frei".

## 7. Was der MVP (Phase 1) wirklich braucht

**Ja:**
- Supabase-Schema aus Abschnitt 4 (ohne die späteren Tabellen), RLS, Auth mit einem Nutzer
- CSV-Import und Google-Places-Connector (eine Quelle reicht, Interface für weitere)
- Auditor v1: HTTP-Erreichbarkeit, HTTPS, Redirect, Ladezeit, PageSpeed-Mobile, HTML-Analyse (Telefon, Öffnungszeiten, Kontaktformular, Buchungs-Links/Keywords, CTA, Social-Links, Copyright-Jahr, Viewport-Meta)
- Scoring mit konfigurierbaren Gewichten, Kategorien HOT bis IGNORE, Begründung aus dem Breakdown
- Dashboard: Liste, Filter, Detailseite, Statusänderung, Pause/Stop pro Lead, Kill Switch
- KI-Verkaufsanalyse mit Beleg-Pflicht, Budget-Zähler, Audit Log
- Sperrliste (Tabelle + Prüfung), auch wenn noch nichts gesendet wird

**Nein (bewusst später):**
- Playwright-Screenshots und KI-Design-Bewertung (Design Score in v1 nur aus messbaren Indikatoren, z. B. Viewport, Schriftgrößen, Copyright-Jahr, Frameworks/Generator-Tags; KI-Bildanalyse erst in v1.1)
- Automatischer Versand jeglicher Art
- Demo, Angebot, Stripe, Produktion, Wartung, Social

## 8. Entwicklungsplan Phase 1 (Reihenfolge)

1. Repo-Grundgerüst (Next.js, Worker, Pakete), Linting, Tests, `.env.example`, Secret-Scanning
2. Supabase-Schema + Migrationen + RLS-Tests (lokale Postgres wie beim letzten Projekt)
3. Statusautomat, Events/Audit Log, Budgets, Kill Switch
4. Connector-Interface + CSV-Import + Deduplizierung
5. Google-Places-Connector mit Feldmaske, Zähler und Limit
6. Auditor v1 mit Unit-Tests gegen Fixture-HTMLs
7. Scoring-Engine mit Tests (Grenzwerte, Konfiguration)
8. Sales-Analysis mit Beleg-Pflicht und Budget-Bremse
9. Dashboard (Liste, Detail, Runs, Einstellungen für Gewichte und Budgets)
10. Ende-zu-Ende-Lauf: „20 Friseure Saarland" mit Kostenbericht

Jeder Schritt = ein Commit, getestet.

## 9. Offene Entscheidungen für dich

1. Google-Places-Key: Hast du ein Google-Cloud-Konto mit Abrechnung? Alternative für den Start: nur CSV-Import.
2. Worker-Hosting: lokal auf dem Mac zum Start oder direkt ein kleiner Server?
3. KI-Anbieter: Anthropic (Standard in diesem Entwurf) oder OpenAI?
4. Outreach: einverstanden, dass es im MVP nur Vorbereitung für manuellen Kontakt gibt?
5. Hat `workmode-2030` mit diesem Projekt zu tun oder bleibt es getrennt? (Annahme: getrennt.)
6. Name der Firma/Rechtsform für spätere Angebote (nicht für Phase 1 nötig).
