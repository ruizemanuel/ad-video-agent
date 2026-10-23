// The home: what the service makes, two real examples, what an order includes and costs, how it works, and the same
// service as an API for agents. The order form goes in the order section.
import type { ReactNode } from 'react';
import { env } from '../env';
import { formatPrice } from '../payments/x402';
import { AGENTS, HOME } from '../site/copy';
import styles from './page.module.css';

// The price comes from the settings, read when a request comes in: building the app needs none of them.
export const dynamic = 'force-dynamic';

/** Two videos the service made, each from nothing but a site's URL (in public/examples). */
const EXAMPLES: { site: string; file: string; seconds: number; note?: string }[] = [
  { site: 'cobrame.app', file: 'cobrame', seconds: 19 },
  { site: 'celo.org', file: 'celo', seconds: 20, note: HOME.examples.publicSite },
];

/** A text with the parts between backticks set as code. */
const withCode = (text: string): ReactNode[] =>
  text.split('`').map((part, index) => (index % 2 === 1 ? <code key={index}>{part}</code> : part));

export default function HomePage() {
  const price = `${formatPrice(env().PRICE_ATOMIC)} USDT or USDC`;
  return (
    <main className={styles.page}>
      <div className={styles.hero}>
        <div className={styles.intro}>
          <h1 className={styles.title}>
            {HOME.title[0]}
            <br />
            {HOME.title[1]}
          </h1>
          <p className={styles.lede}>{HOME.lede}</p>
        </div>

        <section id="examples" className={styles.examples} aria-labelledby="examples-title">
          <h2 id="examples-title" className={styles.examplesTitle}>
            {HOME.examples.title}
          </h2>
          <div className={styles.phones}>
            {EXAMPLES.map(({ site, file, seconds, note }) => (
              <figure key={file} className={styles.example}>
                <div className={styles.phone}>
                  <video
                    src={`/examples/${file}.mp4`}
                    poster={`/examples/${file}.jpg`}
                    aria-label={`The video made from ${site}`}
                    muted
                    playsInline
                    loop
                    controls
                    preload="none"
                  />
                </div>
                <figcaption className={styles.caption}>
                  <span className={styles.site}>{site}</span> <span>{seconds} s</span>
                  {note === undefined ? null : <span className={styles.note}>{note}</span>}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>

        <div className={styles.buy}>
          <div className={styles.included}>
            <div className={styles.includedHead}>
              <h2>{HOME.included.title}</h2>
              <p className={styles.price}>
                <strong>{price}</strong> {HOME.included.perVideo}
              </p>
            </div>
            <ul className={styles.items}>
              {HOME.included.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>

          <section id="order" className={styles.order} aria-labelledby="order-title">
            <h2 id="order-title">{HOME.order.title}</h2>
          </section>

          <p className={styles.fine}>
            {HOME.finePrint} {HOME.terms.before}
            <a href="/terms">{HOME.terms.link}</a>
            {HOME.terms.after}
          </p>
        </div>
      </div>

      <section id="how" className={styles.section} aria-labelledby="how-title">
        <h2 id="how-title" className={styles.sectionTitle}>
          {HOME.how.title}
        </h2>
        <ol className={styles.steps}>
          {HOME.how.steps.map(({ title, text }) => (
            <li key={title}>
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="agents" className={styles.section} aria-labelledby="agents-title">
        <div>
          <h2 id="agents-title" className={styles.sectionTitle}>
            {AGENTS.title}
          </h2>
          <p className={styles.sectionLede}>{AGENTS.lede}</p>
        </div>
        <div className={styles.api}>
          <ol className={styles.apiSteps}>
            {AGENTS.steps.map(({ title, text }) => (
              <li key={title}>
                <h3>{title}</h3>
                <p>{withCode(text)}</p>
              </li>
            ))}
          </ol>
          <p className={styles.exampleIntro}>{AGENTS.example.intro}</p>
          <pre className={styles.code}>
            <code>{AGENTS.example.command}</code>
          </pre>
        </div>
      </section>
    </main>
  );
}
