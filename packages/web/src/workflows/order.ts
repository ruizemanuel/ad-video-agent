// The durable flow of one paid order: it rents the VM, has the site captured, writes and checks the script, makes the
// music, reviews, renders and delivers, and refunds on any failure. Its steps are not written yet: until they are, a
// run fails at once, and a FatalError is never retried.
import { FatalError } from 'workflow';

export async function orderWorkflow(orderId: string) {
  'use workflow';
  throw new FatalError('order workflow not implemented yet');
}
