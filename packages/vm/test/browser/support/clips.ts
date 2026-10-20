// What the measure of the WordCycle test's bundle (wordcycle-entry.tsx) reports through the browser console. It lives
// apart from the entry because the entry registers a Remotion root when it is imported, which only a bundle may do.

export const CLIPS_PREFIX = '__clips__';

export type Rect = { x: number; y: number; w: number; h: number };
/** A probed line of the frame, with the rectangle of the nearest ancestor that clips it (null when nothing clips it). */
export type ClippedLine = { text: string; box: Rect; clip: Rect | null };
export type ClipsMessage = { frame: number; lines: ClippedLine[] };

/** The lines measured in `frame`, if this console message is the measure's for that frame. */
export const readClips = (text: string, frame: number): ClippedLine[] | undefined => {
  if (!text.startsWith(CLIPS_PREFIX)) return undefined;
  const message = JSON.parse(text.slice(CLIPS_PREFIX.length)) as ClipsMessage;
  return message.frame === frame ? message.lines : undefined;
};
