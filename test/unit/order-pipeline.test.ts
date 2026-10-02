import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PIPELINE_STEPS, pipelineStep, stepStates } from '../../src/orders/pipeline.ts';

test('Auftragspipeline-Anzeige: 16 Schritte, Abbildung der bestehenden Bestellstatus, Änderungswünsche, Veröffentlichungsfreigabe', () => {
  assert.equal(PIPELINE_STEPS.length, 16);
  const s = (orderStatus: string, o: object = {}) => pipelineStep({ orderStatus, hasBuild: false, openChanges: 0, deployApproved: false, ...o });
  assert.equal(s('PAYMENT_PENDING'), 'DEPOSIT_PENDING'); assert.equal(s('IN_PRODUCTION'), 'PRODUCTION_READY'); assert.equal(s('IN_PRODUCTION', { hasBuild: true }), 'PRODUCTION'); assert.equal(s('IN_PRODUCTION', { hasBuild: true, openChanges: 2 }), 'CHANGES_REQUESTED');
  assert.equal(s('QA'), 'INTERNAL_QA'); assert.equal(s('CUSTOMER_REVIEW'), 'CUSTOMER_REVIEW'); assert.equal(s('APPROVED'), 'APPROVED'); assert.equal(s('FINAL_PAYMENT_PENDING'), 'FINAL_PAYMENT_PENDING');
  assert.equal(s('FULLY_PAID'), 'READY_TO_DEPLOY'); assert.equal(s('FULLY_PAID', { deployApproved: true }), 'DEPLOY_APPROVAL'); assert.equal(s('DEPLOYED'), 'DEPLOYED'); assert.equal(s('MAINTENANCE_ACTIVE'), 'MAINTENANCE');
  const st = stepStates('READY_TO_DEPLOY'); assert.equal(st.find((x) => x.step === 'READY_TO_DEPLOY')!.state, 'now'); assert.equal(st.find((x) => x.step === 'FINAL_PAYMENT_PAID')!.state, 'done'); assert.equal(st.find((x) => x.step === 'DEPLOYED')!.state, 'todo'); assert.equal(st.find((x) => x.step === 'OFFER_ACCEPTED')!.state, 'done');
});
