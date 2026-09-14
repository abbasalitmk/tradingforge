/**
 * Rupees represented as integer paise.
 *
 * Floating-point money is a real hazard here: position sizing divides by a
 * stop distance, and 0.1 + 0.2 !== 0.3 compounds through qty calculations and
 * P&L accumulation. Everything monetary is an integer until it is displayed.
 */
export type Paise = number & { readonly __brand: 'Paise' };

export const paise = (n: number): Paise => Math.round(n) as Paise;

/** Convert a rupee figure from an API response into paise. */
export const rupeesToPaise = (rupees: number): Paise => Math.round(rupees * 100) as Paise;

export const paiseToRupees = (p: Paise): number => p / 100;

export const addP = (a: Paise, b: Paise): Paise => (a + b) as Paise;
export const subP = (a: Paise, b: Paise): Paise => (a - b) as Paise;
export const mulP = (a: Paise, qty: number): Paise => Math.round(a * qty) as Paise;

/** Percentage of an amount, rounded to the nearest paisa. */
export const pctOf = (amount: Paise, pct: number): Paise =>
  Math.round((amount * pct) / 100) as Paise;

export const formatINR = (p: Paise): string =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(paiseToRupees(p));
