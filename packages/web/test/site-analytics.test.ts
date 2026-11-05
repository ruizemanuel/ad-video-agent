// The address a page view reports to Vercel Web Analytics: the page's path and nothing else of it. An order's page is
// its link, and the link is the credential, so no order's id leaves the page; nor does the query the form's link to
// MetaMask carries (what the person typed), nor a fragment.
import { describe, expect, it } from 'vitest';
import { analyticsUrl } from '../src/site/analytics';

const HOME = 'https://advideoagent.com/';

describe('analyticsUrl', () => {
  it('keeps the address of a page that holds nothing private', () => {
    expect(analyticsUrl(HOME)).toBe(HOME);
    expect(analyticsUrl('https://advideoagent.com/terms')).toBe('https://advideoagent.com/terms');
  });

  it('reports every order page as one, with no id', () => {
    expect(analyticsUrl('https://advideoagent.com/o/ord_46b5dxi36n4fx5iimwkk64rx')).toBe('https://advideoagent.com/o/[id]');
    expect(analyticsUrl('https://advideoagent.com/o/ord%5F46b5dxi36n4fx5iimwkk64rx/')).toBe('https://advideoagent.com/o/[id]/');
  });

  it('leaves out the query and the fragment', () => {
    expect(analyticsUrl('https://advideoagent.com/?url=cobrame.app&brief=Para+freelancers&page=cobrame.app%2Fapp#order')).toBe(HOME);
    expect(analyticsUrl('https://advideoagent.com/o/ord_46b5dxi36n4fx5iimwkk64rx?x=1#video')).toBe('https://advideoagent.com/o/[id]');
  });
});
