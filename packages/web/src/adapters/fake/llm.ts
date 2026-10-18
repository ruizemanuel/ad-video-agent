// The LlmPort as a double, for the tests that run the pre-check and the flow without a model. It answers what a test
// tells it to, and counts the calls it gets, so a test can say a model was (or was not) asked.
import type { LlmPort } from '../../ports';

type ClassifySite = LlmPort['classifySite'];

export class FakeLlm implements LlmPort {
  /** How many times each call was made, whatever it answered. */
  readonly calls = { classifySite: 0 };

  private classify: ClassifySite = async () => ({ admissible: true, reason: 'The site is a normal business site.', usd: 0.0004 });

  /** Counts the call and answers as the test said: a test sets the answer with `llm.classifySite = async (input) => ...`. */
  get classifySite(): ClassifySite {
    return async (input) => {
      this.calls.classifySite += 1;
      return this.classify(input);
    };
  }

  set classifySite(answer: ClassifySite) {
    this.classify = answer;
  }
}
