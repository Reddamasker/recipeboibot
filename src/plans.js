const catalog = [
  { months: 1, priceRub: 159, fullPriceRub: 199, discountPercent: 20, savingRub: 40, pricePerMonthRub: 159 },
  { months: 3, priceRub: 319, fullPriceRub: 499, discountPercent: 36, savingRub: 180, pricePerMonthRub: 106.33 },
  { months: 12, priceRub: 599, fullPriceRub: 1499, discountPercent: 60, savingRub: 900, pricePerMonthRub: 49.92 }
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
