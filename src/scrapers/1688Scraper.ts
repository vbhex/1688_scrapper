import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page, CookieParam } from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { createChildLogger } from '../utils/logger';
import { config } from '../config';
import { ScrapedProduct, ProductSpecification, SellerInfo, ProductVariants, SupplierSearchResult } from '../models/product';
import { sleep, randomDelay, isAppleBrand, ensureDirectoryExists } from '../utils/helpers';

// Apply stealth plugin to avoid bot detection
puppeteerExtra.use(StealthPlugin());

const logger = createChildLogger('1688Scraper');

// Cookie storage path
const COOKIES_DIR = path.resolve(__dirname, '../../data');
const COOKIES_FILE = path.join(COOKIES_DIR, '1688-cookies.json');

// Chinese keyword mapping for 1688.com search (Chinese-language site)
// RED OCEAN RULE (2026-03-20): Women's Clothing + Men's Clothing L1 = permanently banned.
// Do NOT add any Women's or Men's Clothing sub-categories back — all are Red Ocean.
// ACTIVE TARGETS: Watches, Apparel Accessories (Hats, Scarves, Hair, Eyewear, Belts, Gloves)
// Full strategy: documents/aliexpress-store/aliexpress-2087779-blue-ocean-categories.md
//
// Keyword strategy: append 速卖通外贸款 ("AliExpress export style") to target
// export-oriented 1688 suppliers with clean white-background images (no Chinese text).
const categoryKeywords: Record<string, string> = {
  // ── Watches (AE L1: Watches) ──────────────────────────────────────────────
  'quartz watches':       '石英表 简约 速卖通外贸款',    // → QuartzWristwatches
  'fashion watches':      '时尚腕表 男女 速卖通外贸款',  // → QuartzWristwatches (fashion/casual)
  'couple watches':       '情侣表 对表 速卖通外贸',      // → CoupleWatches
  'digital watches':      '数字运动手表 速卖通外贸款',   // → DigitalWristwatches

  // ── Hats & Caps (AE L1: Apparel Accessories) ──────────────────────────────
  'bucket hats':          '渔夫帽 男女 一件代发',         // → BucketHats
  'baseball caps':        '棒球帽 时尚 一件代发',         // → BaseballCaps
  'beanies':              '针织帽 男女款 外贸',           // → Hats (一件代发 returns 0)
  'cowboy hats':          '西部牛仔帽 外贸出口',         // → CowboyHats (牛仔帽 一件代发 returns 0)

  // ── Scarves & Wraps (AE L1: Apparel Accessories) ──────────────────────────
  'silk scarves':         '女士真丝围巾 外贸出口',        // → SilkScarves (一件代发 only 2 results)
  'winter scarves':       '冬季针织围巾 男女 外贸',       // → Scarves
  'sun scarves':          '防晒围巾 夏季 外贸出口',       // → SunProtectiveScarf

  // ── Hair Accessories (AE L1: Apparel Accessories) ─────────────────────────
  'hair claws':           '鲨鱼夹 外贸出口',              // → HairClaw (鲨鱼夹 发夹 一件代发 returns 0)
  'hair pins':            '发夹 发卡 时尚 一件代发',      // → HairPin
  'hair accessories set': '发饰套装 一件代发',            // → HairAccessoriesSet

  // ── Eyewear (AE L1: Apparel Accessories) ──────────────────────────────────
  'blue light glasses':   '防蓝光眼镜 平光镜 一件代发',  // → BlueLightBlockingGlasses
  'reading glasses':      '老花眼镜 时尚 一件代发',       // → ReadingGlasses
  'optical frames':       '光学眼镜框 超轻 一件代发',     // → EyeglassesFrames
  'polarized sunglasses': '偏光太阳镜 男女 一件代发',     // → Sunglasses
  'sports sunglasses':    '骑行墨镜 运动 外贸出口',       // → SportsSunglasses (运动太阳镜 骑行 一件代发 returns 0)

  // ── Belts & Gloves (AE L1: Apparel Accessories) ───────────────────────────
  'fashion belts':        '时尚腰带 外贸出口',            // → Belts (时尚皮带 男女 一件代发 returns 0)
  'fashion gloves':       '针织手套 外贸出口',            // → GlovesMittens (时尚手套 冬季 一件代发 returns 0)

  // ── Jewelry & Accessories (AE L1: Jewelry & Accessories) ──────────────────
  'fashion earrings':     '时尚耳环 女士 一件代发',       // → Earrings
  'fashion bracelets':    '时尚手链 一件代发',            // → Bracelets
  'fashion necklaces':    '时尚项链 女士 一件代发',       // → Necklaces
  'fashion rings':        '时尚戒指 一件代发',            // → Rings
  'fashion anklets':      '时尚脚链 一件代发',            // → Anklets

  // ── Luggage & Bags (AE L1: Luggage & Bags) ───────────────────────────────
  'fashion backpacks':    '时尚双肩包 一件代发',          // → Backpacks
  'fashion wallets':      '时尚钱包 男女 一件代发',       // → Wallets
  'waist packs':          '腰包 男女 一件代发',           // → WaistPacks
  'coin purses':          '零钱包 可爱 一件代发',         // → CoinPurses

  // ── Shoes (AE L1: Shoes) ─────────────────────────────────────────────────
  'womens fashion shoes': '女士时尚单鞋 一件代发',        // → WomensShoes
  'mens casual shoes':    '男士休闲鞋 一件代发',          // → MensShoes
  'sneakers':             '运动鞋 男女 一件代发',          // → Sneakers

  // ── Underwear (AE L1: Underwear) ─────────────────────────────────────────
  'fashion socks':        '时尚袜子 男女 一件代发',       // → Socks
  'mens underwear':       '男士内裤 莫代尔 一件代发',     // → MensUnderwear
  'womens bras':          '女士文胸 无钢圈 一件代发',     // → WomensBras

  // ── Sports & Entertainment (AE L1: Sports & Entertainment) ───────────────
  'ab rollers':           '腹肌滚轮 健身 一件代发',       // → AbRollers
  'resistance bands':     '弹力带 健身 一件代发',         // → ResistanceBands
  'jump ropes':           '跳绳 一件代发',                // → JumpRopes
  'yoga mats':            '瑜伽垫 防滑 一件代发',         // → YogaMats
  'fitness gloves':       '健身手套 一件代发',            // → FitnessGloves
  'water bottles':        '运动水杯 健身 一件代发',       // → WaterBottles

  // ── Mother & Kids (AE L1: Mother & Kids) ─────────────────────────────────
  'family matching outfits': '亲子装 一件代发',           // → FamilyMatchingOutfits

  // ── RED OCEAN — DO NOT USE (Women's Clothing + Men's Clothing L1) ──────────
  // All categories below are permanently retired. Kept as legacy keywords ONLY
  // so existing DB records with these category values still resolve correctly.
  'womens skirts':    '女士半身裙 外贸款',
  'womens jumpsuits': '女士连体裤 速卖通外贸',
  'womens blazers':   '速卖通女士西装外套',
  'womens leggings':  '外贸瑜伽裤女',
  'womens sleepwear': '睡衣套装 外贸款',
  'womens cardigan':  '针织开衫 速卖通外贸',
  'womens dresses':   '连衣裙',
  'womens jackets':   '女士外套',
  'womens sets':      '女士套装',
  'womens boho':      '波西米亚连衣裙',
  'womens floral':    '碎花半身裙',
  'womens sweater':   '女士毛衣',
  'womens tshirts':   '女士印花T恤',
  'womens tops':      '女士印花T恤',
  'womens hoodies':   '女士oversize卫衣',
  'mens polo':        '外贸Polo衫男',
  'mens shorts':      '男士短裤 速卖通外贸款',
  'mens suits':       '西装套装 速卖通外贸',
  'mens cargo':       '男士工装裤 速卖通外贸款',
  'mens shirts':      '男士花衬衫',
  'mens tshirts':     '男士印花T恤',
  'mens graphic':     '男士印花T恤',
  'mens hoodies':     '男士连帽卫衣印花',
  'mens pants':       '男士休闲裤',
  'denim jackets':    '牛仔外套 速卖通外贸款',
  'streetwear':       'Y2K潮流服装',
  'unisex graphic':   '情侣潮牌T恤',
  'kids clothing':    '儿童T恤',

  // ── 3C / Consumer Electronics (RETIRED 2026-03-05 — keep for legacy DB lookups) ──
  'earphones': '蓝牙耳机',
  'speakers': '蓝牙音箱',
  'action cameras': '运动相机',
  'action camera accessories': '运动相机配件',
  'wireless charger': '无线充电器',
  'power bank': '充电宝',
  'phone cooler': '手机散热器',
  'usb hub': 'USB扩展坞',
  'gaming mouse': '游戏鼠标',
  'mechanical keyboard': '机械键盘',
  'webcam': '电脑摄像头',
  'sim router': '随身WiFi',
  'translator': '翻译机',
  'lavalier microphone': '领夹麦克风',
  'soundbar': '回音壁音响',
  'smart watches': '智能手表',
  'smart ring': '智能戒指',
  'vr glasses': 'VR眼镜',
  'gimbal stabilizer': '手持云台稳定器',
  'power station': '户外电源',
  'solar panel': '太阳能充电板',
  'ip camera': '监控摄像头',
  'gps tracker': 'GPS定位器',
  'smart doorbell': '智能门铃',
};

// File path for manually collected product URLs
// Users can browse 1688.com manually and paste product URLs here (one per line)
const PRODUCT_URLS_FILE = path.resolve(__dirname, '../../data/product-urls.txt');

export class Scraper1688 {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private isLoggedIn: boolean = false;
  private headless: boolean;

  constructor(headless?: boolean) {
    // Allow headless mode via constructor or env var
    this.headless = headless !== undefined ? headless : (process.env.HEADLESS === 'true');
  }

  async initialize(): Promise<void> {
    logger.info('Initializing 1688 scraper with stealth mode', { headless: this.headless });

    // Use persistent Chrome profile to avoid detection
    const userDataDir = path.resolve(__dirname, '../../data/chrome-profile-1688');
    ensureDirectoryExists(userDataDir);

    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--start-maximized',
      '--disable-infobars',
      '--disable-extensions-except=',
      '--disable-plugins-discovery',
    ];

    if (config.proxy.server) {
      args.push(`--proxy-server=${config.proxy.server}`);
    }

    this.browser = await puppeteerExtra.launch({
      headless: this.headless ? 'new' as any : false,
      args,
      userDataDir, // Persistent profile - preserves cookies, history, fingerprint
      protocolTimeout: 0, // No timeout on CDP protocol messages (prevents detached-frame on slow pages)
      defaultViewport: {
        width: 1920,
        height: 1080,
      },
    });

    // Close all stale tabs from previous sessions
    const existingPages = await this.browser.pages();
    logger.info('Closing stale tabs from previous session', { count: existingPages.length });
    for (const p of existingPages) {
      await p.close().catch(() => {});
    }

    // Always create a fresh page
    this.page = await this.browser.newPage();

    if (config.proxy.server && config.proxy.username) {
      await this.page.authenticate({
        username: config.proxy.username,
        password: config.proxy.password,
      });
    }

    // Set a realistic user agent
    await this.page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    // Note: Do not override Accept-Encoding as it can conflict with
    // Puppeteer's internal handling of compressed responses.
    await this.page.setExtraHTTPHeaders({
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    });

    // Note: navigator overrides (webdriver, plugins, languages, platform)
    // are handled by puppeteer-extra-plugin-stealth — do NOT add manual
    // evaluateOnNewDocument overrides as they can conflict with the plugin
    // and actually help detection (e.g. plugins=[1,2,3,4,5] is detectable).

    logger.info('Browser initialized with stealth mode');
  }

  // Save cookies to file for session persistence
  async saveCookies(): Promise<void> {
    if (!this.page) return;

    try {
      ensureDirectoryExists(COOKIES_DIR);
      const cookies = await this.page.cookies();
      fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
      logger.info('Cookies saved', { count: cookies.length, path: COOKIES_FILE });
    } catch (error) {
      logger.error('Failed to save cookies', { error: (error as Error).message });
    }
  }

  // Load cookies from file
  async loadCookies(): Promise<boolean> {
    if (!this.page) return false;

    try {
      if (!fs.existsSync(COOKIES_FILE)) {
        logger.info('No saved cookies found');
        return false;
      }

      const cookiesData = fs.readFileSync(COOKIES_FILE, 'utf-8');
      const cookies = JSON.parse(cookiesData) as CookieParam[];

      if (cookies.length === 0) {
        logger.info('Cookie file is empty');
        return false;
      }

      await this.page.setCookie(...cookies);
      logger.info('Cookies loaded', { count: cookies.length });
      return true;
    } catch (error) {
      logger.error('Failed to load cookies', { error: (error as Error).message });
      return false;
    }
  }

  // Check if current session is valid (logged in)
  async isSessionValid(): Promise<boolean> {
    if (!this.page) return false;

    try {
      // Navigate to 1688 work page — use domcontentloaded to avoid redirect-induced frame detachment
      await this.page.goto('https://www.1688.com', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      // Wait for any JS-driven redirects to settle before evaluating
      await sleep(4000);

      // Re-check we still have a valid page after potential redirects
      if (!this.page || this.page.isClosed()) return false;

      // Check for login state using current URL first (fast path)
      const currentUrl = this.page.url();
      if (currentUrl.includes('login') || currentUrl.includes('passport')) return false;

      // Check for login state in DOM
      const loggedIn = await this.page.evaluate(() => {
        const userElements = [
          '.sm-widget-myinfo',
          '.user-name',
          '[class*="login-info"]',
          '[class*="user-info"]',
          '[class*="member-info"]',
          '.username',
          '[data-spm*="user"]',
          'a[href*="logout"]',
          '[class*="logout"]',
        ];
        for (const selector of userElements) {
          if (document.querySelector(selector)) return true;
        }
        return false;
      }).catch(() => false);

      return loggedIn;
    } catch (error) {
      logger.error('Session validation failed', { error: (error as Error).message });
      return false;
    }
  }

  // Interactive login - opens browser for manual login, then saves cookies
  async manualLogin(): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');

    logger.info('='.repeat(60));
    logger.info('MANUAL LOGIN MODE');
    logger.info('='.repeat(60));
    logger.info('A browser window will open. Please log in manually.');
    logger.info('You can use QR code, password, or any other method.');
    logger.info('After logging in, the session will be saved for future use.');
    logger.info('='.repeat(60));

    try {
      // Navigate to 1688 work page - it will redirect to login
      await this.page.goto('https://work.1688.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      await sleep(2000);

      // Wait for user to complete login (check every 5 seconds for up to 5 minutes)
      const maxWaitTime = 300000; // 5 minutes
      const checkInterval = 5000; // 5 seconds
      let elapsed = 0;

      logger.info('Waiting for manual login (up to 5 minutes)...');

      while (elapsed < maxWaitTime) {
        await sleep(checkInterval);
        elapsed += checkInterval;

        // Check if we're now on a non-login page
        const currentUrl = this.page.url();
        const isStillOnLogin = currentUrl.includes('login.1688.com') ||
                               currentUrl.includes('login.taobao.com');

        if (!isStillOnLogin) {
          logger.info('Detected navigation away from login page - assuming login successful');

          // Trust the navigation - user is logged in
          // The persistent Chrome profile will maintain the session
          this.isLoggedIn = true;
          await this.saveCookies();
          logger.info('Manual login successful! Session saved.');
          return true;
        }

        // Log progress
        const remaining = Math.ceil((maxWaitTime - elapsed) / 1000);
        if (elapsed % 30000 === 0) { // Log every 30 seconds
          logger.info(`Still waiting for login... (${remaining}s remaining)`);
        }
      }

      logger.warn('Manual login timed out after 5 minutes');
      return false;
    } catch (error) {
      logger.error('Manual login failed', { error: (error as Error).message });
      return false;
    }
  }

  // Simulate human-like mouse movement
  private async humanMouseMove(page: Page): Promise<void> {
    const width = 1920;
    const height = 1080;

    // Random starting position
    let x = Math.floor(Math.random() * width);
    let y = Math.floor(Math.random() * height);

    // Move mouse in a natural curve pattern
    for (let i = 0; i < 3; i++) {
      const targetX = Math.floor(Math.random() * width);
      const targetY = Math.floor(Math.random() * height);

      // Move in steps to simulate human movement
      const steps = Math.floor(Math.random() * 10) + 5;
      for (let step = 0; step < steps; step++) {
        x += (targetX - x) / (steps - step);
        y += (targetY - y) / (steps - step);
        await page.mouse.move(x, y);
        await sleep(Math.random() * 50 + 10);
      }

      await sleep(Math.random() * 200 + 100);
    }
  }

  // Check if we're on an anti-bot page and wait for resolution
  private async handleAntiBotPage(): Promise<boolean> {
    if (!this.page) return false;

    const currentUrl = this.page.url();
    const isPunishPage = currentUrl.includes('/_____tmd_____/punish') ||
                         currentUrl.includes('punish?x5secdata');

    if (isPunishPage) {
      logger.warn('Detected anti-bot challenge page, waiting for resolution...');

      // Save screenshot for debugging
      try {
        const logsDir = path.resolve(__dirname, '../../logs');
        ensureDirectoryExists(logsDir);
        const screenshotPath = path.join(logsDir, `antibot-${Date.now()}.png`);
        await this.page.screenshot({ path: screenshotPath, fullPage: true });
        logger.info('Anti-bot screenshot saved', { path: screenshotPath });
      } catch (err) {
        // Ignore screenshot errors
      }

      // Wait for manual resolution or automatic resolution
      logger.info('Waiting 90 seconds for anti-bot challenge resolution...');
      await sleep(90000);

      // Check if still on punish page
      const stillBlocked = this.page.url().includes('punish');
      if (stillBlocked) {
        logger.error('Still blocked by anti-bot after waiting');
        return false;
      }

      logger.info('Anti-bot challenge resolved');
      return true;
    }

    return true;
  }

  async login(): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');

    logger.info('Logging into 1688.com');

    // First, try to restore session from saved cookies
    logger.info('Checking for saved session...');
    const cookiesLoaded = await this.loadCookies();

    if (cookiesLoaded) {
      logger.info('Cookies loaded, validating session...');
      const sessionValid = await this.isSessionValid();

      if (sessionValid) {
        logger.info('Session restored from cookies - already logged in!');
        this.isLoggedIn = true;
        return true;
      } else {
        logger.info('Saved session expired, proceeding with fresh login');
      }
    }

    try {
      // Clear any in-progress navigation from session validation to avoid frame detachment
      await this.page.goto('about:blank', { waitUntil: 'load', timeout: 10000 }).catch(() => {});
      await sleep(500);

      // Navigate to 1688 My Alibaba page - it will redirect to login if not authenticated
      await this.page.goto('https://work.1688.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await sleep(5000); // Let redirect chain settle; page may navigate several times

      // Check if page is still open after redirects
      if (!this.page || this.page.isClosed()) {
        logger.warn('Page closed during redirect, switching to manual login');
        return await this.manualLogin();
      }

      // Simulate human mouse movement (best-effort, skip on error)
      await this.humanMouseMove(this.page).catch(() => {});

      // Check for anti-bot page first
      const antiBotResolved = await this.handleAntiBotPage();
      if (!antiBotResolved) {
        logger.error('Anti-bot page detected during login');
      }

      // Wait for any login form with flexible selectors
      const loginFormSelectors = [
        '#fm-login-id',
        'input[name="loginId"]',
        'input[name="fm-login-id"]',
        'input[type="text"][placeholder*="账号"]',
        'input[type="text"][placeholder*="手机"]',
        'input[type="text"][placeholder*="邮箱"]',
        '.fm-field input[type="text"]',
        'input[id*="login"]',
      ];

      let usernameInput = null;
      for (const selector of loginFormSelectors) {
        try {
          await this.page.waitForSelector(selector, { timeout: 5000 });
          usernameInput = await this.page.$(selector);
          if (usernameInput) {
            logger.info('Found username input', { selector });
            break;
          }
        } catch {
          continue;
        }
      }

      if (!usernameInput) {
        // Could not find login form - switch to manual login mode
        logger.warn('Could not find login form automatically');
        logger.info('Switching to manual login mode...');

        // Use the interactive manual login
        return await this.manualLogin();
      } else {
        // Random delay before typing (human hesitation)
        await randomDelay(1000, 2000);

        // Clear and fill username with human-like typing
        await usernameInput.evaluate((el: HTMLInputElement) => { el.value = ''; });
        await usernameInput.focus();
        await this.humanType(this.page, config.alibaba1688.username);

        await randomDelay(800, 1500);

        // Move mouse to password field area
        await this.humanMouseMove(this.page);

        // Find password field with flexible selectors
        const passwordSelectors = [
          '#fm-login-password',
          'input[name="password"]',
          'input[type="password"]',
          '.fm-field input[type="password"]',
        ];

        let passwordInput = null;
        for (const selector of passwordSelectors) {
          passwordInput = await this.page.$(selector);
          if (passwordInput) break;
        }

        if (passwordInput) {
          await passwordInput.evaluate((el: HTMLInputElement) => { el.value = ''; });
          await passwordInput.focus();
          await this.humanType(this.page, config.alibaba1688.password);
        }

        await randomDelay(1500, 3000);

        // Move mouse before clicking
        await this.humanMouseMove(this.page);

        // Click login button with flexible selectors
        const loginButtonSelectors = [
          '.fm-button.fm-submit.password-login',
          '.fm-button.fm-submit',
          'button[type="submit"]',
          '.login-btn',
          '[class*="submit"]',
        ];

        let loginButton = null;
        for (const selector of loginButtonSelectors) {
          loginButton = await this.page.$(selector);
          if (loginButton) {
            await loginButton.click();
            break;
          }
        }

        if (!loginButton) {
          await this.page.evaluate(() => {
            const btn = document.querySelector('button, [class*="submit"], [class*="login"]') as HTMLElement;
            if (btn) btn.click();
          });
        }
      }

      // Wait for navigation or captcha
      await sleep(5000);

      // Check current URL - may redirect to Taobao login
      let currentUrl = this.page.url();
      logger.info('Post-login URL', { url: currentUrl });

      // Handle Taobao SSO login if redirected there
      if (currentUrl.includes('login.taobao.com')) {
        logger.info('Redirected to Taobao SSO, attempting login there');
        await this.handleTaobaoLogin();
      }

      // Check if still on a login page
      currentUrl = this.page.url();
      if (currentUrl.includes('login')) {
        logger.warn('Login might require captcha or verification');
        logger.info('Waiting for manual captcha solving (90 seconds)...');
        await sleep(90000);
      }

      // Verify login by navigating to 1688 and checking for logged-in state
      await this.page.goto('https://www.1688.com', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      await sleep(3000);

      // Check for login state with multiple indicators
      const loggedIn = await this.page.evaluate(() => {
        // Look for various logged-in indicators
        const userElements = [
          '.sm-widget-myinfo',
          '.user-name',
          '[class*="login-info"]',
          '[class*="user-info"]',
          '[class*="member-info"]',
          '.username',
          '[data-spm*="user"]',
        ];
        for (const selector of userElements) {
          if (document.querySelector(selector)) return true;
        }
        // Check if logout link exists (means logged in)
        const logoutLink = document.querySelector('a[href*="logout"], [class*="logout"]');
        if (logoutLink) return true;
        return false;
      });

      if (loggedIn) {
        this.isLoggedIn = true;
        logger.info('Successfully logged into 1688.com');
        // Save cookies for future sessions
        await this.saveCookies();
        return true;
      }

      // Take screenshot of current state
      const logsDir = path.resolve(__dirname, '../../logs');
      ensureDirectoryExists(logsDir);
      await this.page.screenshot({ path: path.join(logsDir, `login-verify-${Date.now()}.png`), fullPage: true });

      // Even if verification is uncertain, save cookies in case they're valid
      logger.warn('Login verification uncertain, saving cookies anyway');
      await this.saveCookies();
      this.isLoggedIn = true;
      return true;
    } catch (error) {
      logger.error('Login failed', { error: (error as Error).message });
      return false;
    }
  }

  // Human-like typing with variable delays
  private async humanType(page: Page, text: string): Promise<void> {
    for (const char of text) {
      await page.keyboard.type(char);
      // Variable delay between keystrokes (50-200ms)
      await sleep(Math.random() * 150 + 50);
      // Occasionally add a longer pause (simulating human thinking)
      if (Math.random() < 0.1) {
        await sleep(Math.random() * 300 + 100);
      }
    }
  }

  // Handle Taobao SSO login (used by 1688)
  private async handleTaobaoLogin(): Promise<void> {
    if (!this.page) return;

    logger.info('Handling Taobao SSO login');

    try {
      await randomDelay(2000, 3000);
      await this.humanMouseMove(this.page);

      // Taobao login uses different selectors
      const usernameSelectors = [
        '#fm-login-id',
        '#TPL_username_1',
        'input[name="TPL_username"]',
        'input[name="fm-login-id"]',
        'input[id*="username"]',
        '.input-plain',
      ];

      let usernameInput = null;
      for (const selector of usernameSelectors) {
        usernameInput = await this.page.$(selector);
        if (usernameInput) {
          logger.info('Found Taobao username field', { selector });
          break;
        }
      }

      if (usernameInput) {
        await usernameInput.evaluate((el: HTMLInputElement) => { el.value = ''; });
        await usernameInput.focus();
        await this.humanType(this.page, config.alibaba1688.username);

        await randomDelay(800, 1500);
        await this.humanMouseMove(this.page);

        // Find password field
        const passwordSelectors = [
          '#fm-login-password',
          '#TPL_password_1',
          'input[name="TPL_password"]',
          'input[type="password"]',
        ];

        let passwordInput = null;
        for (const selector of passwordSelectors) {
          passwordInput = await this.page.$(selector);
          if (passwordInput) break;
        }

        if (passwordInput) {
          await passwordInput.evaluate((el: HTMLInputElement) => { el.value = ''; });
          await passwordInput.focus();
          await this.humanType(this.page, config.alibaba1688.password);
        }

        await randomDelay(1500, 2500);
        await this.humanMouseMove(this.page);

        // Click login button
        const loginButtonSelectors = [
          '#J_SubmitStatic',
          '.fm-button',
          'button[type="submit"]',
          '.login-btn',
          '[class*="submit"]',
        ];

        for (const selector of loginButtonSelectors) {
          const loginButton = await this.page.$(selector);
          if (loginButton) {
            await loginButton.click();
            logger.info('Clicked Taobao login button', { selector });
            break;
          }
        }

        await sleep(5000);
      } else {
        logger.warn('Could not find Taobao login form');
        // Take screenshot
        const logsDir = path.resolve(__dirname, '../../logs');
        ensureDirectoryExists(logsDir);
        await this.page.screenshot({ path: path.join(logsDir, `taobao-login-${Date.now()}.png`), fullPage: true });
      }
    } catch (error) {
      logger.error('Taobao login handling failed', { error: (error as Error).message });
    }
  }

  private async scrollToLoadContent(): Promise<void> {
    if (!this.page) return;

    // Human-like scrolling with variable speeds and pauses
    const scrollSteps = Math.floor(Math.random() * 3) + 4; // 4-6 scrolls

    for (let i = 0; i < scrollSteps; i++) {
      // Variable scroll distance (300-900px)
      const scrollDistance = Math.floor(Math.random() * 600) + 300;
      await this.page.evaluate((dist) => window.scrollBy(0, dist), scrollDistance);

      // Variable pause between scrolls (800-2000ms)
      await sleep(Math.random() * 1200 + 800);

      // Occasionally pause longer (simulating reading)
      if (Math.random() < 0.3) {
        await sleep(Math.random() * 1500 + 500);
      }

      // Random mouse movement during scroll
      if (Math.random() < 0.4) {
        await this.humanMouseMove(this.page);
      }
    }

    // Scroll back to top with smooth behavior
    await this.page.evaluate(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    await sleep(1000);
  }

  private async logDiagnostics(pageNum: number): Promise<void> {
    if (!this.page) return;

    const currentUrl = this.page.url();
    logger.warn('0 products found — running diagnostics', { url: currentUrl, page: pageNum });

    // Log a sample of the page HTML
    const bodySnippet = await this.page.evaluate(() => {
      return document.body?.innerHTML?.substring(0, 2000) || '(empty body)';
    });
    logger.warn('Page HTML snippet (first 2000 chars)', { html: bodySnippet });

    // Log all <a> tags with offer/detail in their href
    const offerLinks = await this.page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links
        .map(a => a.href)
        .filter(href => /offer|detail/i.test(href))
        .slice(0, 20);
    });
    logger.warn('Links containing "offer" or "detail"', { links: offerLinks });

    // Save a screenshot for debugging
    try {
      const logsDir = path.resolve(__dirname, '../../logs');
      ensureDirectoryExists(logsDir);
      const screenshotPath = path.join(logsDir, `debug-page${pageNum}-${Date.now()}.png`);
      await this.page.screenshot({ path: screenshotPath, fullPage: true });
      logger.info('Diagnostic screenshot saved', { path: screenshotPath });
    } catch (err) {
      logger.warn('Failed to save diagnostic screenshot', { error: (err as Error).message });
    }
  }

  // Load product URLs from file (manually collected by user)
  private loadProductUrlsFromFile(): string[] {
    try {
      if (!fs.existsSync(PRODUCT_URLS_FILE)) {
        return [];
      }

      const content = fs.readFileSync(PRODUCT_URLS_FILE, 'utf-8');
      const urls = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#') && line.includes('1688.com'));

      logger.info('Loaded product URLs from file', { count: urls.length });
      return urls;
    } catch (error) {
      logger.warn('Failed to load product URLs file', { error: (error as Error).message });
      return [];
    }
  }

  // Browse products from manually collected URLs - bypasses search anti-bot
  async browseCategoryProducts(category: string, maxProducts: number = 50): Promise<ScrapedProduct[]> {
    if (!this.page) throw new Error('Browser not initialized');

    const products: ScrapedProduct[] = [];

    // First, try to load URLs from file
    const manualUrls = this.loadProductUrlsFromFile();

    if (manualUrls.length > 0) {
      logger.info('Using manually collected product URLs', { count: manualUrls.length, category });

      for (const url of manualUrls) {
        if (products.length >= maxProducts) break;

        try {
          // Extract product ID from URL
          const idMatch = url.match(/offerId=(\d+)/) || url.match(/offer\/(\d+)/) || url.match(/(\d{10,})/);
          const id1688 = idMatch ? idMatch[1] : '';

          if (!id1688) {
            logger.warn('Could not extract product ID from URL', { url });
            continue;
          }

          // Create basic product entry - details will be fetched later
          const product: ScrapedProduct = {
            id1688,
            title: '',
            description: '',
            priceCNY: 0,
            images: [],
            specifications: [],
            seller: { name: '' },
            category,
            minOrderQty: 1,
            url: url.includes('detail') ? url : `https://detail.1688.com/offer/${id1688}.html`,
            scrapedAt: new Date(),
          };

          products.push(product);
          logger.info('Added product from manual URL', { id1688, url });

        } catch (error) {
          logger.warn('Failed to process manual URL', { url, error: (error as Error).message });
        }
      }

      logger.info('Loaded products from manual URLs', { count: products.length });
      return products;
    }

    // No manual URLs - skip homepage browsing (often blocked by anti-bot)
    // Will fall through to search-based scraping
    logger.info('No manual URLs found, will use search');

    logger.info('Category browsing completed', { category, totalProducts: products.length });
    return products;
  }

  async searchProducts(category: string, maxProducts: number = 50): Promise<ScrapedProduct[]> {
    if (!this.page) throw new Error('Browser not initialized');

    // Translate English category to Chinese keyword for 1688.com search
    const searchTerm = categoryKeywords[category] || category;
    logger.info('Searching products', { category, searchTerm, maxProducts });

    const products: ScrapedProduct[] = [];
    let page = 1;
    let retryCount = 0;
    const maxRetries = 2;

    const minPrice = config.filters.minPriceCNY;
    const maxPrice = config.filters.maxPriceCNY;

    try {
      // Close stale tabs from previous search — keep only one tab
      const allTabs = await this.browser!.pages();
      if (allTabs.length > 1) {
        // Keep the first valid tab, close the rest
        this.page = allTabs[0];
        for (let i = allTabs.length - 1; i > 0; i--) {
          try { await allTabs[i].close(); } catch { /* already closed */ }
        }
        logger.info('Closed stale tabs before new search', { closed: allTabs.length - 1 });
      }

      // Verify page is still usable (not detached)
      try {
        await this.page.evaluate(() => document.title);
      } catch {
        // Page is detached — create a fresh one
        logger.warn('Page was detached, creating fresh tab');
        this.page = await this.browser!.newPage();
      }

      // Navigate to 1688 homepage and type Chinese keywords into search bar
      await this.page.goto('https://www.1688.com', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      await randomDelay(3000, 5000);

      // Wait for page to be usable - if blank or anti-bot, wait for user on China MacBook
      const pageIsUsable = async (): Promise<boolean> => {
        const url = this.page!.url();
        if (url.includes('punish') || url.includes('_____tmd_____')) return false;
        const inputCount = await this.page!.evaluate(() => document.querySelectorAll('input').length);
        return inputCount > 0;
      };

      if (!(await pageIsUsable())) {
        logger.warn('='.repeat(60));
        logger.warn('Page blocked by anti-bot! Please go to the China MacBook browser:');
        logger.warn('1. Navigate to www.1688.com');
        logger.warn('2. Solve any CAPTCHA / slider verification');
        logger.warn('3. Make sure the homepage loads with search bar visible');
        logger.warn('Waiting up to 3 minutes...');
        logger.warn('='.repeat(60));

        const maxWait = 180000;
        let waited = 0;
        while (waited < maxWait) {
          await sleep(5000);
          waited += 5000;
          if (await pageIsUsable()) {
            logger.info('Page is now usable!');
            break;
          }
          if (waited % 30000 === 0) {
            logger.info(`Still waiting... (${Math.ceil((maxWait - waited) / 1000)}s remaining)`);
          }
        }

        if (!(await pageIsUsable())) {
          logger.error('Page still not usable after waiting');
          return products;
        }
      }

      logger.info('Homepage loaded, looking for search input...');
      await randomDelay(1000, 2000);

      // Find the search input on the page
      const searchInputSelectors = [
        '#alisearch-input',
        'input[name="keywords"]',
        '.search-input input',
        'input.search-input',
        'input[placeholder*="搜索"]',
        'input[placeholder*="找货"]',
        '.home-search input',
      ];

      let searchInput = null;
      for (const selector of searchInputSelectors) {
        try {
          searchInput = await this.page.$(selector);
          if (searchInput) {
            logger.info('Found search input', { selector });
            break;
          }
        } catch {
          continue;
        }
      }

      if (!searchInput) {
        // Generic detection - find large input near top of page
        const genericInput = await this.page.evaluateHandle(() => {
          const inputs = Array.from(document.querySelectorAll('input'));
          for (const input of inputs) {
            const rect = (input as HTMLElement).getBoundingClientRect();
            if (rect.top > 0 && rect.top < 300 && rect.width > 150 && rect.height > 15) {
              return input;
            }
          }
          return null;
        });
        const el = genericInput.asElement();
        if (el) {
          searchInput = el;
          logger.info('Found search input via generic detection');
        } else {
          logger.error('Could not find search input');
          return products;
        }
      }

      // Type Chinese characters directly into the search box
      await this.humanMouseMove(this.page);
      await searchInput.click();
      await randomDelay(500, 1000);
      await searchInput.evaluate((el: HTMLInputElement) => { el.value = ''; });

      logger.info('Typing Chinese search term into search box', { searchTerm });
      await this.humanType(this.page, searchTerm);
      await randomDelay(800, 1500);

      // Click search button or press Enter
      const btnSelectors = ['.home-search-btn', '.alisearch-submit', 'button[type="submit"]', '.search-btn', '[class*="search-button"]'];
      let clicked = false;
      for (const sel of btnSelectors) {
        const btn = await this.page.$(sel);
        if (btn) {
          logger.info('Clicking search button', { selector: sel });
          await btn.click();
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        logger.info('Pressing Enter to search');
        await this.page.keyboard.press('Enter');
      }

      // Wait for results - search may open new tab
      await sleep(3000);
      const allPages = await this.browser!.pages();
      if (allPages.length > 1) {
        // Switch to the newest tab (search results)
        const newPage = allPages[allPages.length - 1];
        this.page = newPage;
        logger.info('Switched to new search results tab', { tabs: allPages.length });

        // Wait for the new tab to finish loading (it may already be loaded)
        try {
          await newPage.waitForSelector('body', { timeout: 10000 });
        } catch {
          logger.warn('New tab body wait timed out, continuing');
        }
      } else {
        // Search didn't open new tab — wait for navigation in current page
        await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {
          logger.warn('Navigation wait timed out, continuing');
        });
      }

      await randomDelay(3000, 5000);

      // Handle anti-bot on search results
      let currentUrl = this.page.url();
      if (currentUrl.includes('punish') || currentUrl.includes('_____tmd_____')) {
        logger.warn('Anti-bot on search results! Please solve CAPTCHA on China MacBook...');
        const maxWait = 180000;
        let waited = 0;
        while (waited < maxWait) {
          await sleep(5000);
          waited += 5000;
          currentUrl = this.page.url();
          if (!currentUrl.includes('punish') && !currentUrl.includes('_____tmd_____')) {
            logger.info('Anti-bot resolved!');
            break;
          }
          if (waited % 30000 === 0) {
            logger.info(`Still waiting for CAPTCHA... (${Math.ceil((maxWait - waited) / 1000)}s remaining)`);
          }
        }
        if (currentUrl.includes('punish') || currentUrl.includes('_____tmd_____')) {
          logger.error('Anti-bot not resolved in time');
          return products;
        }
      }

      logger.info('Search results loaded', { url: this.page.url() });

      // Simulate human mouse movement
      await this.humanMouseMove(this.page);

      // Scroll to trigger lazy-loading before first extraction
      await this.scrollToLoadContent();

      let emptyPageCount = 0;
      while (products.length < maxProducts) {
        // Wait for product list to load — try multiple selectors
        await this.page.waitForSelector(
          '.sm-offer-list, .offer-list, [class*="offer-item"], [class*="offer-card"], [class*="CardContainer"], [class*="offerCard"]',
          { timeout: 30000 }
        ).catch(() => {
          logger.warn('Product list selector not found, will attempt extraction anyway');
        });

        // Extract products from current page
        const pageProducts = await this.extractProductsFromPage();

        logger.info('Extracted products from page', {
          page,
          count: pageProducts.length,
        });

        // If 0 products found, log diagnostics and stop after 2 consecutive empty pages
        if (pageProducts.length === 0) {
          await this.logDiagnostics(page);
          emptyPageCount++;
          if (emptyPageCount >= 2) {
            logger.warn('Two consecutive empty pages, stopping search', { page });
            break;
          }
        } else {
          emptyPageCount = 0;
        }

        for (const product of pageProducts) {
          if (products.length >= maxProducts) break;

          // Filter: Skip Apple brand products
          if (isAppleBrand(product.title)) {
            logger.debug('Skipping Apple brand product', { title: product.title.substring(0, 50) });
            continue;
          }

          // Filter: Check price range
          if (product.priceCNY < minPrice || product.priceCNY > maxPrice) {
            logger.debug('Skipping product outside price range', {
              price: product.priceCNY,
              title: product.title.substring(0, 50),
            });
            continue;
          }

          // Filter: Check minimum order quantity
          if (product.minOrderQty > config.filters.minOrderQty) {
            logger.debug('Skipping product with high MOQ', {
              moq: product.minOrderQty,
              title: product.title.substring(0, 50),
            });
            continue;
          }

          product.category = category;
          products.push(product);
        }

        // Check if there are more pages — broader selectors
        const hasNextPage = await this.page.evaluate(() => {
          const nextBtn = document.querySelector(
            '.fui-next:not(.fui-disabled), .sm-pagination-next:not(.disabled), [class*="next"]:not([class*="disabled"]), a[class*="page-next"]'
          );
          return !!nextBtn;
        });

        if (!hasNextPage || products.length >= maxProducts) {
          break;
        }

        // Go to next page by clicking the next button (avoids anti-bot from URL navigation)
        page++;
        const clicked = await this.page.evaluate(() => {
          const nextBtn = document.querySelector(
            '.fui-next:not(.fui-disabled), .sm-pagination-next:not(.disabled), [class*="next"]:not([class*="disabled"]), a[class*="page-next"]'
          ) as HTMLElement;
          if (nextBtn) {
            nextBtn.click();
            return true;
          }
          return false;
        });

        if (!clicked) {
          logger.warn('Could not click next page button, stopping');
          break;
        }

        // Wait for page to load after clicking next
        await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {
          logger.warn('Next page navigation timed out');
        });

        // Human-like delay
        await randomDelay(4000, 7000);

        // Check for anti-bot page on each navigation
        const pageAntiBotResolved = await this.handleAntiBotPage();
        if (!pageAntiBotResolved) {
          logger.warn('Anti-bot challenge on page navigation, stopping search');
          break;
        }

        // Human-like mouse movement
        await this.humanMouseMove(this.page);

        // Scroll to trigger lazy-loading on each new page
        await this.scrollToLoadContent();
      }
    } catch (error) {
      logger.error('Search failed', { category, error: (error as Error).message });
    }

    logger.info('Search completed', { category, totalProducts: products.length });
    return products;
  }

  private async extractProductsFromPage(): Promise<ScrapedProduct[]> {
    if (!this.page) return [];

    const products = await this.page.evaluate(() => {
      const items: any[] = [];
      const seenIds = new Set<string>();

      function extractFromElement(element: Element): void {
        try {
          // Extract product ID from link - support both old and new URL formats
          const linkElement = element.querySelector('a[href*="detail"], a[href*="offer"], a[href*="offerId"]') as HTMLAnchorElement;
          const href = linkElement?.href || '';
          // New format: detail.m.1688.com/page/index.html?offerId=768284470894
          // Old format: detail.1688.com/offer/768284470894.html
          const idMatch = href.match(/offerId=(\d+)/) || href.match(/offer\/(\d+)\.html/) || href.match(/(\d+)\.html/);
          const id1688 = idMatch ? idMatch[1] : '';

          if (!id1688 || seenIds.has(id1688)) return;
          seenIds.add(id1688);

          // Extract title — try multiple selectors, fall back to link text
          const titleElement = element.querySelector(
            '[class*="title"], h4, h3, a[href*="offer"]'
          );
          const title = titleElement?.textContent?.trim() || '';

          // Extract price — try multiple selectors, extract first number
          const priceElement = element.querySelector(
            '.sm-offer-priceNum, [class*="price"], [class*="Price"]'
          );
          const priceText = priceElement?.textContent || '0';
          const priceMatch = priceText.match(/[\d.]+/);
          const priceCNY = priceMatch ? parseFloat(priceMatch[0]) : 0;

          // Extract image — try various image selectors and data attributes
          const imageElement = element.querySelector(
            'img[src*="cbu01"], img[src*="alicdn"], img[data-src]'
          ) as HTMLImageElement;
          let imageUrl = '';
          if (imageElement) {
            imageUrl = imageElement.src
              || imageElement.getAttribute('data-src')
              || imageElement.getAttribute('data-lazy-src')
              || '';
          }
          // Convert to full-size image by stripping thumbnail suffix
          imageUrl = imageUrl.replace(/\.(jpg|jpeg|png)(_.*)$/i, '.$1');

          // Extract minimum order quantity
          const moqElement = element.querySelector(
            '.sm-offer-minOrder, [class*="minOrder"], [class*="moq"]'
          );
          const moqText = moqElement?.textContent || '1';
          const moqMatch = moqText.match(/(\d+)/);
          const minOrderQty = moqMatch ? parseInt(moqMatch[1]) : 1;

          // Extract seller info
          const sellerElement = element.querySelector(
            '.sm-offer-companyName, [class*="company"], [class*="seller"], [class*="shop"]'
          );
          const sellerName = sellerElement?.textContent?.trim() || '';

          items.push({
            id1688,
            title,
            description: '',
            priceCNY,
            images: imageUrl ? [imageUrl] : [],
            specifications: [],
            seller: { name: sellerName },
            category: '',
            minOrderQty,
            url: `https://detail.1688.com/offer/${id1688}.html`,
            scrapedAt: new Date().toISOString(),
          });
        } catch (e) {
          // Skip problematic elements
        }
      }

      // Strategy A: Try known selectors first
      let productElements = document.querySelectorAll(
        '.sm-offer-item, .offer-item, [class*="offer-card"], .space-offer-card-box'
      );

      // Strategy B: If A finds nothing, try generic card-like containers
      if (productElements.length === 0) {
        productElements = document.querySelectorAll(
          '[class*="CardContainer"], [class*="cardContainer"], [class*="offerCard"], [class*="OfferCard"]'
        );
      }

      if (productElements.length > 0) {
        productElements.forEach(el => extractFromElement(el));
      } else {
        // Strategy C: Anchor-based extraction — find product links and walk up to container
        const productLinks = document.querySelectorAll(
          'a[href*="detail.1688.com/offer/"], a[href*="detail.m.1688.com"], a[href*="offerId="], a[href*="dj.1688.com/"]'
        );

        productLinks.forEach((link) => {
          // Walk up to a reasonable parent container (up to 5 levels)
          let container: Element | null = link;
          for (let i = 0; i < 5; i++) {
            if (container.parentElement) {
              container = container.parentElement;
              // Stop if the container looks card-sized (has some minimum height)
              const rect = container.getBoundingClientRect();
              if (rect.height > 100 && rect.width > 100) break;
            }
          }
          if (container) {
            extractFromElement(container);
          }
        });
      }

      return items;
    });

    return products as ScrapedProduct[];
  }

  // Extract SKU variant data from the current 1688 product page.
  // Strategy A (primary): Parse [data-module*="sku"] text content — modern 1688 pages.
  //   Text pattern: "颜色{name}¥{price}库存{stock}条{name2}¥{price2}库存{stock2}条..."
  // Strategy B (fallback): Parse window.__INIT_DATA__ JS variable — older 1688 pages.
  private async extractVariants(): Promise<ProductVariants | null> {
    if (!this.page) return null;

    // Scroll down to trigger lazy-loading of SKU section (intersection observer pattern)
    await this.page.evaluate(() => window.scrollTo(0, 600));
    await sleep(1500);

    // Strategy A: Parse [data-module*="sku"] DOM element text
    const fromSKUModule = await this.page.evaluate(() => {
      const skuDiv = document.querySelector('[data-module*="sku"]');
      if (!skuDiv) return null;

      const fullText = (skuDiv as HTMLElement).textContent?.trim() || '';
      if (!fullText) return null;

      // Parse entries: each SKU is "{name}¥{price}库存{stock}条"
      const entries = fullText.match(/(.+?)¥([\d.]+)库存(\d+)条/g);
      if (!entries || entries.length === 0) return null;

      let optionName = '';
      const skus: Array<{
        optionValues: Record<string, string>;
        priceCNY: number;
        stock?: number;
        available: boolean;
      }> = [];
      const values: string[] = [];

      for (let i = 0; i < entries.length; i++) {
        const match = entries[i].match(/(.+?)¥([\d.]+)库存(\d+)条/);
        if (!match) continue;

        let name = match[1];
        if (i === 0) {
          // First entry includes the option name prefix (e.g., "颜色黑色")
          const optMatch = name.match(/^(颜色|尺码|规格|型号|款式|尺寸|包装|版本)/);
          if (optMatch) {
            optionName = optMatch[1];
            name = name.substring(optionName.length);
          }
        }

        name = name.trim();
        const price = parseFloat(match[2]);
        const stock = parseInt(match[3], 10);

        values.push(name);
        skus.push({
          optionValues: { [optionName || '颜色']: name },
          priceCNY: price,
          stock: stock > 0 ? stock : undefined,
          available: stock > 0,
        });
      }

      if (values.length === 0) return null;

      return {
        options: [{ name: optionName || '颜色', values }],
        skus,
      };
    });

    if (fromSKUModule && fromSKUModule.options.length > 0 && fromSKUModule.skus.length > 0) {
      logger.debug('Variants extracted via [data-module="sku"] text parsing');
      return fromSKUModule as ProductVariants;
    }

    // Strategy B: Extract from JS variables (older 1688 page format)
    const fromJS = await this.page.evaluate(() => {
      try {
        const initData = (window as any).__INIT_DATA__
          || (window as any).__DetailData__
          || (window as any).detailData;

        if (!initData) return null;

        const skuModule = initData?.data?.skuModel
          || initData?.data?.componentsData?.sku
          || initData?.globalData?.skuModel
          || initData?.data?.sku;

        if (!skuModule) return null;

        const rawProps = skuModule.skuProps || skuModule.skuInfoMapOriginal?.skuProps || [];
        const options: Array<{ name: string; values: string[] }> = [];
        const imageMap: Record<string, string> = {};

        for (const prop of rawProps) {
          const propName = prop.prop || prop.fid || prop.propName || prop.name || '';
          const rawValues = prop.value || prop.values || [];
          const values: string[] = [];
          for (const v of rawValues) {
            const valueName = v.name || v.value || v.text || '';
            if (valueName) {
              values.push(valueName);
              const img = v.imageUrl || v.img || v.image || '';
              if (img) imageMap[valueName] = img.replace(/\.(jpg|jpeg|png)(_.*)$/i, '.$1');
            }
          }
          if (propName && values.length > 0) options.push({ name: propName, values });
        }

        if (options.length === 0) return null;

        const skuInfoMap = skuModule.skuInfoMap || skuModule.skuInfoMapOriginal?.skuInfoMap || {};
        const skus: Array<{
          optionValues: Record<string, string>;
          priceCNY: number;
          image?: string;
          stock?: number;
          available: boolean;
        }> = [];

        for (const [key, info] of Object.entries(skuInfoMap)) {
          const skuInfo = info as any;
          const valueNames = key.split(/&gt;|>/);
          const optionValues: Record<string, string> = {};
          for (let i = 0; i < Math.min(valueNames.length, options.length); i++) {
            optionValues[options[i].name] = valueNames[i].trim();
          }
          const price = parseFloat(skuInfo.price || skuInfo.discountPrice || skuInfo.originalPrice || '0');
          const stock = parseInt(skuInfo.canBookCount || skuInfo.stock || '0', 10);
          skus.push({
            optionValues,
            priceCNY: price,
            image: imageMap[valueNames[0]?.trim()] || undefined,
            stock: stock > 0 ? stock : undefined,
            available: stock > 0,
          });
        }

        if (skus.length === 0 && options.length === 1) {
          const priceEl = document.querySelector('.price-original-sku em, [class*="price"] em');
          const basePrice = parseFloat(priceEl?.textContent?.match(/[\d.]+/)?.[0] || '0');
          for (const val of options[0].values) {
            skus.push({
              optionValues: { [options[0].name]: val },
              priceCNY: basePrice,
              image: imageMap[val] || undefined,
              available: true,
            });
          }
        }

        return { options, skus };
      } catch (e) {
        return null;
      }
    });

    if (fromJS && fromJS.options.length > 0) {
      logger.debug('Variants extracted via __INIT_DATA__ JS variable');
      return fromJS as ProductVariants;
    }

    // Strategy C: Modern 1688 React DOM — extract from rendered option labels/buttons
    // Scroll a bit more to ensure SKU section is fully rendered
    await this.page.evaluate(() => window.scrollTo(0, 800));
    await sleep(1000);

    const fromDom = await this.page.evaluate(() => {
      // Modern 1688 product pages (2024+) render SKU options as labelled sections
      // Container selectors for the SKU property block
      const containerSelectors = [
        '[class*="od-sku"]',
        '[class*="sku-module"]',
        '[class*="offer-attr"]',
        '[class*="sku-wrap"]',
        '[class*="sku-property"]',
        '[class*="attr-wrap"]',
        '[class*="product-sku"]',
        '[class*="detail-sku"]',
      ];

      let skuContainer: Element | null = null;
      for (const sel of containerSelectors) {
        skuContainer = document.querySelector(sel);
        if (skuContainer) break;
      }

      if (!skuContainer) {
        // Log what's in the DOM to help debug
        const allClasses = Array.from(document.querySelectorAll('[class]'))
          .map(e => e.className?.toString() || '')
          .filter(c => c.length > 0)
          .join('\n')
          .substring(0, 2000);
        (window as any).__skuDebugClasses = allClasses;
        return null;
      }

      // Extract title+options pairs from the SKU container
      const titleSelectors = [
        '[class*="sku-title"]', '[class*="attr-title"]',
        '[class*="prop-title"]', '[class*="label"]',
      ];
      const itemSelectors = [
        '[class*="sku-item"]', '[class*="attr-item"]',
        '[class*="prop-item"]', '[class*="option-item"]',
        'button', 'span[class*="item"]',
      ];

      // options: values + per-value image URLs (color dimension has images; size does not)
      const options: Array<{ name: string; values: string[]; images: (string | undefined)[] }> = [];

      // Try to find dimension title elements
      let titleEls: NodeListOf<Element> | null = null;
      for (const sel of titleSelectors) {
        const found = skuContainer.querySelectorAll(sel);
        if (found.length > 0) { titleEls = found; break; }
      }

      if (!titleEls || titleEls.length === 0) {
        // Fallback: extract all text nodes and look for 颜色/尺码 patterns (no images in text fallback)
        const text = skuContainer.textContent || '';
        const colorMatch = text.match(/颜色[分类]?[：:]?\s*([^\n尺码]+)/);
        const sizeMatch = text.match(/尺[码寸][：:]?\s*([^\n颜色]+)/);
        if (colorMatch || sizeMatch) {
          if (colorMatch) {
            const vals = colorMatch[1].split(/[\s，,]+/).filter(v => v.trim().length > 0 && v.trim().length < 30);
            if (vals.length > 0) options.push({ name: '颜色', values: vals, images: vals.map(() => undefined) });
          }
          if (sizeMatch) {
            const vals = sizeMatch[1].split(/[\s，,]+/).filter(v => v.trim().length > 0 && v.trim().length < 10);
            if (vals.length > 0) options.push({ name: '尺码', values: vals, images: vals.map(() => undefined) });
          }
        }
        if (options.length === 0) return null;
      } else {
        for (const titleEl of Array.from(titleEls)) {
          const dimName = titleEl.textContent?.trim().replace(/[：:]\s*$/, '') || '';
          if (!dimName) continue;
          // Find the sibling items
          const parent = titleEl.parentElement;
          if (!parent) continue;
          let itemEls: NodeListOf<Element> | null = null;
          for (const sel of itemSelectors) {
            const found = parent.querySelectorAll(sel);
            if (found.length > 0) { itemEls = found; break; }
          }
          if (!itemEls) continue;
          // Extract text + image URL from each option item
          const rawItems = Array.from(itemEls).map(el => {
            const text = (el.textContent?.trim() || '');
            // Look for <img> inside the option button/label — color swatches have thumbnails
            const img = el.querySelector('img');
            const rawSrc = img?.src || img?.getAttribute('data-src') || img?.getAttribute('data-lazy-src') || '';
            // Strip protocol-relative prefix if present; strip thumbnail suffix (e.g. _100x100.jpg)
            const imageUrl = rawSrc
              ? rawSrc.replace(/^\/\//, 'https://').replace(/\.(jpg|jpeg|png)(_[^"'?]*)?$/i, '.$1')
              : undefined;
            return { text, imageUrl: imageUrl || undefined };
          }).filter(item =>
            item.text.length > 0 && item.text.length < 30
            && !item.text.startsWith('¥')
            && !item.text.match(/^\d+\.\d+$/)
            && !item.text.includes('库存')
            && !item.text.match(/^\d+件$/)
          );
          if (rawItems.length > 0) {
            options.push({
              name: dimName,
              values: rawItems.map(i => i.text),
              images: rawItems.map(i => i.imageUrl),
            });
          }
        }
      }

      if (options.length === 0) return null;

      // Build flat SKU list from option cross-product
      // Color (first dim) images are attached to each SKU so DB can store per-color images
      const skus: Array<{ optionValues: Record<string, string>; image?: string; priceCNY: number; available: boolean }> = [];
      if (options.length === 1) {
        for (let i = 0; i < options[0].values.length; i++) {
          const val = options[0].values[i];
          skus.push({ optionValues: { [options[0].name]: val }, image: options[0].images[i], priceCNY: 0, available: true });
        }
      } else if (options.length >= 2) {
        // First dimension is assumed to be color (has images); second is size (no images)
        for (let i = 0; i < options[0].values.length; i++) {
          const v1 = options[0].values[i];
          const colorImage = options[0].images[i];
          for (const v2 of options[1].values) {
            skus.push({ optionValues: { [options[0].name]: v1, [options[1].name]: v2 }, image: colorImage, priceCNY: 0, available: true });
          }
        }
      }

      return { options: options.map(o => ({ name: o.name, values: o.values })), skus };
    });

    if (fromDom && fromDom.options.length > 0 && fromDom.skus.length > 0) {
      // Log debug classes if available
      const debugClasses = await this.page.evaluate(() => (window as any).__skuDebugClasses || null);
      if (debugClasses) {
        logger.debug('SKU container not found — page classes sample', { classes: debugClasses.substring(0, 500) });
      }
      logger.debug('Variants extracted via modern DOM (Strategy C)', {
        options: fromDom.options.map(o => `${o.name}: ${o.values.length}`),
        skuCount: fromDom.skus.length,
      });
      return fromDom as ProductVariants;
    }

    // Log debug classes when all strategies fail
    const debugClasses = await this.page.evaluate(() => (window as any).__skuDebugClasses || null);
    if (debugClasses) {
      logger.debug('All variant strategies failed — page classes sample', { classes: debugClasses.substring(0, 500) });
    }

    return null;
  }

  async getProductDetails(product: ScrapedProduct): Promise<ScrapedProduct> {
    if (!this.page) throw new Error('Browser not initialized');

    logger.debug('Fetching product details', { id: product.id1688 });

    try {
      await this.page.goto(product.url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      // Wait for the SPA to fully render product content.
      // 1688 uses a React/Vue SPA that renders product images asynchronously.
      // We poll until images appear or timeout after 30s.
      let rendered = false;
      for (let attempt = 0; attempt < 15; attempt++) {
        await sleep(2000);
        const state = await this.page.evaluate(() => ({
          title: document.title,
          imgCbu01: document.querySelectorAll('img[src*="cbu01"]').length,
          hasAntImage: document.querySelectorAll('.ant-image').length,
          isCaptcha: document.title.includes('Captcha'),
        }));

        if (state.isCaptcha) {
          logger.warn('CAPTCHA detected, waiting 15s and reloading...', { id: product.id1688, attempt });
          await sleep(15000);
          await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
          continue;
        }

        if (state.imgCbu01 > 0 || state.hasAntImage > 0) {
          rendered = true;
          logger.info('Product page rendered', {
            id: product.id1688,
            images: state.imgCbu01,
            antImage: state.hasAntImage,
            waitSeconds: (attempt + 1) * 2,
          });
          break;
        }

        logger.debug('Waiting for page to render...', { attempt, imgCbu01: state.imgCbu01 });
      }

      if (!rendered) {
        logger.warn('Page did not fully render after 30s, proceeding with available data', { id: product.id1688 });
      }

      const details = await this.page.evaluate(() => {
        // Extract all product gallery images
        const images: string[] = [];
        const seen = new Set<string>();

        // Strategy 1: Full-size images in ant-image containers
        document.querySelectorAll('.ant-image.v-image-wrap img, .ant-image img').forEach((img: any) => {
          const src = img.src || img.getAttribute('data-src') || '';
          if (src && src.includes('cbu01')) {
            const base = src.replace(/\.(jpg|jpeg|png)(_.*)$/i, '.$1');
            if (!seen.has(base)) {
              seen.add(base);
              images.push(base);
            }
          }
        });

        // Strategy 2: Gallery thumbnail strip (od-gallery)
        if (images.length === 0) {
          document.querySelectorAll('.img-list-wrapper img, .od-gallery-turn-item-wrapper img, [class*="gallery"] img').forEach((img: any) => {
            const src = img.src || img.getAttribute('data-src') || '';
            if (src && src.includes('cbu01')) {
              const base = src.replace(/\.(jpg|jpeg|png)(_.*)$/i, '.$1');
              if (!seen.has(base)) {
                seen.add(base);
                images.push(base);
              }
            }
          });
        }

        // Strategy 3: Any cbu01 alicdn product image on the page (broad fallback)
        if (images.length === 0) {
          document.querySelectorAll('img[src*="cbu01"]').forEach((img: any) => {
            const src = img.src || '';
            if (src) {
              const base = src.replace(/\.(jpg|jpeg|png)(_.*)$/i, '.$1');
              if (!seen.has(base)) {
                seen.add(base);
                images.push(base);
              }
            }
          });
        }

        // Extract specifications from ant-descriptions (new 1688 layout)
        const specifications: Array<{ name: string; value: string }> = [];
        // New layout: ant-descriptions with label/content pairs
        const descRows = document.querySelectorAll('.ant-descriptions-row');
        descRows.forEach((row) => {
          const labels = row.querySelectorAll('.ant-descriptions-item-label');
          const values = row.querySelectorAll('.ant-descriptions-item-content');
          for (let i = 0; i < labels.length; i++) {
            const name = labels[i]?.textContent?.trim() || '';
            const value = values[i]?.textContent?.trim() || '';
            if (name && value) {
              specifications.push({ name, value });
            }
          }
        });
        // Fallback: old table-based layout
        if (specifications.length === 0) {
          const specRows = document.querySelectorAll(
            '.detail-attributes tr, .mod-detail-attributes tr, [class*="attribute"] tr, .obj-content tr'
          );
          specRows.forEach((row) => {
            const cells = row.querySelectorAll('td, th');
            if (cells.length >= 2) {
              specifications.push({
                name: cells[0].textContent?.trim() || '',
                value: cells[1].textContent?.trim() || '',
              });
            }
          });
        }

        // Extract description from product description module
        const descModule = document.querySelector('.module-od-product-description, .html-description, [class*="core:description"]');
        const description = descModule?.textContent?.trim() || '';

        // Get price — first matching ¥XX.XX pattern
        let priceCNY: number | null = null;
        const priceEls = document.querySelectorAll('[class*="price"]');
        for (const el of Array.from(priceEls)) {
          const text = el.textContent || '';
          const match = text.match(/¥([\d.]+)/);
          if (match) {
            priceCNY = parseFloat(match[1]);
            break;
          }
        }

        // Get seller info
        const sellerElement = document.querySelector('.company-name, [class*="company-name"] a, [class*="store-name"]');
        const sellerName = sellerElement?.textContent?.trim() || '';

        return {
          description,
          images,
          specifications,
          priceCNY,
          seller: { name: sellerName },
        };
      });

      logger.info('Page evaluate results', {
        id: product.id1688,
        images: details.images?.length || 0,
        specs: details.specifications?.length || 0,
        price: details.priceCNY,
        descLen: details.description?.length || 0,
      });

      // Merge details with existing product
      if (details.description) {
        product.description = details.description;
      }

      if (details.images && details.images.length > 0) {
        product.images = details.images;
      }

      if (details.specifications && details.specifications.length > 0) {
        product.specifications = details.specifications as ProductSpecification[];
      }

      if (details.priceCNY && details.priceCNY > 0) {
        product.priceCNY = details.priceCNY;
      }

      if (details.seller && details.seller.name) {
        product.seller = details.seller as SellerInfo;
      }

      // Extract SKU variant data (colors, sizes, per-variant prices/images)
      try {
        const variants = await this.extractVariants();
        if (variants && variants.options.length > 0) {
          product.variants = variants;
          logger.info('Variants extracted', {
            id: product.id1688,
            options: variants.options.map(o => `${o.name}: ${o.values.length} values`),
            skuCount: variants.skus.length,
          });
        }
      } catch (error) {
        logger.warn('Variant extraction failed', {
          id: product.id1688,
          error: (error as Error).message,
        });
      }

      logger.debug('Product details fetched', {
        id: product.id1688,
        imagesCount: product.images.length,
        specsCount: product.specifications.length,
        hasVariants: !!product.variants,
      });

      return product;
    } catch (error) {
      logger.error('Failed to fetch product details', {
        id: product.id1688,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  async scrapeCategory(category: string, limit: number): Promise<ScrapedProduct[]> {
    logger.info('Starting category scrape', { category, limit });

    // Try direct category browsing first (less anti-bot)
    let basicProducts = await this.browseCategoryProducts(category, limit);

    // If category browsing didn't get enough products, try search as fallback
    if (basicProducts.length < limit) {
      logger.info('Category browsing got limited results, trying search as fallback', {
        fromCategory: basicProducts.length,
        needed: limit,
      });

      const remaining = limit - basicProducts.length;
      const searchProducts = await this.searchProducts(category, remaining);

      // Merge and deduplicate
      const seenIds = new Set(basicProducts.map(p => p.id1688));
      for (const product of searchProducts) {
        if (!seenIds.has(product.id1688)) {
          basicProducts.push(product);
          seenIds.add(product.id1688);
        }
      }
    }

    logger.info('Basic products collected', { count: basicProducts.length });

    // Get detailed info for each product
    const detailedProducts: ScrapedProduct[] = [];

    for (const product of basicProducts) {
      const detailed = await this.getProductDetails(product);
      detailedProducts.push(detailed);
      await randomDelay(2000, 4000);
    }

    return detailedProducts;
  }

  /**
   * Scrape all products listed in a specific 1688 seller store.
   * Used for verified providers (trust_level='verified') in the Amazon sourcing pipeline.
   *
   * Navigates to `{shopUrl}shop/offerlist.htm` and pages through results.
   * Returns basic product info (same shape as searchProducts) — Task 2 fills in full details.
   *
   * @param shopUrl  Base shop URL, e.g. https://shop020w0k390l115.1688.com/
   * @param limit    Max products to collect (0 = no limit, collect all)
   */
  async scrapeStoreProducts(shopUrl: string, limit: number = 0): Promise<ScrapedProduct[]> {
    if (!this.page) throw new Error('Browser not initialized');

    const baseUrl = shopUrl.replace(/\/$/, '');
    const products: ScrapedProduct[] = [];
    let pageIndex = 1;
    const maxPages = 50; // safety cap — most stores have < 500 products

    logger.info('Scraping verified provider store', { shopUrl, limit });

    // 1688 store product-list URL patterns — tried in order until one yields products.
    // Pattern 0: classic offerlist.htm (older stores)
    // Pattern 1: /page/offerlist.html (newer store format)
    // Pattern 2: store root / (homepage, shows featured products; limited pagination)
    // The first pattern that returns ≥1 product on page 1 is used for all subsequent pages.
    const urlPatterns: Array<(idx: number) => string> = [
      (idx) => `${baseUrl}/shop/offerlist.htm?pageIndex=${idx}`,
      (idx) => `${baseUrl}/page/offerlist.html?pageIndex=${idx}`,
      (idx) => `${baseUrl}/?pageIndex=${idx}`,
    ];
    let patternIndex = 0;
    let patternConfirmed = false; // true once a pattern yields ≥1 product

    while (pageIndex <= maxPages) {
      const url = urlPatterns[patternIndex](pageIndex);
      logger.info('Navigating to store page', { url, pageIndex, urlPattern: patternIndex });

      try {
        // Store pages (especially /page/offerlist.html) are React SPAs.
        // networkidle2 waits until React finishes fetching + rendering product data.
        // domcontentloaded fires too early — product grid is empty at that point.
        await this.page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

        // Log actual URL after navigation — detects redirects (e.g. captcha, login page)
        const actualUrl = this.page.url();
        if (actualUrl !== url) {
          logger.info('Store page redirected', { from: url, to: actualUrl });
        }

        await randomDelay(2000, 3000);

        const pageProducts = await this.extractProductsFromPage();

        if (pageProducts.length === 0) {
          // On the very first page of the first pattern, take a diagnostic screenshot
          // and try the fallback URL pattern before declaring failure.
          if (pageIndex === 1 && !patternConfirmed) {
            const logsDir = path.resolve(__dirname, '../../logs');
            ensureDirectoryExists(logsDir);
            const screenshotPath = path.join(logsDir, `debug-store-${Date.now()}.png`);
            await this.page.screenshot({ path: screenshotPath, fullPage: false });
            const pageTitle = await this.page.title();
            // Targeted DOM inspection — find product-like elements and their classes/hrefs
            const domDiag = await this.page.evaluate(() => {
              // All links that contain offer IDs
              const offerLinks = Array.from(document.querySelectorAll('a[href]'))
                .map(a => (a as HTMLAnchorElement).href)
                .filter(h => /offer|detail|offerId/i.test(h))
                .slice(0, 10);
              // Check candidate container selectors
              const selectors = [
                '.shop-offer-item', '.shopOffer-item', '.offer-item-wrap',
                '[class*="offerItem"]', '[class*="OfferItem"]',
                '[class*="product-item"]', '[class*="ProductItem"]',
                '[class*="goodsItem"]', '[class*="GoodsItem"]',
                '[class*="item-card"]', '[class*="ItemCard"]',
                '[class*="galleryItem"]', '[class*="GalleryItem"]',
                '.item-img', '[class*="itemImg"]',
              ];
              const counts: Record<string, number> = {};
              for (const sel of selectors) {
                counts[sel] = document.querySelectorAll(sel).length;
              }
              // First class on first few divs/li elements under main content
              const sampleClasses = Array.from(document.querySelectorAll('main *, [class*="content"] *, [class*="list"] *'))
                .filter(el => el.className && typeof el.className === 'string' && el.className.length > 0)
                .map(el => el.className.split(' ')[0])
                .filter((c, i, arr) => arr.indexOf(c) === i) // unique
                .slice(0, 30);
              return { offerLinks, selectorCounts: counts, sampleClasses };
            });
            logger.warn('Store page returned 0 products — DOM diagnostic', {
              actualUrl,
              pageTitle,
              screenshotPath,
              urlPattern: patternIndex,
              offerLinks: domDiag.offerLinks,
              selectorCounts: domDiag.selectorCounts,
              sampleClasses: domDiag.sampleClasses,
            });

            if (patternIndex < urlPatterns.length - 1) {
              patternIndex++;
              logger.info('Trying fallback store URL pattern', { patternIndex });
              continue; // retry with next URL pattern, same pageIndex (1)
            }
          }

          logger.info('No products on page — reached end of store', { pageIndex });
          break;
        }

        patternConfirmed = true; // This URL pattern works — stick with it

        for (const p of pageProducts) {
          if (!products.find(existing => existing.id1688 === p.id1688)) {
            products.push(p);
          }
        }

        logger.info('Store page scraped', { pageIndex, pageCount: pageProducts.length, totalSoFar: products.length });

        if (limit > 0 && products.length >= limit) break;

        // Check if there is a next page button — try multiple selector patterns
        // used by different 1688 store page layouts (offerlist vs. store root vs. new format)
        const hasNextPage = await this.page.evaluate(() => {
          const next = document.querySelector(
            '.next-pagination-item-next:not(.disabled), ' +
            'a[rel="next"], ' +
            '.next-btn-next:not(.disabled), ' +
            '[class*="pagination"] [class*="next"]:not([class*="disabled"]), ' +
            '[class*="Pagination"] [class*="next"]:not([class*="disabled"]), ' +
            'li.ant-pagination-next:not(.ant-pagination-disabled), ' +
            '.pagination-next:not(.disabled)'
          );
          return next !== null;
        });
        if (!hasNextPage) break;

        pageIndex++;
        await randomDelay(1500, 2500);
      } catch (err) {
        logger.warn('Store page failed, stopping', { pageIndex, error: (err as Error).message });
        break;
      }
    }

    logger.info('Store scrape complete', { shopUrl, total: products.length });
    return limit > 0 ? products.slice(0, limit) : products;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Compliance helpers — call AFTER navigating to a product page
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Extract extended seller info (Wangwang ID, shop URL, seller ID)
   * from the currently-loaded 1688 product page.
   */
  async getSellerInfo(): Promise<{ name: string; sellerId: string; shopUrl: string; wangwangId: string }> {
    if (!this.page) throw new Error('Browser not initialized');

    return this.page.evaluate(() => {
      // Seller name — actual 1688 class is "shop-company-name"
      const name = (
        document.querySelector('[class*="shop-company-name"]')?.textContent ||
        document.querySelector('[class*="companyName"]')?.textContent ||
        document.querySelector('.company-name')?.textContent ||
        ''
      ).trim();

      // Shop link — 1688 uses subdomain format: shop{id}.1688.com
      // Find any link pointing to a shop subdomain on 1688.com
      const allLinks = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
      const shopLinkEl = allLinks.find(a => {
        const h = a.href || '';
        return /\/\/shop[\w]+\.1688\.com/.test(h);
      }) || null;

      // Normalise to base shop URL (strip query params)
      let shopUrl = '';
      if (shopLinkEl) {
        try {
          const u = new URL(shopLinkEl.href);
          shopUrl = u.origin + '/';           // e.g. https://shop99dx039474552.1688.com/
        } catch { shopUrl = shopLinkEl.href; }
      }

      // Seller ID — extract subdomain part after "shop": shop{id}.1688.com
      const sellerIdMatch = shopUrl.match(/\/\/shop([\w]+)\.1688\.com/) ||
                            shopUrl.match(/\/shop\/([\d]+)\.html/) ||
                            shopUrl.match(/\/merchant\/([\d]+)/);
      const sellerId = sellerIdMatch?.[1] || '';

      // Wangwang ID — look for data-nick / nick attributes, or extract from IM link href
      // Also check for amos.alicdn links which carry the seller nick
      const wwEl = (
        document.querySelector('[data-nick]') ||
        document.querySelector('[nick]') ||
        document.querySelector('a[href*="amos.alicdn.com"]') ||
        document.querySelector('a[href*="wangwang"]') ||
        document.querySelector('a[href*="ww.alicdn.com"]') ||
        document.querySelector('[class*="wangwang"]') ||
        document.querySelector('[class*="contact"]')
      ) as HTMLElement | null;

      let wangwangId = '';
      if (wwEl) {
        wangwangId = wwEl.getAttribute('data-nick') ||
                     wwEl.getAttribute('nick') || '';
        if (!wangwangId) {
          const href = (wwEl as HTMLAnchorElement).href || wwEl.getAttribute('href') || '';
          const nickMatch = href.match(/[?&]nick=([^&]+)/) ||
                            href.match(/[?&]toNick=([^&]+)/) ||
                            href.match(/[?&]sellerId=([^&]+)/);
          if (nickMatch) wangwangId = decodeURIComponent(nickMatch[1]);
        }
      }

      return { name, sellerId, shopUrl, wangwangId };
    });
  }

  /**
   * Scan the currently-loaded product page for compliance certifications.
   * Returns an array of certs found (may be empty).
   */
  async scanProductCerts(productUrl: string): Promise<Array<{
    certType: string;
    certNumber?: string;
    imageUrl?: string;
    sourceUrl: string;
  }>> {
    if (!this.page) throw new Error('Browser not initialized');

    const certKeywords: Record<string, string[]> = {
      'oeko-tex':  ['oeko-tex', 'oekotex', 'oeko tex', 'standard 100', 'bluesign', 'gots'],
      'reach':     ['reach', 'svhc', 'rohs'],
      'sgs':       ['sgs认证', 'sgs test', 'sgs report'],
      'gots':      ['gots', 'global organic textile'],
      'iso':       ['iso 9001', 'iso 14001', 'iso9001'],
      'ce':        ['ce认证', 'ce certification', 'ce marked', 'ce mark'],
    };

    return this.page.evaluate((keywords: Record<string, string[]>, url: string) => {
      const certs: Array<{ certType: string; certNumber?: string; imageUrl?: string; sourceUrl: string }> = [];
      const pageText = (document.body?.innerText || '').toLowerCase();

      // Description section images (most likely to contain cert logos)
      const descImgs = Array.from(document.querySelectorAll(
        '.module-od-product-description img, [class*="description"] img, ' +
        '.detail-desc img, [class*="detailImg"] img, [class*="desc-img"] img'
      )) as HTMLImageElement[];

      for (const [certType, terms] of Object.entries(keywords)) {
        const textHit = terms.some(t => pageText.includes(t.toLowerCase()));
        if (!textHit) continue;

        const cert: { certType: string; certNumber?: string; imageUrl?: string; sourceUrl: string } = {
          certType,
          sourceUrl: url,
        };

        // Try to find a cert-specific image
        const certImg = descImgs.find(img => {
          const src = (img.src || img.getAttribute('data-src') || '').toLowerCase();
          const alt = (img.alt || '').toLowerCase();
          return terms.some(t => src.includes(t.toLowerCase()) || alt.includes(t.toLowerCase()));
        });
        if (certImg) {
          cert.imageUrl = certImg.src || certImg.getAttribute('data-src') || undefined;
        }

        // Try to extract cert number (OEKO-TEX format: XX.XXX.XXXX)
        const certNumMatch = pageText.match(/\b(\d{2,3}\.\d{3,4}\.\d{4,6})\b/);
        if (certNumMatch && certType === 'oeko-tex') {
          cert.certNumber = certNumMatch[1];
        }

        certs.push(cert);
      }
      return certs;
    }, certKeywords, productUrl);
  }

  /**
   * Search for suppliers/stores on 1688 company search page.
   * Returns supplier store info (name, URL, seller ID) for outreach.
   *
   * Uses 1688's company search (s.1688.com/company/...) instead of product search.
   * Chinese keywords are typed into the search bar (1688 uses GBK, not UTF-8 in URLs).
   */
  /**
   * Search for suppliers/factories on 1688 using the dedicated company search pages.
   * Factory search: s.1688.com/company/pc/factory_search.htm
   * Supplier search: s.1688.com/company/company_search.htm
   * Keywords should be plain product names only (e.g., "蓝牙耳机") — no 工厂/厂家 suffix needed.
   */
  async searchSuppliers(keyword: string, maxResults: number = 20, searchType: 'factory' | 'supplier' = 'factory'): Promise<SupplierSearchResult[]> {
    if (!this.page) throw new Error('Browser not initialized');

    const searchUrl = searchType === 'factory'
      ? 'https://s.1688.com/company/pc/factory_search.htm'
      : 'https://s.1688.com/company/company_search.htm';

    logger.info('Searching suppliers', { keyword, maxResults, searchType, searchUrl });
    const results: SupplierSearchResult[] = [];
    const seenIds = new Set<string>();

    try {
      // Navigate directly to the factory/supplier search page
      await this.page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await randomDelay(3000, 5000);

      // Check for CAPTCHA / block
      const pageIsUsable = async (): Promise<boolean> => {
        const url = this.page!.url();
        if (url.includes('punish') || url.includes('_____tmd_____')) return false;
        const inputCount = await this.page!.evaluate(() => document.querySelectorAll('input').length);
        return inputCount > 0;
      };

      if (!(await pageIsUsable())) {
        logger.warn('Page blocked by anti-bot! Please solve CAPTCHA on China MacBook browser.');
        logger.warn('Waiting up to 3 minutes...');
        const maxWait = 180000;
        let waited = 0;
        while (waited < maxWait) {
          await sleep(5000);
          waited += 5000;
          if (await pageIsUsable()) break;
        }
        if (!(await pageIsUsable())) {
          logger.error('Page still not usable after waiting');
          return results;
        }
      }

      // Find the search input on the factory/supplier search page
      const searchInputSelectors = [
        'input[name="keywords"]',
        'input[name="keyword"]',
        'input[name="q"]',
        'input[type="search"]',
        'input[placeholder*="搜索"]',
        'input[placeholder*="企业名"]',
        'input[placeholder*="工厂"]',
        'input[placeholder*="供应商"]',
        '.search-input input',
        'input.search-input',
        '.J_Keywords',
        '#keywords',
      ];

      let searchInput = null;
      for (const selector of searchInputSelectors) {
        try {
          searchInput = await this.page.$(selector);
          if (searchInput) {
            logger.info('Found search input', { selector });
            break;
          }
        } catch { continue; }
      }

      if (!searchInput) {
        // Log the page HTML snippet to help debug selector issues
        const snippet = await this.page.evaluate(() => document.body?.innerHTML?.substring(0, 500) || '');
        logger.error('Could not find search input on factory/supplier search page', { snippet });
        return results;
      }

      // Clear existing value and type the keyword
      await searchInput.click({ clickCount: 3 });
      await randomDelay(300, 500);
      await this.page.keyboard.press('Backspace');
      await randomDelay(200, 400);
      await searchInput.type(keyword, { delay: 60 });
      await randomDelay(500, 1000);

      // Submit — try button first, then Enter
      const searchBtnSelectors = [
        'button[type="submit"]',
        '.search-btn',
        '.btn-search',
        '.J_SearchBtn',
        'button.search-button',
        'input[type="submit"]',
      ];
      let submitted = false;
      for (const sel of searchBtnSelectors) {
        try {
          const btn = await this.page.$(sel);
          if (btn) {
            await btn.click();
            submitted = true;
            logger.info('Submitted via button', { selector: sel });
            break;
          }
        } catch { continue; }
      }
      if (!submitted) {
        await this.page.keyboard.press('Enter');
        logger.info('Submitted via Enter key');
      }

      // Wait for results to load
      try {
        await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch {
        // Navigation might already have completed or it's SPA
      }
      await randomDelay(3000, 5000);

      const currentUrl = this.page.url();
      logger.info('Search result URL', { url: currentUrl.substring(0, 200) });

      // Paginate through results
      let pageNum = 1;
      const maxPages = Math.ceil(maxResults / 10);

      while (results.length < maxResults && pageNum <= maxPages) {
        logger.info(`Extracting suppliers from page ${pageNum}`);

        const pageSuppliers = await this.page.evaluate(() => {
          const suppliers: Array<{
            storeName: string;
            storeUrl: string;
            sellerId: string;
            mainProducts: string;
            location: string;
          }> = [];
          const seenInPage = new Set<string>();

          // Strategy 1: look for shop*.1688.com links (direct shop URLs)
          const allLinks = Array.from(document.querySelectorAll('a[href*=".1688.com"]'));
          for (const link of allLinks) {
            const href = (link as HTMLAnchorElement).href;
            // Match shopXXXX.1688.com or XXXXX.1688.com/shop
            const shopMatch = href.match(/https?:\/\/shop([^.]+)\.1688\.com/) ||
                              href.match(/https?:\/\/([^.]+)\.1688\.com\/shop/);
            if (!shopMatch) continue;
            const sellerId = shopMatch[1];
            if (seenInPage.has(sellerId)) continue;

            // Get company name from parent card — do NOT use link text directly
            // because link text is often the shop ID (e.g. "shop020w0k390l115")
            let name = '';
            const card2 = link.closest('[class*="card"], [class*="item"], [class*="Card"], [class*="company"], [class*="factory"], li, .result');
            if (card2) {
              const nameEl = card2.querySelector('[class*="name"], [class*="title"], [class*="company"], h3, h4, h2');
              if (nameEl) name = nameEl.textContent?.trim() || '';
            }
            // Fallback: use link text only if it looks like a real company name
            // (not a shop ID like "shop020w0k390l115")
            if (!name || name.length < 2) {
              const linkText = link.textContent?.trim() || '';
              if (linkText.length >= 2 && linkText.length <= 100 && !/^shop[a-z0-9]+$/i.test(linkText)) {
                name = linkText;
              }
            }
            if (!name || name.length < 2 || name.length > 100) continue;

            // Get location + main products from parent card
            let mainProducts = '';
            let location = '';
            const card = link.closest('[class*="card"], [class*="item"], [class*="Card"], [class*="company"], [class*="factory"], li, .result');
            if (card) {
              const locEl = card.querySelector('[class*="locat"], [class*="area"], [class*="address"], [class*="region"], [class*="city"], [class*="province"]');
              location = locEl?.textContent?.trim() || '';
              const prodEl = card.querySelector('[class*="product"], [class*="main"], [class*="tag"], [class*="goods"], [class*="keyword"]');
              mainProducts = prodEl?.textContent?.trim() || '';
            }

            seenInPage.add(sellerId);
            suppliers.push({
              storeName: name,
              storeUrl: `https://shop${sellerId}.1688.com/`,
              sellerId,
              mainProducts: mainProducts.substring(0, 200),
              location: location.substring(0, 100),
            });
          }

          return suppliers;
        });

        logger.info(`Page ${pageNum}: found ${pageSuppliers.length} raw results`);

        for (const s of pageSuppliers) {
          if (!seenIds.has(s.sellerId) && results.length < maxResults) {
            seenIds.add(s.sellerId);
            results.push({
              storeName: s.storeName,
              storeUrl: s.storeUrl,
              sellerId: s.sellerId,
              mainProducts: s.mainProducts || undefined,
              location: s.location || undefined,
            });
          }
        }

        logger.info(`Page ${pageNum}: ${pageSuppliers.length} raw → ${results.length} unique total`);

        if (results.length >= maxResults) break;

        // Click "next page" button
        const hasNextPage = await this.page.evaluate(() => {
          const nextBtns = Array.from(document.querySelectorAll(
            '[class*="next"]:not(.disabled), a[class*="fui-next"]:not(.disabled), .pagination-next:not(.disabled)'
          ));
          for (const btn of nextBtns) {
            if ((btn as HTMLElement).offsetHeight > 0) {
              (btn as HTMLElement).click();
              return true;
            }
          }
          return false;
        });

        if (!hasNextPage) break;
        pageNum++;
        await randomDelay(3000, 5000);
      }

      logger.info('Supplier search complete', { keyword, searchType, totalFound: results.length });
      return results;

    } catch (error) {
      logger.error('Supplier search failed', { keyword, error: (error as Error).message });
      return results;
    }
  }

  /**
   * Navigate to a seller's 1688 shop and send a Wangwang IM message requesting cert docs.
   * Returns true if message was sent, false if the chat window couldn't be opened.
   */
  async sendWangwangMessage(sellerUrl: string, message: string): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');

    // Extract seller login ID from URL patterns:
    //   https://detail.1688.com/offer/XXXXX.html → need seller_id from caller
    //   https://shopXXXXX.1688.com/ → extract XXXXX
    //   direct seller ID string
    let sellerLoginId = sellerUrl;
    const shopMatch = sellerUrl.match(/https?:\/\/shop([^.]+)\.1688\.com/);
    if (shopMatch) {
      sellerLoginId = shopMatch[1];
    } else if (sellerUrl.match(/^https?:\/\//)) {
      // It's a URL but not a shop URL — could be product URL
      // In this case, the sellerUrl might actually be the seller login ID
      // passed directly from Task 8
      sellerLoginId = sellerUrl;
    }

    // Use direct Wangwang web IM URL — most reliable approach (2026-03-22)
    const wangwangUrl = `https://amos.alicdn.com/getcid.aw?v=3&groupid=0&s=1&charset=utf-8&uid=${encodeURIComponent(sellerLoginId)}&site=cnalichn`;
    logger.info('Opening Wangwang web chat', { sellerLoginId, wangwangUrl: wangwangUrl.substring(0, 100) });

    try {
      await this.page.goto(wangwangUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await randomDelay(3000, 5000);

      // Step 1: Click "优先使用网页版" (Prefer web version) if shown
      const webVersionClicked = await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const btn of buttons) {
          if ((btn.textContent || '').includes('优先使用网页版') && btn.offsetHeight > 0) {
            btn.click();
            return true;
          }
        }
        return false;
      });

      if (webVersionClicked) {
        logger.info('Clicked "优先使用网页版" — waiting for web chat tab to open');
        // The button opens a new tab with the air.1688.com web IM
        // Wait and poll for the new tab
        let chatTab: any = null;
        for (let attempt = 0; attempt < 10; attempt++) {
          await sleep(2000);
          const allPages = await this.browser!.pages();
          for (const p of allPages) {
            const pUrl = p.url();
            if (pUrl.includes('air.1688.com') || pUrl.includes('web_im')) {
              chatTab = p;
              break;
            }
          }
          if (chatTab) break;
        }

        if (chatTab) {
          this.page = chatTab;
          await chatTab.bringToFront();
          logger.info('Switched to web IM tab');
          // Wait for the iframe inside to load
          await sleep(5000);
        } else {
          // Fallback: use the latest tab
          const allPages = await this.browser!.pages();
          if (allPages.length > 1) {
            this.page = allPages[allPages.length - 1];
          }
          logger.warn('Could not find air.1688.com tab, using latest tab');
        }
      }

      logger.info('Chat page loaded', { title: await this.page.title(), url: this.page.url().substring(0, 100) });

      // Step 2: Check ALL tabs for the web IM (it might be in a different tab)
      // Also check this page — wwwebim.1688.com may auto-redirect to web IM
      const allPages = await this.browser!.pages();
      let imPage = this.page;
      for (const p of allPages) {
        const pUrl = p.url();
        if (pUrl.includes('air.1688.com') || pUrl.includes('def_cbu_web_im')) {
          imPage = p;
          this.page = p;
          await p.bringToFront();
          logger.info('Found web IM in tab', { url: pUrl.substring(0, 100) });
          break;
        }
      }

      // Wait for page content to fully load
      await sleep(3000);

      // The web IM chat is inside an iframe (def_cbu_web_im_core)
      let chatFrame: any = null;
      const frames = imPage.frames();
      logger.info('Frames in chat page', { count: frames.length, urls: frames.map((f: any) => f.url().substring(0, 80)) });
      for (const frame of frames) {
        const frameUrl = frame.url();
        if (frameUrl.includes('def_cbu_web_im_core') || frameUrl.includes('web_im_core')) {
          chatFrame = frame;
          logger.info('Found web IM iframe', { url: frameUrl.substring(0, 100) });
          break;
        }
      }

      // Search context: iframe if found, otherwise main page
      const searchCtx = chatFrame || this.page;

      const inputSelectors = [
        'textarea',
        '[contenteditable="true"]',
        'div[role="textbox"]',
        '[class*="editor"]',
        '[class*="Editor"]',
        '[class*="chatInput"]',
        '[class*="message-input"]',
        '.im-input',
      ];

      let inputEl: any = null;
      for (const sel of inputSelectors) {
        try {
          await searchCtx.waitForSelector(sel, { timeout: 5000 });
          inputEl = await searchCtx.$(sel);
          if (inputEl) {
            logger.debug('Found chat input', { selector: sel, inIframe: !!chatFrame });
            break;
          }
        } catch {
          continue;
        }
      }

      if (!inputEl) {
        logger.warn('Could not find chat input field', { url: this.page.url().substring(0, 100), hasIframe: !!chatFrame });
        return false;
      }

      // Type the message
      await inputEl.click();
      await randomDelay(500, 1000);

      // For contenteditable divs inside iframes, type via keyboard
      // (humanType may not work across frame boundaries)
      if (chatFrame) {
        await inputEl.type(message, { delay: 10 });
      } else {
        await this.humanType(this.page, message);
      }
      await randomDelay(800, 1500);

      // Send: try Enter key, also look for a send button
      const sendClicked = await searchCtx.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [class*="send"], [class*="Send"]'));
        for (const btn of btns) {
          const text = (btn.textContent || '').trim();
          if ((text === '发送' || text === 'Send' || text.includes('发送')) && (btn as HTMLElement).offsetHeight > 0) {
            (btn as HTMLElement).click();
            return true;
          }
        }
        return false;
      });

      if (!sendClicked) {
        // Fallback: press Enter
        await this.page.keyboard.press('Enter');
      }
      await randomDelay(1000, 2000);

      logger.info('Wangwang message sent', { sellerLoginId, method: sendClicked ? 'send-button' : 'enter-key' });

      return true;
    } catch (error) {
      logger.error('Failed to send Wangwang message', {
        sellerUrl,
        error: (error as Error).message,
      });
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      this.isLoggedIn = false;
      logger.info('Browser closed');
    }
  }
}

export async function create1688Scraper(headless?: boolean): Promise<Scraper1688> {
  const scraper = new Scraper1688(headless);
  await scraper.initialize();
  return scraper;
}
