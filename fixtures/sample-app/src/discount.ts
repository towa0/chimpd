export function discountPercent(orderTotal: number): number {
  if (orderTotal >= 100) {
    return 10;
  }
  return 0;
}

export function applyDiscount(orderTotal: number): number {
  return orderTotal - (orderTotal * discountPercent(orderTotal)) / 100;
}
