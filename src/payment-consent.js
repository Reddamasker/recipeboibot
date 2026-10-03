import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const PAYMENT_CONSENT_VERSION = '2026-10-03-v1';
export const PAYMENT_CONSENT_TEXT = 'Я даю согласие на регулярные списания, на обработку персональных данных и принимаю условия публичной оферты.';
const document = name => {
  const content = readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
  return { url: `/${name}`, sha256: createHash('sha256').update(content).digest('hex'), content };
};
export const paymentConsentDocuments = { offer: document('offer.html'), privacy: document('privacy.html') };
export function paymentConsentTerms(amountKopeks, months) {
  const period = months === 1 ? '1 календарный месяц' : months === 3 ? '3 календарных месяца' : '12 календарных месяцев';
  return `Доступ к сервису «Твои рецепты Плюс». ${amountKopeks / 100} ₽ за ${period}. Повторное списание за 24 часа до окончания оплаченного периода. Отмена в разделе подписки или по адресу damasker83@gmail.com до даты списания. Уже оплаченный доступ сохраняется.`;
}
