'use client';
// What the order page shows once the order is delivered: the video, playing on the page; the downloads and the post on X;
// each line of the video beside the words on the site it comes from; where the music comes from; and whether the person
// posted it. Everything comes from the order's status. An order delivered before the status carried its claims has no
// sources to show, and one without music says nothing of music.
import { useEffect, useId, useRef, useState } from 'react';
import type { StatusJson } from '../payments/orders';
import { ORDER_PAGE } from './copy';
import styles from './DeliveredView.module.css';
import { FeedbackForm } from './FeedbackForm';
import { xIntentUrl } from './share';

export type DeliveredViewProps = {
  /** The status of a delivered order. */
  status: StatusJson;
  /** The host of the site the video is made from. */
  site: string;
  /** The site's address, whole, as the order was placed with it. */
  siteUrl: string;
  /** The first characters of the order's number, after `ord_`. */
  shortId: string;
};

type DeliveredFile = NonNullable<StatusJson['files']>[number];

const isMuted = ({ name }: DeliveredFile): boolean => name.endsWith('-muted.mp4');

/** Where a quote is from, as a link: only a page on the web is one. */
function pageOf(address: string): { href: string; label: string } | null {
  try {
    const url = new URL(address);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return { href: url.href, label: `${url.host}${url.pathname === '/' ? '' : url.pathname}` };
  } catch {
    return null;
  }
}

export function DeliveredView({ status, site, siteUrl, shortId }: DeliveredViewProps) {
  const copy = ORDER_PAGE.delivered;
  const claims = status.claims ?? [];
  const sourcesTitle = useId();
  const mp4s = (status.files ?? []).filter(({ name }) => name.endsWith('.mp4'));
  const muted = mp4s.find(isMuted);
  const withMusic = mp4s.find((file) => !isMuted(file));
  // The video that plays and is the download: the one with music, or the muted one when it is the only video. The muted
  // version is a second button only when there is a second video to give.
  const video = withMusic ?? muted;
  const mutedVersion = withMusic === undefined ? undefined : muted;

  // The length is the video's own, read once it has loaded its metadata; until then the line says nothing of it.
  const player = useRef<HTMLVideoElement>(null);
  const [seconds, setSeconds] = useState<number | null>(null);
  const readLength = (element: HTMLVideoElement): void => {
    if (Number.isFinite(element.duration)) setSeconds(element.duration);
  };
  // The video may have loaded its metadata before the page was running here: its event is gone, its state is not.
  useEffect(() => {
    const element = player.current;
    if (element !== null && element.readyState >= HTMLMediaElement.HAVE_METADATA) readLength(element);
  }, [video?.url]);

  return (
    <div className={styles.layout}>
      <div className={styles.head}>
        <p className={styles.which}>{ORDER_PAGE.which(site, shortId)}</p>
        <h1 className={styles.title}>{copy.title}</h1>
      </div>

      {video !== undefined && (
        <figure className={styles.player}>
          <div className={styles.phone}>
            <video ref={player} src={video.url} aria-label={copy.player(site)} controls playsInline preload="metadata" onLoadedMetadata={(event) => readLength(event.currentTarget)} />
          </div>
          <figcaption className={styles.caption}>
            <span className={styles.site}>{site}</span>
            {` · ${copy.size}`}
            {seconds !== null && ` · ${copy.length(seconds)}`}
          </figcaption>
        </figure>
      )}

      <div className={styles.more}>
        {video !== undefined && (
          <>
            <div className={styles.actions}>
              <a className={styles.primary} href={video.url} download={video.name}>
                {copy.actions.download}
              </a>
              {mutedVersion !== undefined && (
                <a className={styles.ghost} href={mutedVersion.url} download={mutedVersion.name}>
                  {copy.actions.muted}
                </a>
              )}
              <a className={styles.ghost} href={xIntentUrl(claims[0]?.onScreen ?? site, siteUrl)} target="_blank" rel="noopener noreferrer">
                {copy.actions.post}
              </a>
            </div>
            <p className={styles.fine}>{copy.postNote}</p>
          </>
        )}

        <div className={styles.cards}>
          <FeedbackForm orderId={status.id} saved={status.feedback} />
        </div>

        {claims.length > 0 && (
          <section className={styles.sources} aria-labelledby={sourcesTitle}>
            <h2 id={sourcesTitle} className={styles.eyebrow}>
              {copy.sources.title}
            </h2>
            <ul className={styles.claims}>
              {claims.map(({ onScreen, quote, url, section }, index) => {
                const page = pageOf(url);
                return (
                  <li key={index} className={styles.claim}>
                    <p className={styles.line}>{onScreen}</p>
                    <div>
                      <p className={styles.quote}>“{quote}”</p>
                      <p className={styles.where}>
                        {section}
                        {section !== '' && page !== null && ' · '}
                        {page !== null && (
                          <a href={page.href} target="_blank" rel="noopener noreferrer">
                            {page.label}
                          </a>
                        )}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {status.music !== undefined && <p className={styles.fine}>{copy.music(status.music.model, status.music.bpm)}</p>}
      </div>
    </div>
  );
}
