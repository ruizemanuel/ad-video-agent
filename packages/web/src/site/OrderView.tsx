'use client';
// The order page's view of an order: the steps of its making with the link to come back by, or the end it came to (a
// refund on its way or sent, a payment that never went through, files that have expired, the video). It starts from the
// status the server read and, while the order is not over, asks the status route every 5 s. Once the status says the
// order is over, it stops asking.
import { useEffect, useRef, useState } from 'react';
import type { StatusJson } from '../payments/orders';
import { ORDER_PAGE } from './copy';
import styles from './OrderView.module.css';
import { followStatus, progressRows, type ProgressRow } from './progress';

export type OrderViewProps = {
  /** The order's status as the server read it. */
  initial: StatusJson;
  audio: 'music' | 'none';
  /** The host of the site the video is made from. */
  site: string;
  /** The first characters of the order's number, after `ord_`. */
  shortId: string;
  /** The link to this order, whole. */
  link: string;
};

type Phase = 'making' | 'refund' | 'unpaid' | 'expired' | 'delivered';

const PHASE: Record<StatusJson['status'], Phase> = {
  awaiting_settlement: 'making',
  paid: 'making',
  running: 'making',
  refunding: 'refund',
  refunded: 'refund',
  refund_failed: 'refund',
  unpaid: 'unpaid',
  expired: 'expired',
  delivered: 'delivered',
};

/** One look at the order's status; null when the answer is not one. */
async function lookAtOrder(id: string, signal: AbortSignal): Promise<StatusJson | null> {
  const res = await fetch(`/v1/videos/${encodeURIComponent(id)}`, { cache: 'no-store', signal });
  return res.ok ? ((await res.json()) as StatusJson) : null;
}

export function OrderView({ initial, audio, site, shortId, link }: OrderViewProps) {
  const [status, setStatus] = useState(initial);
  // From what the server read, once: it stops by itself at an end, so the answers it brings do not start it again.
  useEffect(() => followStatus(initial.status, (signal) => lookAtOrder(initial.id, signal), setStatus), [initial.id, initial.status]);

  const phase = PHASE[status.status];
  const rows = progressRows(status, audio);
  return (
    <main className={styles.page}>
      <div className={styles.main}>
        <p className={styles.which}>{ORDER_PAGE.which(site, shortId)}</p>
        {phase === 'making' && (
          <>
            <h1 className={styles.title}>{ORDER_PAGE.making.title}</h1>
            <p className={styles.lede}>{ORDER_PAGE.making.lede}</p>
            <CopyLink link={link} />
            <Steps rows={rows} />
            <p className={styles.fine}>{ORDER_PAGE.making.fine}</p>
          </>
        )}
        {phase === 'refund' && <Refund status={status} rows={rows} />}
        {phase === 'unpaid' && (
          <>
            <h1 className={styles.statement}>{ORDER_PAGE.unpaid[0]}</h1>
            <p className={styles.lede}>{ORDER_PAGE.unpaid[1]}</p>
          </>
        )}
        {phase === 'expired' && <h1 className={styles.statement}>{ORDER_PAGE.expired}</h1>}
        {phase === 'delivered' && <Delivered files={status.files ?? []} />}
      </div>
    </main>
  );
}

/** The order's link, with a button that copies it. */
function CopyLink({ link }: { link: string }) {
  const field = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<'idle' | 'copied' | 'selected'>('idle');
  useEffect(() => {
    if (state !== 'copied') return;
    const timer = setTimeout(() => setState('idle'), 2500);
    return () => clearTimeout(timer);
  }, [state]);

  const copy = async (): Promise<void> => {
    field.current?.select();
    try {
      await navigator.clipboard.writeText(link);
      setState('copied');
    } catch {
      // A browser that will not copy for the page still has the link selected, for the person to copy.
      setState('selected');
    }
  };

  return (
    <>
      <div className={styles.link}>
        <input ref={field} className={styles.linkField} aria-label={ORDER_PAGE.link.label} value={link} readOnly onFocus={(event) => event.currentTarget.select()} />
        <button type="button" className={styles.copy} onClick={() => void copy()}>
          {state === 'copied' ? ORDER_PAGE.link.copied : ORDER_PAGE.link.copy}
        </button>
      </div>
      <p className={styles.hidden} role="status">
        {state === 'copied' ? ORDER_PAGE.link.copied : ''}
      </p>
      {state === 'selected' && <p className={styles.note}>{ORDER_PAGE.link.selected}</p>}
    </>
  );
}

function Steps({ rows }: { rows: ProgressRow[] }) {
  return (
    <ol className={styles.steps}>
      {rows.map(({ label, state }) => (
        <li key={label} className={styles.step} data-state={state} aria-current={state === 'now' ? 'step' : undefined}>
          <span className={`${styles.mark} ${styles[state]}`} aria-hidden="true" />
          <span>
            <span className={styles.hidden}>{ORDER_PAGE.stateOf[state]}: </span>
            {label}
          </span>
          <span className={styles.when}>{state === 'now' ? ORDER_PAGE.now : null}</span>
        </li>
      ))}
    </ol>
  );
}

/** An order that could not be made, and where its refund is. */
function Refund({ status, rows }: { status: StatusJson; rows: ProgressRow[] }) {
  const { refund } = ORDER_PAGE;
  const line = status.status === 'refunded' ? refund.refunded : status.status === 'refund_failed' ? refund.refundFailed : refund.refunding;
  const txHash = status.refund?.txHash;
  return (
    <>
      <h1 className={styles.statement}>{refund.reason[0]}</h1>
      <p className={styles.lede}>{refund.reason[1]}</p>
      <p className={styles.refundLine}>
        {line}
        {txHash != null && (
          <>
            {' '}
            <a href={`https://celoscan.io/tx/${encodeURIComponent(txHash)}`} target="_blank" rel="noopener noreferrer">
              {refund.transaction}
            </a>
          </>
        )}
      </p>
      <Steps rows={rows} />
    </>
  );
}

/** Until the delivered view: a link to each file. */
function Delivered({ files }: { files: NonNullable<StatusJson['files']> }) {
  return (
    <>
      <h1 className={styles.title}>{ORDER_PAGE.delivered.title}</h1>
      <ul className={styles.files} aria-label={ORDER_PAGE.delivered.files}>
        {files.map(({ name, url }) => (
          <li key={name}>
            <a href={url}>{name}</a>
          </li>
        ))}
      </ul>
    </>
  );
}
