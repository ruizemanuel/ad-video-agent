// The probe's message: the Ad, rendered with `probe`, measures the text of each frame in the real DOM and logs it to the
// browser console as `__probe__{"frame":…,"items":[…]}`; the key frame renderer reads it back. Shared by both sides.
import type { ProbeItem } from '@app/core';

export const PROBE_PREFIX = '__probe__';

export type ProbeMessage = { frame: number; items: ProbeItem[] };

export const probeMessage = (message: ProbeMessage): string => PROBE_PREFIX + JSON.stringify(message);

/** The text measured in `frame`, if this console message is the probe's for that frame. */
export const readProbe = (text: string, frame: number): ProbeItem[] | undefined => {
  if (!text.startsWith(PROBE_PREFIX)) return undefined;
  const message = JSON.parse(text.slice(PROBE_PREFIX.length)) as ProbeMessage;
  return message.frame === frame ? message.items : undefined;
};
