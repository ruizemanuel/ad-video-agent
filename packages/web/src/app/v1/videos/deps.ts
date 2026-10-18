// What POST /v1/videos needs from outside: the store, what the pre-check uses (a page fetcher and the site classifier)
// and the x402 facilitator. The service builds them from its settings; a test hands the route its doubles instead.
import type { FacilitatorClient } from '@x402/core/server';
import { getAdapters } from '../../../adapters';
import type { LlmPort, OrderStore } from '../../../ports';
import { fetchPage } from '../../../precheck/fetch-page';
import type { PrecheckDeps } from '../../../precheck/precheck';

export type VideosDeps = {
  store: OrderStore;
  llm: PrecheckDeps['llm'];
  fetchPage: PrecheckDeps['fetchPage'];
  /** Celo's facilitator when left out. */
  facilitator?: FacilitatorClient;
};

// There is no adapter for the language models yet. Until there is, the route refuses to quote rather than skip the
// check that keeps scams and adult sites out.
const noClassifier: Pick<LlmPort, 'classifySite'> = {
  classifySite: async () => {
    throw new Error('The site classifier is not configured yet.');
  },
};

let given: VideosDeps | undefined;
let built: Promise<VideosDeps> | undefined;

/** For tests: the doubles the route runs on from now on. `undefined` goes back to the service's own. */
export function setVideosDeps(deps: VideosDeps | undefined): void {
  given = deps;
}

/** The same object every time until a test changes it, so the route can keep what it builds from it. */
export async function videosDeps(): Promise<VideosDeps> {
  if (given !== undefined) return given;
  built ??= getAdapters().then(({ store }) => ({ store, llm: noClassifier, fetchPage: (url: string) => fetchPage(url) }));
  return built;
}
