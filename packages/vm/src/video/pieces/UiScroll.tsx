import { useMemo, type FC } from 'react';
import { useCurrentFrame } from 'remotion';
import { cameraAt, placeShot, scrollMove, scrollShot } from '../camera';
import { EASE_IN_OUT, progress, UiStage, useAd, type PieceProps } from './common';

// Glides down a long capture at a steady scale, landing on the target element or a little under half the page (see
// scrollMove). A second caption with an atBeat replaces the first on that beat (see UiStage).
export const UiScroll: FC<PieceProps> = ({ scene, timed }) => {
  const { site, format } = useAd();
  const frame = useCurrentFrame();
  const { shot, box } = useMemo(() => scrollShot(site, scene, format), [site, scene, format]);
  const move = useMemo(() => scrollMove(box, shot, format, site.boxes), [box, shot, format, site]);
  const camera = cameraAt(move, progress(frame, 6, timed.duration - 4, EASE_IN_OUT));
  return <UiStage scene={scene} timed={timed} shot={shot} placed={placeShot(shot, camera, format, site.boxes)} />;
};
