export const ORDER_STATUSES = ['PAYMENT_PENDING', 'DEPOSIT_PAID', 'IN_PRODUCTION', 'CUSTOMER_REVIEW', 'APPROVED', 'FINAL_PAYMENT_PENDING', 'FULLY_PAID', 'DEPLOYED', 'MAINTENANCE_ACTIVE'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const NEXT: Record<OrderStatus, OrderStatus[]> = {
  PAYMENT_PENDING: ['DEPOSIT_PAID'],
  DEPOSIT_PAID: ['IN_PRODUCTION'],
  IN_PRODUCTION: ['CUSTOMER_REVIEW'],
  CUSTOMER_REVIEW: ['IN_PRODUCTION', 'APPROVED'],
  APPROVED: ['FINAL_PAYMENT_PENDING'],
  FINAL_PAYMENT_PENDING: ['FULLY_PAID'],
  FULLY_PAID: ['DEPLOYED'],
  DEPLOYED: ['MAINTENANCE_ACTIVE'],
  MAINTENANCE_ACTIVE: [],
};

/** Die Zahlungslogik lässt sich nicht umgehen: FULLY_PAID ist nur aus FINAL_PAYMENT_PENDING erreichbar, DEPLOYED nur aus FULLY_PAID. */
export function assertOrderTransition(from: OrderStatus, to: OrderStatus): void {
  if (!NEXT[from].includes(to)) throw new Error(`Bestellstatus ${from} → ${to} ist nicht erlaubt`);
}
