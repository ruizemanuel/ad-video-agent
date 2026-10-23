'use client';
// "Did you post it?": the person's answer (as is, with changes, not yet), the link to the post if they have one, and
// whether we may show it as an example. Choosing an answer saves it; the link and the permission are saved with the
// button. It shows what was saved, to change it, and it asks nothing: whatever happens here, the video and its
// downloads are where they were. A save that fails says so and keeps what the person typed.
import { useId, useRef, useState, type FormEvent } from 'react';
import type { StatusJson } from '../payments/orders';
import type { FeedbackAnswer } from '../ports';
import { ORDER_PAGE } from './copy';
import styles from './FeedbackForm.module.css';
import { postUrlOf } from './share';

const copy = ORDER_PAGE.delivered.feedback;
/** The answers, in the order the copy lists them: one typed lookup in it for each, so one added to the service must be there. */
const ANSWERS = Object.keys(copy.answers) as FeedbackAnswer[];

type Form = { answer: FeedbackAnswer | null; link: string; mayShow: boolean };
type Notice = { tone: 'ok' | 'error'; text: string; about?: 'link' };

/** POST /v1/videos/<id>/feedback; whether it was saved. A link left blank is left out, and so is the permission with it. */
async function postFeedback(orderId: string, body: { answer: FeedbackAnswer; postUrl?: string; mayShow?: boolean }): Promise<boolean> {
  try {
    const res = await fetch(`/v1/videos/${encodeURIComponent(orderId)}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function FeedbackForm({ orderId, saved }: { orderId: string; saved: StatusJson['feedback'] }) {
  const ids = { title: useId(), notice: useId() };
  const [form, setForm] = useState<Form>({ answer: saved?.answer ?? null, link: saved?.postUrl ?? '', mayShow: saved?.mayShow ?? false });
  const [notice, setNotice] = useState<Notice | null>(null);
  // Saves go one after another, in the order they were asked for, so the last one asked is the one the service keeps.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const asked = useRef(0);

  const hasLink = form.link.trim() !== '';

  const save = (next: Form): void => {
    if (next.answer === null) {
      setNotice({ tone: 'error', text: copy.chooseFirst });
      return;
    }
    const { answer } = next;
    const typed = next.link.trim();
    const postUrl = typed === '' ? null : postUrlOf(typed);
    if (typed !== '' && postUrl === null) {
      setNotice({ tone: 'error', text: copy.badLink, about: 'link' });
      return;
    }
    const turn = ++asked.current;
    setNotice(null);
    queue.current = queue.current.then(async () => {
      const ok = await postFeedback(orderId, postUrl === null ? { answer } : { answer, postUrl, mayShow: next.mayShow });
      // Only the last one asked says how it went.
      if (turn === asked.current) setNotice(ok ? { tone: 'ok', text: copy.saved } : { tone: 'error', text: copy.failed });
    });
  };

  const choose = (answer: FeedbackAnswer): void => {
    const next = { ...form, answer };
    setForm(next);
    save(next);
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    save(form);
  };

  return (
    <section className={styles.card} aria-labelledby={ids.title}>
      <h2 id={ids.title} className={styles.title}>
        {copy.title}
      </h2>
      <form className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.chips} role="radiogroup" aria-labelledby={ids.title}>
          {ANSWERS.map((answer) => (
            <label key={answer} className={styles.chip}>
              <input type="radio" name="answer" value={answer} checked={form.answer === answer} onChange={() => choose(answer)} />
              <span>{copy.answers[answer]}</span>
            </label>
          ))}
        </div>
        <input
          className={styles.field}
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-label={copy.link.label}
          aria-invalid={notice?.about === 'link' ? true : undefined}
          aria-describedby={ids.notice}
          placeholder={copy.link.placeholder}
          value={form.link}
          onChange={(event) => {
            const link = event.target.value;
            // The permission is for a post: with the link gone there is nothing to show, so it goes too.
            setForm({ ...form, link, mayShow: link.trim() === '' ? false : form.mayShow });
            setNotice(null);
          }}
        />
        <label className={styles.permission}>
          <input
            type="checkbox"
            checked={form.mayShow}
            disabled={!hasLink}
            onChange={(event) => {
              setForm({ ...form, mayShow: event.target.checked });
              setNotice(null);
            }}
          />
          <span>{copy.mayShow}</span>
        </label>
        <div className={styles.row}>
          <button type="submit" className={styles.save}>
            {copy.save}
          </button>
          {/* There even when empty, so a screen reader hears what it says next. */}
          <p id={ids.notice} className={notice?.tone === 'error' ? `${styles.notice} ${styles.error}` : styles.notice} role="status">
            {notice?.text}
          </p>
        </div>
      </form>
    </section>
  );
}
