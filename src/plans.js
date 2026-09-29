const catalog = [
  { months: 1, priceRub: 199, fullPriceRub: 199, discountPercent: 0, savingRub: 0, pricePerMonthRub: 199 },
  { months: 3, priceRub: 499, fullPriceRub: 597, discountPercent: 16, savingRub: 98, pricePerMonthRub: 166.33 },
  { months: 12, priceRub: 1499, fullPriceRub: 2388, discountPercent: 37, savingRub: 889, pricePerMonthRub: 124.92 }
];

export const SUBSCRIPTION_PLANS = Object.freeze(catalog.map((plan) => Object.freeze(plan)));

export function subscriptionPlan(months) {
  const value = Number(months ?? 1);
  return SUBSCRIPTION_PLANS.find((plan) => plan.months === value) || null;
}

export function publicSubscriptionPlans() {
  return SUBSCRIPTION_PLANS.map((plan) => ({ ...plan }));
}

export function subscriptionPeriodLabel(months) {
  return Number(months) === 12 ? '1 год' : Number(months) === 3 ? '3 месяца' : '1 месяц';
}
