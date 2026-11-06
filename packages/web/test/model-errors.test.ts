// The two errors a model call can end in, as the flow tells them apart: by their brand, not by their class, since the
// workflow runtime bundles its steps apart and an error made elsewhere (a test's double, another copy of the module) is
// not an instance of the step's class.
import { describe, expect, it } from 'vitest';
import { ModelCallFailed, ModelOutputInvalid } from '../src/ports';

// The same error as another copy of the module makes it: a plain error with the brand, and none of this class.
const fromAnotherCopy = (brand: string): Error => Object.assign(new Error('x'), { [Symbol.for(brand)]: true });

describe('ModelOutputInvalid.is', () => {
  it('tells an answer that did not fit, made by another copy of the module too', () => {
    expect(ModelOutputInvalid.is(new ModelOutputInvalid('The director model did not answer with a valid edl.', 0.3))).toBe(true);
    expect(ModelOutputInvalid.is(fromAnotherCopy('ad-video-agent/ModelOutputInvalid'))).toBe(true);
  });

  it('is false for a call that failed, any other error and anything that is not one', () => {
    for (const other of [new ModelCallFailed('director', 'AI_APICallError', 503), new Error('ModelOutputInvalid'), 'ModelOutputInvalid', null, undefined]) {
      expect(ModelOutputInvalid.is(other)).toBe(false);
    }
  });
});

describe('ModelCallFailed.is', () => {
  it('tells a call that failed, made by another copy of the module too', () => {
    expect(ModelCallFailed.is(new ModelCallFailed('director', 'AI_APICallError', 503))).toBe(true);
    expect(ModelCallFailed.is(fromAnotherCopy('ad-video-agent/ModelCallFailed'))).toBe(true);
  });

  it('is false for an answer that did not fit, any other error and anything that is not one', () => {
    for (const other of [new ModelOutputInvalid('x', 0.1), new Error('ModelCallFailed'), 'ModelCallFailed', null, undefined]) {
      expect(ModelCallFailed.is(other)).toBe(false);
    }
  });
});
