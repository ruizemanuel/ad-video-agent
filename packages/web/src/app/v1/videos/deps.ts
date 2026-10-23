// What POST /v1/videos needs from outside: the store, what the pre-check uses (a page fetcher and the site classifier)
// and the x402 facilitator. The service builds them from its settings; a test hands the route its doubles instead. On
// the fake adapters (AD_AGENT_ADAPTERS=fake, never in production) the page fetcher and the facilitator are doubles too,
// so the app runs locally with no site fetched and no payment sent to Celo's facilitator.
import type { FacilitatorClient } from '@x402/core/server';
import { getAdapters } from '../../../adapters';
import { FakeFacilitator } from '../../../adapters/fake/facilitator';
import { fakeFetchPage } from '../../../adapters/fake/fetch-page';
import { env } from '../../../env';
import type { OrderStore } from '../../../ports';
import { fetchPage } from '../../../precheck/fetch-page';
import type { PrecheckDeps } from '../../../precheck/precheck';

export type VideosDeps = {
  store: OrderStore;
  llm: PrecheckDeps['llm'];
  fetchPage: PrecheckDeps['fetchPage'];
  /** Celo's facilitator when left out. */
  facilitator?: FacilitatorClient;
};

let given: VideosDeps | undefined;
let built: Promise<VideosDeps> | undefined;

/** For tests: the doubles the route runs on from now on. `undefined` goes back to the service's own. */
export function setVideosDeps(deps: VideosDeps | undefined): void {
  given = deps;
}

async function build(): Promise<VideosDeps> {
  const { store, llm } = await getAdapters();
  if (env().AD_AGENT_ADAPTERS === 'fake') return { store, llm, fetchPage: fakeFetchPage, facilitator: new FakeFacilitator() };
  return { store, llm, fetchPage: (url: string) => fetchPage(url) };
}

/** The same object every time until a test changes it, so the route can keep what it builds from it. */
export async function videosDeps(): Promise<VideosDeps> {
  if (given !== undefined) return given;
  built ??= build();
  return built;
}
