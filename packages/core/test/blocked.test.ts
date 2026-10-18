import { describe, expect, it } from 'vitest';
import { detectBlocked } from '../src/index';

describe('detectBlocked', () => {
  it('detects challenge pages', () => {
    expect(detectBlocked({ title: 'Just a moment...', text: '', status: 403 })).toBe(true);
    expect(detectBlocked({ title: 'Attention Required! | Cloudflare', text: 'x', status: 200 })).toBe(true);
    expect(detectBlocked({ title: 'Tiendita', text: 'Vendé por WhatsApp '.repeat(20), status: 200 })).toBe(false);
  });

  it('reads each phrase in the title, in any case', () => {
    for (const title of ['Access Denied', 'ACCESS DENIED - Akamai', 'Verify you are human', 'Please complete the CAPTCHA', 'Just a moment', 'Attention required']) {
      expect(detectBlocked({ title, text: 'Contenido '.repeat(50), status: 200 }), title).toBe(true);
    }
  });

  it('reads the phrases in the text of a short page, which is what a challenge is', () => {
    const text = 'example.com needs to review the security of your connection. Verify you are human by completing the action below.';
    expect(detectBlocked({ title: 'example.com', text, status: 200 })).toBe(true);
    expect(detectBlocked({ title: '', text: 'Access denied. Reference #18.5c5a5b68', status: 200 })).toBe(true);
  });

  it('does not take a real page that only mentions a captcha for a challenge', () => {
    const footer = 'This site is protected by reCAPTCHA and the Google Privacy Policy applies.';
    const page = `${'Cobrá a tus clientes por WhatsApp y llevá el control de tu caja. '.repeat(30)}${footer}`;
    expect(page.length).toBeGreaterThan(1000);
    expect(detectBlocked({ title: 'Cobrame', text: page, status: 200 })).toBe(false);
  });

  it('takes an error status with almost no text for a block, and only that', () => {
    expect(detectBlocked({ title: '', text: '', status: 403 })).toBe(true);
    expect(detectBlocked({ title: 'Error', text: 'x'.repeat(79), status: 503 })).toBe(true);
    // A real error page, or a bare page that loaded: not a challenge.
    expect(detectBlocked({ title: '404', text: 'x'.repeat(80), status: 404 })).toBe(false);
    expect(detectBlocked({ title: '', text: '', status: 200 })).toBe(false);
    expect(detectBlocked({ title: '', text: 'x'.repeat(79), status: 399 })).toBe(false);
  });
});
