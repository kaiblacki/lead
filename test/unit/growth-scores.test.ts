import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGrowthScores, type GrowthInput } from '../../src/scoring/growth.ts';
import { loadConfig } from '../../src/core/config.ts';

const cfg = loadConfig().growth;
const base: GrowthInput = { status: 'QUALIFIED', work_status: 'CONTACTABLE', contactability: 'READY', website_state: 'none', website_quality: null, sales_opportunity: 70, digital_need: 80, data_quality: 70, official_website_verified: false, has_phone: true, has_email: false,
  website_potential: 'HIGH', partnership_potential: 'LOW', needs_analysis_potential: 'LOW', partner_status: null, call_count: 0, interest: false, demo_stage: 'NO_DEMO', offer_open: false, callback_due: false, due_tasks: 0, paused: false };

test('Gewichte konfigurierbar und Summe 1; alle Dimensionen 0–100', () => {
  assert.ok(Math.abs(Object.values(cfg.weights as Record<string, number>).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  const s = computeGrowthScores(base, cfg);
  for (const k of ['digitalNeed', 'contactability', 'dataConfidence', 'salesOpportunity', 'partnerPotential', 'engagement', 'actionPriority'] as const) assert.ok(s[k] >= 0 && s[k] <= 100, k);
  assert.equal(s.websiteQuality, 0, 'keine Website → Qualität 0');
});

test('Handlungspriorität: fällige Aufgabe/Rückruf/Interesse erhöhen, DATA_NEEDED/keine Kontaktmöglichkeit senken, abgeschlossen = 0', () => {
  const b = computeGrowthScores(base, cfg).actionPriority;
  assert.ok(computeGrowthScores({ ...base, due_tasks: 1 }, cfg).actionPriority > b);
  assert.ok(computeGrowthScores({ ...base, callback_due: true }, cfg).actionPriority > b);
  assert.ok(computeGrowthScores({ ...base, interest: true, call_count: 1 }, cfg).actionPriority > b);
  assert.ok(computeGrowthScores({ ...base, work_status: 'DATA_NEEDED' }, cfg).actionPriority < b);
  assert.ok(computeGrowthScores({ ...base, contactability: 'NO_CONTACT', has_phone: false }, cfg).actionPriority < b - 20);
  assert.equal(computeGrowthScores({ ...base, status: 'IGNORED' }, cfg).actionPriority, 0);
  assert.equal(computeGrowthScores({ ...base, paused: true }, cfg).actionPriority, 0);
});

test('Partnerpotenzial: aktiver Partner 100; Begründung nachvollziehbar; kein Versicherungsbezug', () => {
  const s = computeGrowthScores({ ...base, partner_status: 'ACTIVE_PARTNER' }, cfg);
  assert.equal(s.partnerPotential, 100); assert.ok(s.reasons.length >= 1);
  assert.doesNotMatch(JSON.stringify(s), /Versicherung|Rabatt/);
});

test('fehlende Werte werden nicht erfunden: Website-Qualität unbekannt → null', () => {
  assert.equal(computeGrowthScores({ ...base, website_state: 'present', website_quality: null }, cfg).websiteQuality, null);
});
