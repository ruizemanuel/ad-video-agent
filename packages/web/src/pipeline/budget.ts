// The spending cap of an order (SPEND_CAP_PER_ORDER_USD): a call that is there to improve the video is made only if what
// it is expected to cost still fits under the cap. The calls a video cannot do without (the director, the first judge)
// are not held back by it.

/**
 * What the next calls are expected to cost, in USD: measured in the quality test (17/10/2026), rounded up. The director's,
 * for asking it again when its answer did not fit: US$ 0.18 to 0.34 on the sites measured on 5-6/11/2026.
 */
export const EST = { director: 0.35, patch: 0.1, judge: 0.03, review: 0.25, lyria: 0.08 } as const;

// Millionths of a dollar, as the store keeps costs: whole numbers, so 0.1 + 0.2 fits under 0.3.
const micros = (usd: number): number => Math.round(usd * 1e6);

/** Whether `estimate` more, on top of `spent`, stays within `cap`. */
export const canAfford = (spent: number, estimate: number, cap: number): boolean => micros(spent) + micros(estimate) <= micros(cap);
