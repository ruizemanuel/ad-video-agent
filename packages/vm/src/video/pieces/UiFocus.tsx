import { useMemo, type FC } from 'react';
import { useCurrentFrame } from 'remotion';
import { cameraAt, focusMove, focusShot, placeShot } from '../camera';
import { progress, UiStage, useAd, type PieceProps } from './common';

// The real UI, with the camera starting wide and easing in to the element that backs the caption (see focusMove).
export const UiFocus: FC<PieceProps> = ({ scene, timed }) => {
  const { site, format } = useAd();
  const frame = useCurrentFrame();
  const { shot, box } = useMemo(() => focusShot(site, scene, format), [site, scene, format]);
  const move = useMemo(() => focusMove(box, shot, format, site.boxes), [box, shot, format, site]);
  const camera = cameraAt(move, progress(frame, 4, timed.duration * 0.72));
  return <UiStage scene={scene} shot={shot} placed={placeShot(shot, camera, format, site.boxes)} />;
};
