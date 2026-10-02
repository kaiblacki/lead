/** Anzeige der Auftragspipeline in den Schritten des Gesamtablaufs. Baut auf den bestehenden Bestellstatus auf (keine zweite Statusmaschine). */
export const PIPELINE_STEPS = ['OFFER_ACCEPTED', 'ORDER_CREATED', 'DEPOSIT_PENDING', 'DEPOSIT_PAID', 'PRODUCTION_READY', 'PRODUCTION', 'INTERNAL_QA', 'CUSTOMER_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'FINAL_PAYMENT_PENDING', 'FINAL_PAYMENT_PAID', 'READY_TO_DEPLOY', 'DEPLOY_APPROVAL', 'DEPLOYED', 'MAINTENANCE'] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];
export const PIPELINE_LABEL: Record<PipelineStep, string> = { OFFER_ACCEPTED: 'Angebot angenommen', ORDER_CREATED: 'Auftrag angelegt', DEPOSIT_PENDING: 'Anzahlung offen', DEPOSIT_PAID: 'Anzahlung bezahlt', PRODUCTION_READY: 'Produktion vorbereitet', PRODUCTION: 'Produktion', INTERNAL_QA: 'Interne Kontrolle', CUSTOMER_REVIEW: 'Kundenfreigabe', CHANGES_REQUESTED: 'Änderungen gewünscht', APPROVED: 'Freigegeben', FINAL_PAYMENT_PENDING: 'Restzahlung offen', FINAL_PAYMENT_PAID: 'Restzahlung bezahlt', READY_TO_DEPLOY: 'Bereit zur Veröffentlichung', DEPLOY_APPROVAL: 'Veröffentlichung freigegeben', DEPLOYED: 'Veröffentlicht', MAINTENANCE: 'Wartung' };

export function pipelineStep(o: { orderStatus: string; hasBuild: boolean; openChanges: number; deployApproved: boolean }): PipelineStep {
  switch (o.orderStatus) {
    case 'PAYMENT_PENDING': return 'DEPOSIT_PENDING';
    case 'DEPOSIT_PAID': return 'DEPOSIT_PAID';
    case 'IN_PRODUCTION': return o.openChanges > 0 ? 'CHANGES_REQUESTED' : o.hasBuild ? 'PRODUCTION' : 'PRODUCTION_READY';
    case 'QA': return 'INTERNAL_QA';
    case 'CUSTOMER_REVIEW': return 'CUSTOMER_REVIEW';
    case 'APPROVED': return 'APPROVED';
    case 'FINAL_PAYMENT_PENDING': return 'FINAL_PAYMENT_PENDING';
    case 'FULLY_PAID': return o.deployApproved ? 'DEPLOY_APPROVAL' : 'READY_TO_DEPLOY';
    case 'DEPLOYED': return 'DEPLOYED';
    case 'MAINTENANCE_ACTIVE': return 'MAINTENANCE';
    default: return 'ORDER_CREATED';
  }
}
/** Schritte, die schon durchlaufen sind (inkl. des aktuellen = „jetzt“). FINAL_PAYMENT_PAID gilt ab FULLY_PAID. */
export function stepStates(cur: PipelineStep): { step: PipelineStep; state: 'done' | 'now' | 'todo' }[] {
  const idx = PIPELINE_STEPS.indexOf(cur);
  return PIPELINE_STEPS.map((step, i) => ({ step, state: step === cur ? 'now' : i < idx || ((cur === 'READY_TO_DEPLOY' || cur === 'DEPLOY_APPROVAL' || cur === 'DEPLOYED' || cur === 'MAINTENANCE') && step === 'FINAL_PAYMENT_PAID') ? 'done' : 'todo' }));
}
