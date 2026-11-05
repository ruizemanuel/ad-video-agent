// What a page view tells Vercel Web Analytics of the page: its path and nothing else of it. An order's page is its
// link, and the link is the credential, so no order's id leaves the page. Nor does the query (the form's link to
// MetaMask carries what the person typed) or a fragment. Vercel's script sends the route apart (`/o/[id]`), and the
// referrer only when it is another site's.

/** An order's page, by the first segment after `/o/`. */
const ORDER_PAGE = /^\/o\/[^/]+/;

/** The address a page view reports: the page's origin and path, an order's page as `/o/[id]`. */
export function analyticsUrl(url: string): string {
  const { origin, pathname } = new URL(url);
  return `${origin}${pathname.replace(ORDER_PAGE, '/o/[id]')}`;
}
