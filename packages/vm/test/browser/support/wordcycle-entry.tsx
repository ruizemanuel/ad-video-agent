// The entry point of the bundle the WordCycle test renders: the Ad as the video renders it, with a measure beside it that
// reports, for each probed line of the frame, the rectangle its mask clips it to. The Ad's own probe knows only the box
// of the text, and whether a glyph is cut is a question about the mask.
import { useEffect, type FC } from 'react';
import { Composition, continueRender, delayRender, registerRoot, useCurrentFrame, type CalculateMetadataFunction } from 'remotion';
import { FORMATS, FPS, layoutScenes } from '@app/core';
import { Ad, type AdProps } from '../../../src/video/Ad';
import { CLIPS_PREFIX, type ClipsMessage, type Rect } from './clips';

const rectOf = ({ left, top, width, height }: DOMRect): Rect => ({ x: left, y: top, w: width, h: height });

const clipOf = (el: Element): Rect | null => {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflow === 'hidden') return rectOf(node.getBoundingClientRect());
  }
  return null;
};

/** Waits until the Ad has put its lines on screen (it renders nothing until its fonts are in), then reports them. */
const Clips: FC = () => {
  const frame = useCurrentFrame();
  useEffect(() => {
    const handle = delayRender(`clips of frame ${frame}`);
    const look = (tries: number) => {
      const lines = [...document.querySelectorAll('[data-qa-line]')];
      if (lines.length === 0 && tries < 600) return void setTimeout(() => look(tries + 1), 50);
      requestAnimationFrame(() => {
        const message: ClipsMessage = {
          frame,
          lines: lines.map((el) => ({ text: el.textContent ?? '', box: rectOf(el.getBoundingClientRect()), clip: clipOf(el) })),
        };
        console.log(CLIPS_PREFIX + JSON.stringify(message));
        continueRender(handle);
      });
    };
    look(0);
  }, [frame]);
  return null;
};

const Harness: FC<AdProps> = (props) => (
  <>
    <Ad {...props} />
    <Clips />
  </>
);

const calculateMetadata: CalculateMetadataFunction<AdProps> = ({ props }) => ({
  durationInFrames: props.edl ? layoutScenes(props.edl, props.hook).total : FPS,
  width: FORMATS[props.format].width,
  height: FORMATS[props.format].height,
  fps: FPS,
});

const defaultProps: AdProps = { edl: null, site: null, format: '9x16', hook: 0 };

registerRoot(() => (
  <Composition
    id="wordcycle"
    component={Harness}
    fps={FPS}
    width={FORMATS['9x16'].width}
    height={FORMATS['9x16'].height}
    durationInFrames={FPS}
    defaultProps={defaultProps}
    calculateMetadata={calculateMetadata}
  />
));
