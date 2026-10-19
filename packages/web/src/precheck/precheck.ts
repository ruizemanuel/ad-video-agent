// The free check that runs before a client is asked to pay: the address answers, it is a real page and not a wall,
// and the site may be made into an ad. It also says whether the site shows little of the product, which is a
// warning to the client and never a reason to refuse. It costs one fetch and, for a site it has not seen in the last
// 24 hours, one call to a small model: anyone can ask for it, so what those calls cost in a UTC day is capped.
import { createHash } from 'node:crypto';
import { detectBlocked, findDemoLinks } from '@app/core';
import { ModelOutputInvalid, type LlmPort, type OrderStore, type PrecheckResult, type SiteClassification } from '../ports';
import { analyzeHtml } from './analyze';
import { FetchFailed, type FetchedPage } from './fetch-page';
import { UrlRejected } from './url-guard';

export type PrecheckDeps = {
  store: Pick<OrderStore, 'getPrecheck' | 'putPrecheck' | 'addCost' | 'precheckSpendSince'>;
  llm: Pick<LlmPort, 'classifySite'>;
  fetchPage: (url: string) => Promise<FetchedPage>;
  /** PRECHECK_DAILY_CAP_USD: what the classifier calls of the checks may cost in a UTC day, every check together. */
  dailyCapUsd: number;
};

/**
 * What the checks cost today has reached the daily cap: the model is not asked, and nothing is kept. `retryAfterSeconds`
 * is how long until the next UTC day, when the cap starts again.
 */
export class PrecheckCapReached extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('The pre-checks have reached their daily cost cap.');
    this.name = 'PrecheckCapReached';
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const startOfUtcDay = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

/** How long an answer is kept. */
export const PRECHECK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// How much the classifier is sent. Every part is bounded, not only the text: the title and the address of a page
// (after a redirect) are the site's to make as long as it likes, and this runs for anyone, before any payment.
const CLASSIFIER_TEXT_CHARS = 4000;
const CLASSIFIER_TITLE_CHARS = 300;
const CLASSIFIER_URL_CHARS = 2048;

const fail = (code: Extract<PrecheckResult, { ok: false }>['code'], reason: string): PrecheckResult => ({ ok: false, code, reason });

export async function precheck(url: string, deps: PrecheckDeps): Promise<PrecheckResult> {
  let address: URL;
  try {
    address = new URL(url);
  } catch {
    return fail('invalid_url', 'That is not a valid web address.');
  }
  // The same page, written another way, is one site: the part after "#" never reaches the server.
  address.hash = '';
  const key = createHash('sha256').update(address.href).digest('hex');

  const cached = await deps.store.getPrecheck(key, PRECHECK_MAX_AGE_MS);
  if (cached !== null) return cached;

  let page: FetchedPage;
  try {
    page = await deps.fetchPage(address.href);
  } catch (error) {
    // These are not kept: the next try may find the site up, or its address fixed.
    if (error instanceof UrlRejected) return fail(error.code === 'unresolvable' ? 'unreachable' : 'invalid_url', error.message);
    if (error instanceof FetchFailed) return fail(error.code === 'not_html' ? 'invalid_url' : 'unreachable', error.message);
    throw error;
  }

  const analysis = analyzeHtml(page.html, page.finalUrl);
  if (detectBlocked({ title: analysis.title, text: analysis.text, status: page.status })) {
    return fail('blocked', 'The site shows a verification or access-denied page to automated visitors, so a video cannot be made from it.');
  }
  if (page.status < 200 || page.status >= 300) return fail('unreachable', `The site answered with an error (HTTP ${page.status}).`);
  if (analysis.loginWall) return fail('login_wall', 'The page asks for a login. Send the address of a public page that anyone can open.');

  // Only a page that loaded well is judged, and only what the model judged is kept: it is what costs money. An answer
  // that did not fit was billed too, so it is recorded before it goes up (the route says the check is unavailable).
  // Checked right before the call: several checks at once may all pass it, by a call each at most.
  const now = new Date();
  const today = startOfUtcDay(now);
  if ((await deps.store.precheckSpendSince(today)) >= deps.dailyCapUsd) {
    throw new PrecheckCapReached(Math.ceil((today.getTime() + DAY_MS - now.getTime()) / 1000));
  }
  let verdict: SiteClassification;
  try {
    verdict = await deps.llm.classifySite({
      url: page.finalUrl.slice(0, CLASSIFIER_URL_CHARS),
      title: analysis.title.slice(0, CLASSIFIER_TITLE_CHARS),
      text: analysis.text.slice(0, CLASSIFIER_TEXT_CHARS),
    });
  } catch (error) {
    if (error instanceof ModelOutputInvalid) await deps.store.addCost('precheck', 'llm:classify', error.usd, 'card');
    throw error;
  }
  await deps.store.addCost('precheck', 'llm:classify', verdict.usd, 'card');
  const result: PrecheckResult = verdict.admissible
    ? { ok: true, thin: analysis.thin, demoLinks: findDemoLinks(analysis.anchors, page.finalUrl) }
    : fail('inadmissible', verdict.reason);
  await deps.store.putPrecheck(key, result);
  return result;
}
