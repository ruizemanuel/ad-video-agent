import { describe, expect, it } from 'vitest';
import { COOKIE_ACCEPT, COOKIE_CONTEXT } from '../src/capture/page';

describe('the cookie banner buttons the capture presses', () => {
  it.each(['Aceptar', 'Accept', 'Accept all', 'Aceitar', 'Alle akzeptieren', 'Tout accepter', 'Agree', 'Got it', 'OK'])('accepts "%s"', (label) => {
    expect(COOKIE_ACCEPT.test(label)).toBe(true);
  });

  it.each(['ACCEPT ALL', 'ok', 'Aceitar todos', 'Aceptar todas', 'Accept cookies', 'Alle Akzeptieren'])('does not mind the case or the usual variants: "%s"', (label) => {
    expect(COOKIE_ACCEPT.test(label)).toBe(true);
  });

  // A button that says no, that opens a menu or that is not a button about cookies at all must be left alone.
  it.each(['Reject all', 'Alle ablehnen', 'Tout refuser', 'Rechazar', 'Manage preferences', 'Learn more', 'Accept the offer and pay now', 'Sign up', 'Ok, show me the policy'])(
    'leaves "%s" alone',
    (label) => {
      expect(COOKIE_ACCEPT.test(label)).toBe(false);
    },
  );

  it.each(['We use cookies to improve your experience', 'Usamos cookies', 'Wir verwenden Cookies', 'Nous utilisons des cookies', 'Política de privacidad', 'Datenschutz', 'GDPR'])(
    'reads "%s" as talk about cookies or privacy',
    (text) => {
      expect(COOKIE_CONTEXT.test(text)).toBe(true);
    },
  );

  it('does not take any text for talk about cookies', () => {
    expect(COOKIE_CONTEXT.test('Start your free trial')).toBe(false);
  });
});
