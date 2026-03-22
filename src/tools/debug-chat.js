/**
 * Debug the Wangwang web IM chat interface at air.1688.com
 */
const puppeteer = require('puppeteer-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
puppeteer.use(stealth());
const fs = require('fs');

(async () => {
  const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  if (fs.existsSync('data/1688-cookies.json')) {
    await page.setCookie(...JSON.parse(fs.readFileSync('data/1688-cookies.json', 'utf8')));
  }

  // Navigate to direct Wangwang web IM
  const sellerId = '99dx039474552';
  const url = `https://amos.alicdn.com/getcid.aw?v=3&groupid=0&s=1&charset=utf-8&uid=${sellerId}&site=cnalichn`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));
  console.log('Title:', await page.title());

  // Click "优先使用网页版"
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    for (const btn of buttons) {
      if ((btn.textContent || '').includes('优先使用网页版') && btn.offsetHeight > 0) {
        btn.click();
        return true;
      }
    }
    return false;
  });
  console.log('Clicked web version:', clicked);
  await new Promise(r => setTimeout(r, 8000));

  // Check all tabs
  const pages = await browser.pages();
  console.log('Total tabs:', pages.length);
  for (let i = 0; i < pages.length; i++) {
    console.log(`Tab ${i}: ${pages[i].url().substring(0, 150)}`);
  }

  // Use the latest tab (the web IM)
  const chatPage = pages[pages.length - 1];
  console.log('Chat page title:', await chatPage.title());
  console.log('Chat page URL:', chatPage.url().substring(0, 150));

  await new Promise(r => setTimeout(r, 5000));

  // Dump ALL visible interactive elements
  const els = await chatPage.evaluate(() => {
    const results = [];
    document.querySelectorAll('textarea, input, [contenteditable], button, [role="textbox"], [class*="editor"], [class*="Editor"], [class*="input"], [class*="Input"], [class*="send"], [class*="Send"]').forEach(el => {
      if (el.offsetHeight > 0 && el.offsetWidth > 10) {
        results.push({
          tag: el.tagName,
          cls: (el.className || '').substring(0, 150),
          id: el.id || '',
          ce: el.getAttribute('contenteditable'),
          role: el.getAttribute('role') || '',
          ph: el.getAttribute('placeholder') || '',
          text: (el.textContent || '').trim().substring(0, 60),
          w: Math.round(el.getBoundingClientRect().width),
          h: Math.round(el.getBoundingClientRect().height),
        });
      }
    });
    return results;
  });
  console.log('\n=== INTERACTIVE ELEMENTS ===');
  console.log(JSON.stringify(els, null, 2));

  // Check iframes
  const iframes = await chatPage.evaluate(() => {
    return Array.from(document.querySelectorAll('iframe')).map(f => ({
      src: f.src.substring(0, 150),
      w: f.offsetWidth,
      h: f.offsetHeight
    }));
  });
  if (iframes.length) console.log('\n=== IFRAMES ===', JSON.stringify(iframes, null, 2));

  await chatPage.screenshot({ path: '/tmp/1688-webim-debug.png', fullPage: false });
  console.log('\nScreenshot: /tmp/1688-webim-debug.png');

  await browser.close();
})();
