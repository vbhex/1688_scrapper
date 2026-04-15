#!/usr/bin/env node
/**
 * Browser Bridge — Puppeteer-based browser control for AutoStore AI
 *
 * Reads JSON commands from stdin (one per line), executes via Puppeteer,
 * writes JSON results to stdout. Browser stays open between commands.
 *
 * Usage: node browser-bridge.js
 *
 * Commands:
 *   navigate  {url}                → navigate to URL, return page info + elements
 *   read_page {selector?}          → read current page content + interactive elements
 *   click     {selector} or {text} → click element by CSS selector or visible text
 *   type      {selector, text}     → type text into input field
 *   execute_js {code}              → execute JavaScript, return result
 *   scroll    {direction, amount?} → scroll page
 *   screenshot {}                  → save screenshot, return file path
 *   close     {}                   → close browser and exit
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

puppeteer.use(StealthPlugin());

const PROFILE_DIR = path.resolve(__dirname, '../../data/chrome-profile-bridge');
const SCREENSHOT_PATH = '/tmp/autostore-screenshot.png';

let browser = null;
let page = null;

// ── Launch Browser ──────────────────────────────────────────

async function launchBrowser() {
  // Clean stale lock files
  const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'];
  for (const f of lockFiles) {
    try { fs.unlinkSync(path.join(PROFILE_DIR, f)); } catch {}
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  browser = await puppeteer.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--window-size=1280,900',
      '--disable-infobars',
      '--lang=en-US,zh-CN',
    ],
    userDataDir: PROFILE_DIR,
    protocolTimeout: 0,
    defaultViewport: { width: 1280, height: 900 },
  });

  // Close default blank tabs
  const pages = await browser.pages();
  if (pages.length > 0) {
    page = pages[0];
  } else {
    page = await browser.newPage();
  }

  // Set realistic user agent
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );
}

// ── Extract Interactive Elements ────────────────────────────

async function getInteractiveElements(maxElements = 50) {
  try {
    return await page.evaluate((max) => {
      const elements = [];
      const selectors = [
        'a[href]', 'button', 'input', 'textarea', 'select',
        '[role="button"]', '[role="link"]', '[role="tab"]',
        '[onclick]', '[data-action]',
      ];

      const seen = new Set();

      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          if (elements.length >= max) break;

          // Skip hidden elements
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;

          // Build a unique CSS selector
          let cssSelector = '';
          if (el.id) {
            cssSelector = '#' + el.id;
          } else if (el.className && typeof el.className === 'string') {
            const cls = el.className.trim().split(/\s+/).slice(0, 2).join('.');
            cssSelector = el.tagName.toLowerCase() + (cls ? '.' + cls : '');
          } else {
            cssSelector = el.tagName.toLowerCase();
          }

          // Get visible text
          let text = (el.textContent || '').trim().substring(0, 80);
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            text = el.placeholder || el.name || el.type || '';
          }
          if (el.tagName === 'IMG') {
            text = el.alt || el.title || '';
          }

          const key = cssSelector + '|' + text;
          if (seen.has(key)) continue;
          seen.add(key);

          const info = {
            tag: el.tagName.toLowerCase(),
            text: text,
            selector: cssSelector,
          };
          if (el.type) info.type = el.type;
          if (el.href) info.href = el.href.substring(0, 100);
          if (el.name) info.name = el.name;
          if (el.placeholder) info.placeholder = el.placeholder;

          elements.push(info);
        }
      }
      return elements;
    }, maxElements);
  } catch {
    return [];
  }
}

// ── Get Page Text Content ───────────────────────────────────

async function getPageText(maxChars = 5000) {
  try {
    return await page.evaluate((max) => {
      // Get main content text, skip script/style
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            const tag = parent.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
            const style = window.getComputedStyle(parent);
            if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      let text = '';
      let node;
      while ((node = walker.nextNode()) && text.length < max) {
        const t = node.textContent.trim();
        if (t.length > 1) text += t + '\n';
      }
      return text.substring(0, max);
    }, maxChars);
  } catch {
    return '';
  }
}

// ── Command Handlers ────────────────────────────────────────

async function handleCommand(cmd) {
  const { action, ...params } = cmd;

  try {
    switch (action) {
      case 'navigate': {
        let url = params.url || '';
        if (!url.startsWith('http')) url = 'https://' + url;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1000); // let dynamic content load
        const title = await page.title();
        const elements = await getInteractiveElements();
        const text = await getPageText(3000);
        return { ok: true, title, url: page.url(), text, elements };
      }

      case 'read_page': {
        const title = await page.title();
        const elements = await getInteractiveElements();
        const text = await getPageText(5000);
        return { ok: true, title, url: page.url(), text, elements };
      }

      case 'click': {
        if (params.selector) {
          // Click by CSS selector
          try {
            await page.click(params.selector);
          } catch {
            // Try with evaluate if click() fails (covered elements)
            await page.evaluate((sel) => {
              const el = document.querySelector(sel);
              if (el) el.click();
            }, params.selector);
          }
        } else if (params.text) {
          // Click by visible text — find element containing text
          const clicked = await page.evaluate((searchText) => {
            const all = document.querySelectorAll('a, button, [role="button"], input[type="submit"], [onclick]');
            for (const el of all) {
              if (el.textContent && el.textContent.trim().includes(searchText)) {
                el.click();
                return el.tagName + ': ' + el.textContent.trim().substring(0, 50);
              }
            }
            return null;
          }, params.text);
          if (!clicked) return { ok: false, error: `No clickable element found with text "${params.text}"` };
          await page.waitForTimeout(1000);
          return { ok: true, clicked };
        } else {
          return { ok: false, error: 'Provide selector or text to click' };
        }
        await page.waitForTimeout(1000);
        const title = await page.title();
        return { ok: true, title, url: page.url() };
      }

      case 'type': {
        const { selector, text, clear } = params;
        if (!selector || text === undefined) return { ok: false, error: 'Missing selector or text' };
        if (clear !== false) {
          // Clear existing content first
          await page.click(selector, { clickCount: 3 });
          await page.keyboard.press('Backspace');
        }
        await page.type(selector, text, { delay: 30 });
        return { ok: true };
      }

      case 'execute_js': {
        const { code } = params;
        if (!code) return { ok: false, error: 'Missing code' };
        const result = await page.evaluate(code);
        return { ok: true, result: JSON.stringify(result).substring(0, 5000) };
      }

      case 'scroll': {
        const { direction = 'down', amount = 500 } = params;
        const dy = direction === 'up' ? -amount : amount;
        await page.evaluate((y) => window.scrollBy(0, y), dy);
        await page.waitForTimeout(500);
        return { ok: true };
      }

      case 'screenshot': {
        await page.screenshot({ path: SCREENSHOT_PATH, type: 'png' });
        return { ok: true, path: SCREENSHOT_PATH };
      }

      case 'close': {
        if (browser) await browser.close();
        return { ok: true };
      }

      default:
        return { ok: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ── Main: stdin/stdout JSON protocol ────────────────────────

async function main() {
  await launchBrowser();

  // Signal ready
  process.stdout.write(JSON.stringify({ ok: true, status: 'ready' }) + '\n');

  const rl = readline.createInterface({ input: process.stdin });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let cmd;
    try {
      cmd = JSON.parse(trimmed);
    } catch {
      process.stdout.write(JSON.stringify({ ok: false, error: 'Invalid JSON' }) + '\n');
      continue;
    }

    const result = await handleCommand(cmd);
    process.stdout.write(JSON.stringify(result) + '\n');

    if (cmd.action === 'close') {
      process.exit(0);
    }
  }
}

main().catch((err) => {
  process.stderr.write('Bridge error: ' + err.message + '\n');
  process.exit(1);
});
