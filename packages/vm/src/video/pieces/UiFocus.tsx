import { useMemo, type FC } from 'react';
import { useCurrentFrame } from 'remotion';
import { cameraAt, focusMove, focusShot, placeShot, type Camera, type Move, type TimedScene } from '@app/core';
import { cameraFrames } from '../rhythm';
import { progress, UiStage, useAd, type PieceProps } from './common';

/** Where UiFocus's camera is at `frame` of its scene: it eases in over the frames cameraFrames gives, and settles. */
export const focusCameraAt = (move: Move, frame: number, timed: TimedScene): Camera => {
  const { start, end } = cameraFrames(timed);
  return cameraAt(move, progress(frame, start, end));
};

// The real UI, with the camera starting wide and easing down and in to the element that backs the caption, or the card
// of the page it is in (see focusMove). A second caption with an atBeat replaces the first on that beat (see UiStage).
export const UiFocus: FC<PieceProps> = ({ scene, timed }) => {
  const { site, format } = useAd();
  const frame = useCurrentFrame();
  const { shot, box } = useMemo(() => focusShot(site, scene, format), [site, scene, format]);
  const move = useMemo(() => focusMove(box, shot, format, site.boxes, site.blocks), [box, shot, format, site]);
  const camera = focusCameraAt(move, frame, timed);
  return <UiStage scene={scene} timed={timed} shot={shot} placed={placeShot(shot, camera, format, site.boxes)} />;
};
