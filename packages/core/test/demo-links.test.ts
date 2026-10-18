import { describe, expect, it } from 'vitest';
import { findDemoLinks } from '../src/index';

const BASE = 'https://tiendita.example';

describe('findDemoLinks', () => {
  it('keeps same-site demo links and drops login/signup and other sites', () =>
    expect(
      findDemoLinks(
        [
          { href: '/demo', text: 'Ver demo' },
          { href: 'https://app.tiendita.example/try', text: 'Probar' },
          { href: '/login', text: 'Ingresar' },
          { href: 'https://otro.com/demo', text: 'demo' },
        ],
        BASE,
      ),
    ).toEqual(['https://tiendita.example/demo', 'https://app.tiendita.example/try']));

  it('stops at max, in the order of the page (2 by default)', () => {
    const anchors = [
      { href: '/demo-1', text: 'Demo uno' },
      { href: '/demo-2', text: 'Demo dos' },
      { href: '/demo-3', text: 'Demo tres' },
    ];
    expect(findDemoLinks(anchors, BASE)).toEqual(['https://tiendita.example/demo-1', 'https://tiendita.example/demo-2']);
    expect(findDemoLinks(anchors, BASE, 1)).toEqual(['https://tiendita.example/demo-1']);
    expect(findDemoLinks(anchors, BASE, 3)).toHaveLength(3);
  });

  it('matches the keyword in the text or in the address, as a whole word and in any case', () => {
    expect(findDemoLinks([{ href: '/ejemplo-de-uso', text: 'Ver más' }], BASE)).toEqual(['https://tiendita.example/ejemplo-de-uso']);
    expect(findDemoLinks([{ href: '/p/7', text: 'Probar GRATIS' }], BASE)).toEqual(['https://tiendita.example/p/7']);
    expect(findDemoLinks([{ href: 'https://demo.tiendita.example/', text: 'Entrar' }], BASE)).toEqual(['https://demo.tiendita.example/']);
    for (const [href, text] of [
      ['/contacto', 'Contacto'],
      ['/demostracion', 'Demostración'],
      ['/blog', 'Blog'],
    ] as const) {
      expect(findDemoLinks([{ href, text }], BASE)).toEqual([]);
    }
  });

  it('does not read the keyword in the name of the site itself', () => {
    // Every address on example.com has "example" in it; that does not make it a demo.
    expect(findDemoLinks([{ href: '/contacto', text: 'Contacto' }, { href: 'https://www.example.com/precios', text: 'Precios' }], 'https://example.com')).toEqual([]);
    expect(findDemoLinks([{ href: '/demo', text: 'Demo' }], 'https://example.com')).toEqual(['https://example.com/demo']);
  });

  it('refuses a link that is also about an account', () => {
    expect(
      findDemoLinks(
        [
          { href: '/demo/signup', text: 'Probar' },
          { href: '/demo', text: 'Demo: registrate con register' },
          { href: '/auth/demo', text: 'Demo' },
        ],
        BASE,
      ),
    ).toEqual([]);
  });

  it('takes the www host, a subdomain and the bare domain for one site', () => {
    const anchors = [
      { href: 'https://tiendita.example/demo', text: 'Demo' },
      { href: 'https://docs.tiendita.example/playground', text: 'Playground' },
    ];
    expect(findDemoLinks(anchors, 'https://www.tiendita.example/')).toEqual(['https://tiendita.example/demo', 'https://docs.tiendita.example/playground']);
    expect(findDemoLinks(anchors, 'https://tiendita.example.evil.com/')).toEqual([]);
  });

  it('knows that .com.ar (or .co.uk) is not a site of its own', () => {
    const anchors = [
      { href: 'https://otra.com.ar/demo', text: 'Demo' },
      { href: 'https://app.tienda.com.ar/demo', text: 'Demo' },
      { href: 'https://otra.co.uk/demo', text: 'Demo' },
    ];
    expect(findDemoLinks(anchors, 'https://www.tienda.com.ar')).toEqual(['https://app.tienda.com.ar/demo']);
    expect(findDemoLinks(anchors, 'https://shop.otra.co.uk')).toEqual(['https://otra.co.uk/demo']);
  });

  it('leaves out the page itself, repeated links, other schemes and addresses that do not parse', () => {
    expect(
      findDemoLinks(
        [
          { href: '#demo', text: 'Ver demo' },
          { href: '/demo#precios', text: 'Demo' },
          { href: '/demo', text: 'Demo (pie de página)' },
          { href: 'mailto:demo@tiendita.example', text: 'demo' },
          { href: 'javascript:openDemo()', text: 'demo' },
          { href: 'https://', text: 'demo' },
          { href: '', text: 'demo' },
        ],
        `${BASE}/inicio`,
      ),
    ).toEqual(['https://tiendita.example/demo']);
    expect(findDemoLinks([{ href: '/demo', text: 'Demo' }], `${BASE}/demo#arriba`)).toEqual([]);
  });

  it('returns nothing when the base address is not an address', () => {
    expect(findDemoLinks([{ href: '/demo', text: 'Demo' }], 'not a url')).toEqual([]);
    expect(findDemoLinks([], BASE)).toEqual([]);
  });
});
