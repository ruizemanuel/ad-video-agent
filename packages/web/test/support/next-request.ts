// The request a route handler gets from Next 16 when the app runs built (`next build`, then `next start`, or on
// Vercel). Next makes it with the NextRequest of its own ESM build, which its route template imports: another class
// than the one this code gets from `next/server`, so `instanceof NextRequest` is false for it. And as the routes leave
// `dynamic` unset, Next hands it over wrapped in a Proxy that notes which parts of the request are read
// (proxyNextRequest, in next/dist/server/route-modules/app-route/module.js): every read goes to the request itself, its
// methods are bound to it, and clone() answers another such Proxy. The Proxy has none of the request's private fields,
// so giving it to the Request constructor (as `new NextRequest(it)` does) throws.
import type { NextRequest } from 'next/server';
// @ts-expect-error -- Next ships no types for its ESM build; the class is the one `next/server` types.
import { NextRequest as NextsOwnRequest } from 'next/dist/esm/server/web/spec-extension/request.js';

const handlers: ProxyHandler<Request> = {
  get(target, prop) {
    if (prop === 'clone') return () => new Proxy(target.clone(), handlers);
    const value: unknown = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
};

/** A request to `url`, as Next hands it to a route handler in production. */
export function requestFromNext(url: string, init: RequestInit): NextRequest {
  const request = new (NextsOwnRequest as typeof NextRequest)(url, init as ConstructorParameters<typeof NextRequest>[1]);
  return new Proxy(request, handlers) as NextRequest;
}
