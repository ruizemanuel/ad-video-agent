// Run by tsx.test.ts under `node --import tsx`, the way the VM runs the worker: opens a page and reads its sections.
import { inPageExtractText } from '../../../src/capture/extract';
import { launchBrowser, openPage } from '../../../src/capture/page';

const browser = await launchBrowser();
try {
  const log = { startedAt: '', notes: [], timings: {} };
  const { page } = await openPage(browser, 'data:text/html,<h1>Hello there</h1><p>A paragraph with enough words in it to be a section.</p>', 'desktop', log);
  const text = await page.evaluate(inPageExtractText);
  console.log(`SECTIONS ${JSON.stringify(text.sections.map((s) => s.heading))}`);
} finally {
  await browser.close();
}
