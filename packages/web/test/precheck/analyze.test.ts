import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeHtml } from '../../src/precheck/analyze';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
// The pages the fake page fetcher serves, which these tests read too.
const fakePage = (name: string): string => readFileSync(new URL(`../../src/adapters/fake/pages/${name}`, import.meta.url), 'utf8');
const U = 'https://tiendita.example/';
const thinHtml = fakePage('thin.html');
const loginHtml = fakePage('login.html');
const spaShell = fixture('spa-shell.html');
const richHtml = fakePage('rich.html');

const words = (n: number): string => Array.from({ length: n }, (_, i) => `palabra${i}`).join(' ');
const headings = (n: number): string => Array.from({ length: n }, (_, i) => `<h2>Título ${i}</h2>`).join('');
/** A page with a given number of words in the body (the headings count too) and of headings. */
const page = (wordCount: number, headingCount: number, extra = ''): string => {
  const headingWords = headingCount * 2;
  return `<html><head><title>T</title></head><body>${headings(headingCount)}<p>${words(wordCount - headingWords)}</p>${extra}</body></html>`;
};

describe('analyzeHtml', () => {
  it('marks a thin site, a login wall and an SPA shell', () => {
    expect(analyzeHtml(thinHtml, U).thin).toBe(true);
    expect(analyzeHtml(loginHtml, U).loginWall).toBe(true);
    expect(analyzeHtml(spaShell, U).thin).toBe(null);
  });

  it('reads a real page: its title, what a visitor reads, its headings and its links', () => {
    const analysis = analyzeHtml(richHtml, U);
    expect(analysis.title).toBe('Cobrame & cobrá a tiempo');
    expect(analysis.headings).toBe(4);
    expect(analysis.anchors).toEqual([
      { href: '/', text: 'Inicio' },
      { href: '/precios', text: 'Precios' },
      { href: '/demo', text: 'Ver demo' },
      { href: 'https://app.tiendita.example/login', text: 'Ingresar' },
      { href: '/empezar', text: 'Empezar gratis' },
      { href: '/demo#tablero', text: 'el tablero de demostración' },
      { href: '/terminos', text: 'Términos' },
      { href: 'mailto:hola@tiendita.example', text: 'Escribinos' },
    ]);
    expect(analysis.text).toContain('Cobrá lo que te deben, sin perseguir a nadie');
    expect(analysis.text).toContain('hasta que el cliente paga.');
    expect(analysis.text).toContain('Ver demo');
    // Not what a visitor reads: the head, the scripts, the styles, the comments, the drawings, the noscript.
    for (const hidden of ['descripción', 'analytics', 'evento sin importancia', 'padding', 'Navegación principal', 'dentro de un dibujo', 'Activá JavaScript', 'Cobrame &']) {
      expect(analysis.text, hidden).not.toContain(hidden);
    }
    expect(analysis.words).toBeGreaterThanOrEqual(150);
    expect(analysis.loginWall).toBe(false);
    expect(analysis.thin).toBe(false);
  });

  it('counts the words of the text, and only the words', () => {
    const html = '<body><p>uno dos tres</p> — <p>cuatro&nbsp;cinco</p><script>seis siete</script><style>ocho nueve</style><!-- diez --><p>11 | ¡doce!</p></body>';
    const analysis = analyzeHtml(html, U);
    expect(analysis.text).toBe('uno dos tres — cuatro cinco 11 | ¡doce!');
    expect(analysis.words).toBe(7);
  });

  it('keeps words apart across tags and collapses the white space', () => {
    expect(analyzeHtml('<body><b>uno</b><i>dos</i>\n\n   <span>tres</span></body>', U).text).toBe('uno dos tres');
  });

  it('decodes the usual entities, and leaves what it does not know', () => {
    const analysis = analyzeHtml('<title> Pan &amp; Co &#8211; &#x41;&#65; </title><body>&lt;3 &quot;hola&quot; &apos;ché&apos; &unknown; &constructor; &#99999999; &amp;amp;</body>', U);
    expect(analysis.title).toBe('Pan & Co – AA');
    expect(analysis.text).toBe('<3 "hola" \'ché\' &unknown; &constructor; &#99999999; &amp;');
  });

  it('has an empty title when there is none', () => {
    expect(analyzeHtml('<body>hola</body>', U).title).toBe('');
  });

  describe('thin', () => {
    it('is unknown (null) under 30 words, which is what a page that builds itself in the browser looks like', () => {
      expect(analyzeHtml(page(29, 3), U).thin).toBe(null);
      expect(analyzeHtml('', U).thin).toBe(null);
      // The two words of the link count too.
      expect(analyzeHtml(page(27, 0, '<a href="/demo">Ver demo</a>'), U).thin).toBe(null);
    });

    it('is true with fewer than 3 headings or fewer than 150 words, and no demo link', () => {
      expect(analyzeHtml(page(30, 0), U).thin).toBe(true);
      expect(analyzeHtml(page(300, 2), U).thin).toBe(true);
      expect(analyzeHtml(page(149, 3), U).thin).toBe(true);
    });

    it('is false from 3 headings and 150 words', () => {
      expect(analyzeHtml(page(150, 3), U).thin).toBe(false);
      expect(analyzeHtml(page(400, 8), U).thin).toBe(false);
    });

    it('is false when the page links to a demo, however little it says', () => {
      expect(analyzeHtml(page(40, 0, '<a href="/demo">Ver demo</a>'), U).thin).toBe(false);
      expect(analyzeHtml(thinHtml.replace('</body>', '<a href="https://app.tiendita.example/try">Probar</a></body>'), U).thin).toBe(false);
      // A demo of another site, or one behind a login, is no help to the video.
      expect(analyzeHtml(page(40, 0, '<a href="https://otro.com/demo">Demo</a><a href="/login">Probar</a>'), U).thin).toBe(true);
    });
  });

  describe('loginWall', () => {
    it('is true when there is a password field and not much else', () => {
      expect(analyzeHtml(page(40, 1, '<input type="password">'), U).loginWall).toBe(true);
      expect(analyzeHtml(page(119, 1, "<input name=pw TYPE='Password'>"), U).loginWall).toBe(true);
    });

    it('is false for a rich page that has a sign-in box somewhere', () => {
      expect(analyzeHtml(page(120, 1, '<input type="password">'), U).loginWall).toBe(false);
      expect(analyzeHtml(page(40, 1, '<input type="text" placeholder="password">'), U).loginWall).toBe(false);
    });

    it('is true when the page it ended on is a login path, whatever it says', () => {
      for (const path of ['/login', '/Login/', '/signin?next=%2F', '/users/sign-in', '/oauth/authorize', '/auth', '/es/auth/callback', '/login.php']) {
        expect(analyzeHtml(richHtml, `https://tiendita.example${path}`).loginWall, path).toBe(true);
      }
      for (const path of ['/', '/autores', '/author/ana', '/precios', '/blog?tag=login']) {
        expect(analyzeHtml(richHtml, `https://tiendita.example${path}`).loginWall, path).toBe(false);
      }
    });

    it('does not fail on an address that is not one', () => {
      expect(analyzeHtml(richHtml, 'not a url').loginWall).toBe(false);
    });
  });

  describe('the parts of HTML that are not tidy', () => {
    it('reads tags in any case and the three ways to write an attribute', () => {
      const html = `<BODY><H2>Hola</H2><A HREF="/uno">Uno</A><a href='/dos'>Dos</a><a href=/tres>Tres</a><a HREF = "/cuatro" >Cuatro</a></BODY>`;
      const analysis = analyzeHtml(html, U);
      expect(analysis.headings).toBe(1);
      expect(analysis.anchors.map((a) => a.href)).toEqual(['/uno', '/dos', '/tres', '/cuatro']);
    });

    it('skips links without an address, and decodes the address and the text of the others', () => {
      const html = '<a name="top">ancla</a><a href="">vacío</a><a href="  ">en blanco</a><a href="/buscar?a=1&amp;b=2">Buscar &amp; <b>comprar</b></a>';
      expect(analyzeHtml(html, U).anchors).toEqual([{ href: '/buscar?a=1&b=2', text: 'Buscar & comprar' }]);
    });

    it('does not end a tag at a ">" inside a quoted attribute', () => {
      const html = '<a title="a > b" href="/demo">Ver demo</a><p data-x=\'1 > 0\'>texto</p>';
      const analysis = analyzeHtml(html, U);
      expect(analysis.anchors).toEqual([{ href: '/demo', text: 'Ver demo' }]);
      expect(analysis.text).toBe('Ver demo texto');
    });

    it('takes a "<" that opens no tag for text', () => {
      expect(analyzeHtml('<p>si a < b y 3<4 entonces</p>', U).text).toBe('si a < b y 3<4 entonces');
    });

    it('ends what was left open at the end of the page', () => {
      const analysis = analyzeHtml('<h1>Sin cerrar <a href="/demo">Demo', U);
      expect(analysis.headings).toBe(1);
      expect(analysis.anchors).toEqual([{ href: '/demo', text: 'Demo' }]);
      // A script that never closes swallows the rest, as in a browser.
      expect(analyzeHtml('<p>visible</p><script>var a = "<p>invisible</p>";', U).text).toBe('visible');
      // So does a tag whose last quote is missing.
      expect(analyzeHtml('<p>visible</p><a href="/x>invisible', U).text).toBe('visible');
    });

    it('ignores a heading with nothing in it', () => {
      expect(analyzeHtml('<h1></h1><h2>  </h2><h3><img alt="x"></h3><h2>Con texto</h2>', U).headings).toBe(1);
    });

    it('closes a heading or a link that is followed by another, as a browser would', () => {
      const analysis = analyzeHtml('<h2>Uno<h2>Dos</h2><a href="/a">A<a href="/b">B</a>', U);
      expect(analysis.headings).toBe(2);
      expect(analysis.anchors).toEqual([
        { href: '/a', text: 'A' },
        { href: '/b', text: 'B' },
      ]);
    });

    it('reads a page of 2 MB made to be slow in a fraction of a second', () => {
      const started = Date.now();
      for (const piece of ['<script>', '<a href="', '<!--', '<h1>', '<a ', '<style', '<title>']) {
        analyzeHtml(piece.repeat(Math.ceil((2 * 1024 * 1024) / piece.length)), U);
      }
      expect(Date.now() - started).toBeLessThan(3000);
    });
  });
});
