import { useMemo, type FC } from 'react';
import { useCurrentFrame } from 'remotion';
import { cameraAt, placeShot, raisedMove, scrollMove, scrollShot, type Camera, type Move, type TimedScene } from '@app/core';
import { cameraFrames } from '../rhythm';
import { EASE_IN_OUT, progress, UiStage, useAd, useUiCaptions, type PieceProps } from './common';

/** Where UiScroll's camera is at `frame` of its scene: it glides over the frames cameraFrames gives, eased in and out. */
export const scrollCameraAt = (move: Move, frame: number, timed: TimedScene): Camera => {
  const { start, end } = cameraFrames(timed);
  return cameraAt(move, progress(frame, start, end, EASE_IN_OUT));
};

// Glides down a long capture at a steady scale, landing on the target element or a little under half the page (see
// scrollMove), in a card risen into the room the caption leaves when it can (see raisedMove). A second caption with an
// atBeat replaces the first on that beat (see UiStage).
export const UiScroll: FC<PieceProps> = ({ scene, timed }) => {
  const { site, format } = useAd();
  const frame = useCurrentFrame();
  const captions = useUiCaptions(scene, timed);
  const { shot, box } = useMemo(() => scrollShot(site, scene, format), [site, scene, format]);
  const { move, stage } = useMemo(
    () => raisedMove(scrollMove(box, shot, format, site.boxes, site.blocks), shot, format, site.boxes, captions.cardTop),
    [box, shot, format, site, captions.cardTop],
  );
  const camera = scrollCameraAt(move, frame, timed);
  return <UiStage captions={captions} stage={stage} shot={shot} placed={placeShot(shot, camera, format, site.boxes, stage.cardTop)} />;
};
