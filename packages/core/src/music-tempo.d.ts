// `music-tempo` (a port of the Beatroot beat tracker) ships no types. This covers what music.ts uses.
declare module 'music-tempo' {
  export interface MusicTempoParams {
    /** FFT window, in samples. A power of two. Default 2048. */
    bufferSize?: number;
    /** Distance between two analysis frames, in samples. Default 441: 10 ms at 44.1 kHz. */
    hopSize?: number;
    /** Seconds between two analysis frames, used to turn frame numbers into times. Default 0.01. */
    timeStep?: number;
    [param: string]: number | undefined;
  }

  /** Finds the tempo and the beat times of a mono signal. Throws (a string, not an Error) when it finds none. */
  export default class MusicTempo {
    /** `audioData`: mono samples in -1..1. The constructor writes the defaults it used into `params`. */
    constructor(audioData: Float32Array | number[], params?: MusicTempoParams);
    /** Beats per minute of the best beat tracker, as a string with three decimals. */
    readonly tempo: string;
    /** Beat times in seconds. */
    readonly beats: number[];
    /** Seconds between two beats. */
    readonly beatInterval: number;
  }
}
