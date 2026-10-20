import { useMemo, type FC } from 'react';
import { useCurrentFrame } from 'remotion';
import { cameraAt, placeShot, scrollMove, scrollShot, type Camera, type Move, type TimedScene } from '@app/core';
import { cameraFrames } from '../rhythm';
import { EASE_IN_OUT, progress, UiStage, useAd, type PieceProps } from './common';

/** Where UiScroll's camera is at `frame` of its scene: it glides over the frames cameraFrames gives, eased in and out. */
export const scrollCameraAt = (move: Move, frame: number, timed: TimedScene): Camera => {
  const { start, end } = cameraFrames(timed);
  return cameraAt(move, progress(frame, start, end, EASE_IN_OUT));
};

// Glides down a long capture at a steady scale, landing on the target element or a little under half the page (see
// scrollMove). A second caption with an atBeat replaces the first on that beat (see UiStage).
export const UiScroll: FC<PieceProps> = ({ scene, timed }) => {
  const { site, format } = useAd();
  const frame = useCurrentFrame();
  const { shot, box } = useMemo(() => scrollShot(site, scene, format), [site, scene, format]);
  const move = useMemo(() => scrollMove(box, shot, format, site.boxes, site.blocks), [box, shot, format, site]);
  const camera = scrollCameraAt(move, frame, timed);
  return <UiStage scene={scene} timed={timed} shot={shot} placed={placeShot(shot, camera, format, site.boxes)} />;
};
