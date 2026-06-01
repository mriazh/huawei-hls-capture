import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import path from 'path';

(async () => {
  const profileDir = path.resolve('playwright-profile');
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
  });

  const page = context.pages()[0] ?? await context.newPage();
  await page.goto('https://e.huawei.com/en/talent/outPage/#/sxz-course/home?courseId=Q96qaZ1Dx6hJx-3t_2bThTJY5ls&operate=1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(5000); // let it settle

  let htmlDump = '';
  // Dump main frame
  htmlDump += `=== MAIN FRAME ===\n${await page.evaluate(() => document.body.innerHTML)}\n\n`;

  // Dump all iframes
  let i = 1;
  for (const frame of page.frames()) {
    try {
      const html = await frame.evaluate(() => document.body.innerHTML);
      htmlDump += `=== FRAME ${i} (${frame.url()}) ===\n${html}\n\n`;
    } catch(e) {}
    i++;
  }

  writeFileSync('C:\\Users\\adima\\.gemini\\antigravity\\brain\\1bc8b9bc-1c45-4415-ad5a-29c3cdb07f58\\scratch\\dump.html', htmlDump);
  console.log("Dump successful!");
  await context.close();
})();
