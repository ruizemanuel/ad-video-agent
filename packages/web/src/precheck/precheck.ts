// The free check that runs before a client is asked to pay: the address answers, it is a real page and not a wall,
// and the site may be made into an ad. It also says whether the site shows little of the product, which is a
// warning to the client and never a reason to refuse. It costs one fetch and, for a site it has not seen in the last
// 24 hours, one call to a small model.
import { createHash } from 'node:crypto';
import { detectBlocked, findDemoLinks } from '@app/core';
import type { LlmPort, OrderStore, PrecheckResult } from '../ports';
import { analyzeHtml } from './analyze';
import { FetchFailed, type FetchedPage } from './fetch-page';
import { UrlRejected } from './url-guard';

export type PrecheckDeps = {
  store: Pick<OrderStore, 'getPrecheck' | 'putPrecheck' | 'addCost'>;
  llm: Pick<LlmPort, 'classifySite'>;
  fetchPage: (url: string) => Promise<FetchedPage>;
};

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

  // Only a page that loaded well is judged, and only what the model judged is kept: it is what costs money.
  const verdict = await deps.llm.classifySite({
    url: page.finalUrl.slice(0, CLASSIFIER_URL_CHARS),
    title: analysis.title.slice(0, CLASSIFIER_TITLE_CHARS),
    text: analysis.text.slice(0, CLASSIFIER_TEXT_CHARS),
  });
  await deps.store.addCost('precheck', 'llm:classify', verdict.usd, 'card');
  const result: PrecheckResult = verdict.admissible
    ? { ok: true, thin: analysis.thin, demoLinks: findDemoLinks(analysis.anchors, page.finalUrl) }
    : fail('inadmissible', verdict.reason);
  await deps.store.putPrecheck(key, result);
  return result;
}
