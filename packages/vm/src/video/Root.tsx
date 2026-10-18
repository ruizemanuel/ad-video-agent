import type { FC } from 'react';
import { Composition, type CalculateMetadataFunction } from 'remotion';
import { FORMATS, FPS, layoutScenes, type Format } from '@app/core';
import { Ad, type AdProps } from './Ad';

const FORMAT_LIST: Format[] = ['9x16', '16x9', '4x5'];

// The length comes from the edit list (its beats at its bpm), the size from the format.
const calculateMetadata: CalculateMetadataFunction<AdProps> = ({ props }) => ({
  durationInFrames: props.edl ? layoutScenes(props.edl, props.hook).total : FPS,
  width: FORMATS[props.format].width,
  height: FORMATS[props.format].height,
  fps: FPS,
});

// One composition per format. The hook is a prop, so the videos of the three hooks share the body by construction.
export const Root: FC = () => (
  <>
    {FORMAT_LIST.map((format) => {
      const defaultProps: AdProps = { edl: null, site: null, format, hook: 0 };
      return (
        <Composition
          key={format}
          id={`ad-${format}`}
          component={Ad}
          fps={FPS}
          width={FORMATS[format].width}
          height={FORMATS[format].height}
          durationInFrames={FPS}
          defaultProps={defaultProps}
          calculateMetadata={calculateMetadata}
        />
      );
    })}
  </>
);
