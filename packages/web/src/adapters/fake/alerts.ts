// The AlertPort as a double: it keeps every alert it was handed, in order, for a test to read.
import type { Alert, AlertPort } from '../../ports';

export class FakeAlerts implements AlertPort {
  readonly sent: Alert[] = [];

  async send(alert: Alert): Promise<void> {
    this.sent.push(alert);
  }
}
