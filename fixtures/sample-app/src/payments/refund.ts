export interface Charge {
  id: string;
  amount: number;
  refunded: number;
}

export function refundableAmount(charge: Charge, requested: number): number {
  const remaining = charge.amount - charge.refunded;
  if (requested > remaining) {
    return remaining;
  }
  return requested;
}
