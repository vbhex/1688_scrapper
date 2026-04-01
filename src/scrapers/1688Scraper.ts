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
// COOKIES_FILE is now per-instance (see this.cookiesFile property) — this constant is kept as fallback
const COOKIES_FILE_DEFAULT = path.join(COOKIES_DIR, '1688-cookies.json');

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
  // 'primary'  = old established account with buying history → Amazon supplier outreach
  // 'sourcing' = new dedicated account (***REMOVED***)          → Core eBay/Etsy sourcing pipeline
  private profile: 'primary' | 'sourcing';
  private cookiesFile: string;

  constructor(headless?: boolean, profile?: 'primary' | 'sourcing') {
    // Allow headless mode via constructor or env var
    this.headless = headless !== undefined ? headless : (process.env.HEADLESS === 'true');
    // Allow profile via constructor or SCRAPER_PROFILE env var
    this.profile = profile ?? ((process.env.SCRAPER_PROFILE === 'sourcing') ? 'sourcing' : 'primary');
    // Each profile gets its own cookies file to keep sessions completely isolated
    const cookiesSuffix = this.profile === 'sourcing' ? '-sourcing' : '';
    this.cookiesFile = path.join(COOKIES_DIR, `1688-cookies${cookiesSuffix}.json`);
  }

  async initialize(): Promise<void> {
    logger.info('Initializing 1688 scraper with stealth mode', { headless: this.headless });

    // Use persistent Chrome profile to avoid detection
    // primary  → data/chrome-profile-1688          (old account with buying history, Amazon outreach)
    // sourcing → data/chrome-profile-1688-sourcing  (new ***REMOVED*** account, core pipeline)
    const profileSuffix = this.profile === 'sourcing' ? '-sourcing' : '';
    const userDataDir = path.resolve(__dirname, `../../data/chrome-profile-1688${profileSuffix}`);
    ensureDirectoryExists(userDataDir);

    // Kill any stale Chrome processes that are using THIS specific profile before launch.
    // Deleting lock files alone is insufficient if a Chrome process is still running —
    // it either holds the file handle or re-creates the files immediately.
    // IMPORTANT: Only kill Chrome processes for the CURRENT profile — not other profiles.
    // e.g. primary kills "chrome-profile-1688 " (with trailing space/quote), sourcing kills "chrome-profile-1688-sourcing"
    try {
      const { execSync } = require('child_process');
      const profileDirName = `chrome-profile-1688${profileSuffix}`;
      // Use exact dir name match to avoid "chrome-profile-1688" matching "chrome-profile-1688-sourcing"
      execSync(`pkill -9 -f "${profileDirName}[^-]" 2>/dev/null; pkill -9 -f "${profileDirName}$" 2>/dev/null; true`, { stdio: 'ignore' });
      await sleep(1500); // brief wait for processes to fully die
    } catch { /* ignore */ }

    // Clear stale Chrome lock files — needed after crashes/kill -9
    const lockFiles = [
      path.join(userDataDir, 'SingletonLock'),
      path.join(userDataDir, 'SingletonCookie'),
      path.join(userDataDir, 'SingletonSocket'),
      path.join(userDataDir, 'DevToolsActivePort'),
      path.join(userDataDir, 'Default', 'LOCK'),
      path.join(userDataDir, 'Default', '.parentlock'),
    ];
    for (const f of lockFiles) {
      try { fs.unlinkSync(f); } catch { /* file doesn't exist — fine */ }
    }

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
      fs.writeFileSync(this.cookiesFile, JSON.stringify(cookies, null, 2));
      logger.info('Cookies saved', { count: cookies.length, path: this.cookiesFile });
    } catch (error) {
      logger.error('Failed to save cookies', { error: (error as Error).message });
    }
  }

  // Load cookies from file
  async loadCookies(): Promise<boolean> {
    if (!this.page) return false;

    try {
      if (!fs.existsSync(this.cookiesFile)) {
        logger.info('No saved cookies found');
        return false;
      }

      const cookiesData = fs.readFileSync(this.cookiesFile, 'utf-8');
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
        // Close the current page (which may have detached frames from session validation)
        // and create a clean new page to avoid "Attempted to use detached Frame" errors
        if (this.page && !this.page.isClosed()) {
          await this.page.close().catch(() => {});
        }
        this.page = await this.browser!.newPage();
        // Re-apply viewport and stealth settings on the new page
        await this.page.setViewport({ width: 1920, height: 1080 });
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        // Re-inject cookies onto the new page before login attempt
        await this.loadCookies().catch(() => {});
      }
    }

    try {
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
        await this.humanType(this.page, (this.profile === 'sourcing' ? config.alibaba1688Sourcing : config.alibaba1688).username);

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
          await this.humanType(this.page, (this.profile === 'sourcing' ? config.alibaba1688Sourcing : config.alibaba1688).password);
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
        await this.humanType(this.page, (this.profile === 'sourcing' ? config.alibaba1688Sourcing : config.alibaba1688).username);

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
          await this.humanType(this.page, (this.profile === 'sourcing' ? config.alibaba1688Sourcing : config.alibaba1688).password);
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

        // Strategy D: new 1688 store page format (/page/offerlist.html).
        // Products render as classless <div> trees. No href links — offer IDs live in
        // onclick attributes OR can be extracted from the page-level HTML that contains
        // offerId patterns. Search the whole document for .price elements and walk ancestors.
        if (items.length === 0) {
          const priceContainers = Array.from(document.querySelectorAll('.price'));
          priceContainers.forEach(priceEl => {
            let node: Element | null = priceEl.parentElement;
            for (let i = 0; i < 8 && node; i++) {
              // Check onclick for an offer ID (10+ digits)
              const onclickAttr = node.getAttribute('onclick') || '';
              const idInOnclick = onclickAttr.match(/(\d{10,})/);
              if (idInOnclick) {
                const id1688 = idInOnclick[1];
                if (seenIds.has(id1688)) break;
                seenIds.add(id1688);
                const titleEl = node.querySelector('[class*="title"], h4, h3');
                const title = titleEl?.textContent?.trim() || '';
                const priceText = priceEl.textContent || '0';
                const priceMatch = priceText.match(/[\d.]+/);
                const priceCNY = priceMatch ? parseFloat(priceMatch[0]) : 0;
                const imgEl = node.querySelector('img') as HTMLImageElement | null;
                const imageUrl = (imgEl?.src || '').replace(/\.(jpg|jpeg|png)(_.*)$/i, '.$1');
                items.push({
                  id1688,
                  title,
                  description: '',
                  priceCNY,
                  images: imageUrl ? [imageUrl] : [],
                  specifications: [],
                  seller: { name: '' },
                  category: '',
                  minOrderQty: 1,
                  url: `https://detail.1688.com/offer/${id1688}.html`,
                  scrapedAt: new Date().toISOString(),
                });
                break;
              }
              // Also check: data-offerid or data-id attributes
              const dataOfferId = node.getAttribute('data-offerid') || node.getAttribute('data-offer-id') || node.getAttribute('data-id');
              if (dataOfferId && /^\d{10,}$/.test(dataOfferId) && !seenIds.has(dataOfferId)) {
                seenIds.add(dataOfferId);
                const titleEl = node.querySelector('[class*="title"], h4, h3');
                const title = titleEl?.textContent?.trim() || '';
                const priceText = priceEl.textContent || '0';
                const priceMatch = priceText.match(/[\d.]+/);
                const priceCNY = priceMatch ? parseFloat(priceMatch[0]) : 0;
                const imgEl = node.querySelector('img') as HTMLImageElement | null;
                const imageUrl = (imgEl?.src || '').replace(/\.(jpg|jpeg|png)(_.*)$/i, '.$1');
                items.push({
                  id1688: dataOfferId,
                  title,
                  description: '',
                  priceCNY,
                  images: imageUrl ? [imageUrl] : [],
                  specifications: [],
                  seller: { name: '' },
                  category: '',
                  minOrderQty: 1,
                  url: `https://detail.1688.com/offer/${dataOfferId}.html`,
                  scrapedAt: new Date().toISOString(),
                });
                break;
              }
              node = node.parentElement;
            }
          });
        }
      }

      // Strategy E: Parse offer IDs from inline <script> tags.
      // New 1688 React SPA pages embed product list data as JSON in a <script> tag
      // (e.g. window.__INIT_DATA__ or a raw JSON blob). No onclick/data-attrs needed.
      if (items.length === 0) {
        const scriptTags = Array.from(document.querySelectorAll('script:not([src])'));
        const offerIdSet = new Set<string>();
        const subjectMap: Record<string, string> = {};
        const priceMap: Record<string, number> = {};
        const imageMap: Record<string, string> = {};

        for (const script of scriptTags) {
          const text = script.textContent || '';
          if (!text.includes('offerId') && !text.includes('offerList') && !text.includes('offer_id')) continue;

          // Extract offer IDs
          Array.from(text.matchAll(/"offerId"\s*:\s*"?(\d{10,})"?/g)).forEach(m => offerIdSet.add(m[1]));
          Array.from(text.matchAll(/offer_id["\s:]+(\d{10,})/g)).forEach(m => offerIdSet.add(m[1]));

          // Extract subjects/titles (best-effort — same index as offerId in JSON array)
          Array.from(text.matchAll(/"subject"\s*:\s*"([^"]+)"/g)).forEach((m, i) => {
            const id = Array.from(offerIdSet)[i];
            if (id && !subjectMap[id]) subjectMap[id] = m[1];
          });

          // Extract prices
          Array.from(text.matchAll(/"price"\s*:\s*"?([\d.]+)"?/g)).forEach((m, i) => {
            const id = Array.from(offerIdSet)[i];
            if (id && !priceMap[id]) priceMap[id] = parseFloat(m[1]);
          });

          // Extract image URLs
          Array.from(text.matchAll(/"(?:imgUrl|picUrl|imageUrl|img_url)"\s*:\s*"([^"]+)"/g)).forEach((m, i) => {
            const id = Array.from(offerIdSet)[i];
            if (id && !imageMap[id]) imageMap[id] = m[1];
          });
        }

        for (const id1688 of offerIdSet) {
          if (!seenIds.has(id1688)) {
            seenIds.add(id1688);
            const imageUrl = (imageMap[id1688] || '').replace(/\.(jpg|jpeg|png)(_.*)$/i, '.$1');
            items.push({
              id1688,
              title: subjectMap[id1688] || '',
              description: '',
              priceCNY: priceMap[id1688] || 0,
              images: imageUrl ? [imageUrl] : [],
              specifications: [],
              seller: { name: '' },
              category: '',
              minOrderQty: 1,
              url: `https://detail.1688.com/offer/${id1688}.html`,
              scrapedAt: new Date().toISOString(),
            });
          }
        }
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
          if (!this.headless) {
            // Non-headless: wait for user to solve CAPTCHA manually (up to 3 minutes)
            logger.warn('CAPTCHA detected — please solve it in the browser window', { id: product.id1688 });
            const maxWait = 180000;
            const pollInterval = 3000;
            let waited = 0;
            while (waited < maxWait) {
              await sleep(pollInterval);
              waited += pollInterval;
              const stillCaptcha = await this.page.evaluate(() => document.title.includes('Captcha')).catch(() => true);
              if (!stillCaptcha) {
                logger.info('CAPTCHA solved, resuming...', { id: product.id1688 });
                break;
              }
              if (waited % 15000 === 0) logger.info(`Waiting for CAPTCHA solve... (${Math.ceil((maxWait - waited) / 1000)}s remaining)`);
            }
          } else {
            logger.warn('CAPTCHA detected, waiting 15s and reloading...', { id: product.id1688, attempt });
            await sleep(15000);
            await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
          }
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

        // Extract product title — try common 1688 product page selectors, fall back to document.title
        let productTitle = '';
        const titleSelectors = [
          'h1.title-text',
          'h1[class*="title"]',
          '[class*="product-title"] h1',
          '[class*="pdp-title"]',
          '[class*="offer-title"]',
          'h1',
        ];
        for (const sel of titleSelectors) {
          const el = document.querySelector(sel);
          const txt = el?.textContent?.trim();
          if (txt && txt.length > 3) { productTitle = txt; break; }
        }
        // Last resort: strip site suffix from document.title ("Product Name - 1688.com")
        if (!productTitle) {
          productTitle = document.title.replace(/\s*[-|–]\s*1688(\.com)?.*$/i, '').trim();
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
          productTitle,
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
      if (details.productTitle && !product.title) {
        product.title = details.productTitle;
      }

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

    // XHR interception — captures the product list API that the React SPA calls.
    // The new /page/offerlist.html format fetches data via an internal 1688 API;
    // the product grid renders without onclick / href / data-offerid attributes,
    // so DOM extraction strategies A-D cannot find offer IDs. We capture the raw
    // JSON response instead, then fall back to DOM extraction if XHR yields nothing.
    const xhrOffers: Array<{ id1688: string; title: string; priceCNY: number; imageUrl: string }> = [];
    let xhrCapturing = false;

    const xhrResponseListener = async (response: any) => {
      if (!xhrCapturing) return;
      if (response.status() !== 200) return;

      const respUrl: string = response.url();
      // Only inspect responses from 1688 / Alibaba domains
      if (!respUrl.includes('1688.com') && !respUrl.includes('alibaba.com')) return;

      try {
        const ct: string = response.headers()['content-type'] || '';
        if (!ct.includes('json') && !ct.includes('javascript') && !ct.includes('text/plain')) return;

        const text: string = await response.text().catch(() => '');
        if (!text || (!text.includes('offerId') && !text.includes('offer_id') && !text.includes('itemId'))) return;

        logger.info('XHR: captured potential product-list response', { url: respUrl.substring(0, 120) });

        // Extract offer IDs and associated fields from JSON text
        // 1688 API typically uses: {"offerId":"12345", "subject":"...", "price":"10.5", "imgUrl":"..."}
        const offerIds = Array.from(text.matchAll(/"offerId"\s*:\s*"?(\d{10,})"?/g)).map(m => m[1]);
        const subjects = Array.from(text.matchAll(/"(?:subject|subjectTrans|title)"\s*:\s*"([^"]+)"/g)).map(m => m[1]);
        const prices   = Array.from(text.matchAll(/"(?:price|priceInfo)"\s*:\s*"?([\d.]+)"?/g)).map(m => parseFloat(m[1]));
        const images   = Array.from(text.matchAll(/"(?:imgUrl|picUrl|imageUrl|img_url)"\s*:\s*"([^"]+)"/g)).map(m => m[1]);

        offerIds.forEach((id, i) => {
          if (!xhrOffers.find(o => o.id1688 === id)) {
            xhrOffers.push({
              id1688: id,
              title: subjects[i] || '',
              priceCNY: prices[i] || 0,
              imageUrl: (images[i] || '').replace(/\.(jpg|jpeg|png)(_.*)$/i, '.$1'),
            });
          }
        });

        logger.info('XHR: extracted offer IDs', { count: offerIds.length, totalSoFar: xhrOffers.length });
      } catch (_e) {
        // Ignore parse/network errors silently
      }
    };

    this.page.on('response', xhrResponseListener);

    while (pageIndex <= maxPages) {
      const url = urlPatterns[patternIndex](pageIndex);
      logger.info('Navigating to store page', { url, pageIndex, urlPattern: patternIndex });

      try {
        // Clear XHR captures for this page, then enable interception
        xhrOffers.length = 0;
        xhrCapturing = true;

        // Store pages (especially /page/offerlist.html) are React SPAs.
        // networkidle2 waits until React finishes fetching + rendering product data.
        // domcontentloaded fires too early — product grid is empty at that point.
        await this.page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

        // Log actual URL after navigation — detects redirects (e.g. captcha, login page)
        const actualUrl = this.page.url();
        if (actualUrl !== url) {
          logger.info('Store page redirected', { from: url, to: actualUrl });
        }

        // For store pages: scroll to viewport bottom to trigger lazy-loading,
        // then wait for product price elements to appear in the DOM.
        // The product grid renders asynchronously after networkidle2 in the new
        // /page/offerlist.html React format — .price elements confirm products are ready.
        await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
        await this.page.waitForSelector('.price, .sm-offer-item, .offer-item, a[href*="offerId="]', {
          timeout: 20000,
        }).catch(() => {
          // Products didn't appear — fall through, extractProductsFromPage will try anyway
        });

        // Extra settle time — some API calls arrive slightly after networkidle2
        await randomDelay(1500, 2500);
        xhrCapturing = false;

        // Try DOM extraction first (Strategies A-E). If that fails, use XHR-captured data.
        let pageProducts = await this.extractProductsFromPage();

        if (pageProducts.length === 0 && xhrOffers.length > 0) {
          logger.info('DOM extraction returned 0; using XHR-captured products', { count: xhrOffers.length });
          pageProducts = xhrOffers.map(o => ({
            id1688: o.id1688,
            title: o.title,
            description: '',
            priceCNY: o.priceCNY,
            images: o.imageUrl ? [o.imageUrl] : [],
            specifications: [],
            seller: { name: '' },
            category: '',
            minOrderQty: 1,
            url: `https://detail.1688.com/offer/${o.id1688}.html`,
            scrapedAt: new Date(),
          })) as ScrapedProduct[];
        }

        if (pageProducts.length === 0) {
          // On the very first page of the first pattern, take a diagnostic screenshot
          // and try the fallback URL pattern before declaring failure.
          if (pageIndex === 1 && !patternConfirmed) {
            const logsDir = path.resolve(__dirname, '../../logs');
            ensureDirectoryExists(logsDir);
            const screenshotPath = path.join(logsDir, `debug-store-${Date.now()}.png`);
            await this.page.screenshot({ path: screenshotPath, fullPage: false });
            const pageTitle = await this.page.title();
            // Dump #bd_1_container_0 and look for offer IDs in onclick / image src
            const domDiag = await this.page.evaluate(() => {
              // Get the product container HTML (may contain offer IDs in onclick or img src)
              const container = document.getElementById('bd_1_container_0');
              const containerHtml = container ? container.innerHTML.substring(0, 3000) : 'NOT FOUND';
              // Extract all 12-digit+ numbers (candidate offer IDs) from the container
              const containerText = container ? container.innerHTML : '';
              const candidateIds = Array.from(containerText.matchAll(/\b(\d{10,})\b/g))
                .map(m => m[1])
                .filter((v, i, arr) => arr.indexOf(v) === i)
                .slice(0, 20);
              // Also look for onclick attributes anywhere
              const onclickSamples = Array.from(document.querySelectorAll('[onclick]'))
                .slice(0, 5)
                .map(el => el.getAttribute('onclick'));
              // Product image srcs (should contain CDN image IDs, maybe offer IDs)
              const imageSrcs = Array.from(document.querySelectorAll('.main-picture img, [class*="main-picture"] img'))
                .slice(0, 5)
                .map(el => (el as HTMLImageElement).src);
              return { containerHtml, candidateIds, onclickSamples, imageSrcs };
            });
            logger.warn('Store page returned 0 products — container/onclick diagnostic', {
              actualUrl,
              pageTitle,
              screenshotPath,
              urlPattern: patternIndex,
              candidateIds: domDiag.candidateIds,
              onclickSamples: domDiag.onclickSamples,
              imageSrcs: domDiag.imageSrcs,
              containerHtml: domDiag.containerHtml,
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
        xhrCapturing = false;
        logger.warn('Store page failed, stopping', { pageIndex, error: (err as Error).message });
        // If XHR already captured offer IDs before the frame detached, use them
        if (xhrOffers.length > 0) {
          logger.info('Using XHR-captured products from failed page', { count: xhrOffers.length });
          const xhrProducts = xhrOffers.map(o => ({
            id1688: o.id1688,
            title: o.title,
            description: '',
            priceCNY: o.priceCNY,
            images: o.imageUrl ? [o.imageUrl] : [],
            specifications: [],
            seller: { name: '' },
            category: '',
            minOrderQty: 1,
            url: `https://detail.1688.com/offer/${o.id1688}.html`,
            scrapedAt: new Date(),
          })) as ScrapedProduct[];
          for (const p of xhrProducts) {
            if (!products.find(existing => existing.id1688 === p.id1688)) {
              products.push(p);
            }
          }
          logger.info('Store page scraped (XHR fallback)', { pageIndex, pageCount: xhrProducts.length, totalSoFar: products.length });
        }
        break;
      }
    }

    // Clean up XHR listener — must match the function reference passed to page.on()
    this.page.off('response', xhrResponseListener);

    // Reset page to about:blank so the next store scrape starts with a clean frame state
    await this.page.goto('about:blank', { waitUntil: 'load', timeout: 5000 }).catch(() => {});

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

        // Click "next page" button — register nav listener BEFORE the click to avoid the
        // race where navigation fires before waitForNavigation() is called.
        const navPromise = this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
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
        await navPromise;  // wait for the navigation triggered by the click
        pageNum++;
        await randomDelay(2000, 3000);
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
      // Close stale Wangwang tabs so this.page is always a usable non-WW page
      const prePages = await this.browser!.pages();
      for (const p of prePages) {
        const pUrl = p.url();
        if (pUrl.includes('air.1688.com') || pUrl.includes('def_cbu_web_im') || pUrl.includes('wwwebim.1688.com')) {
          await p.close().catch(() => {});
        }
      }
      // After closing WW tabs, find a healthy page to use as anchor
      const remainingPages = await this.browser!.pages();
      const healthyPage = remainingPages.find(p => !p.isClosed()) || remainingPages[0];
      if (healthyPage) this.page = healthyPage;

      // .catch() because amos→wwwebim redirect can temporarily detach the main frame
      await this.page.goto(wangwangUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
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
      const allPages2 = await this.browser!.pages();
      for (const p of allPages2) {
        const pUrl = p.url();
        if (pUrl.includes('air.1688.com') || pUrl.includes('def_cbu_web_im')) {
          this.page = p;
          await p.bringToFront();
          logger.info('Found web IM in tab', { url: pUrl.substring(0, 100) });
          break;
        }
      }

      // Wait for page content and inner iframe to fully load
      await sleep(5000);

      const wwPage = this.page;

      // Step 3: Find the core IM frame via page.frames() — far more reliable than contentDocument.
      // The frame URL contains 'def_cbu_web_im_core' or 'web_im_core'.
      const allFrames = wwPage.frames();
      logger.info('Finding core IM frame', { totalFrames: allFrames.length, urls: allFrames.map(f => f.url().substring(0, 60)).join(' | ') });
      let coreFrame = allFrames.find(f =>
        f.url().includes('def_cbu_web_im_core') ||
        f.url().includes('web_im_core')
      ) || null;

      // Wait up to 8s for the core frame to appear if not loaded yet
      if (!coreFrame) {
        for (let attempt = 0; attempt < 8; attempt++) {
          await sleep(1000);
          const frames = wwPage.frames();
          coreFrame = frames.find(f =>
            f.url().includes('def_cbu_web_im_core') ||
            f.url().includes('web_im_core')
          ) || null;
          if (coreFrame) break;
          logger.debug(`Waiting for core frame (attempt ${attempt + 1}/8)`, { frameUrls: frames.map(f => f.url().substring(0, 50)).join(', ') });
        }
      }

      const INPUT_SELECTORS = [
        'textarea',
        '[contenteditable="true"]',
        'div[role="textbox"]',
        '[class*="editor"]',
        '[class*="Editor"]',
        '[class*="chatInput"]',
        '[class*="message-input"]',
        '[class*="msg-input"]',
        '.im-input',
      ];

      let focusFound = false;
      let focusSelector = '';

      if (coreFrame) {
        // Use the frame directly — the most reliable approach
        logger.info('Using core frame for input', { frameUrl: coreFrame.url().substring(0, 80) });
        try {
          const frameResult = await coreFrame.evaluate((selectors: string[]) => {
            for (const sel of selectors) {
              const el = document.querySelector(sel) as HTMLElement;
              if (el && el.offsetHeight > 0) {
                el.focus();
                el.click();
                return { found: true, selector: sel };
              }
            }
            // Debug: dump what's in the doc
            const domSnip = document.body ? document.body.innerHTML.substring(0, 2000) : 'no body';
            return { found: false, selector: '', domSnip };
          }, INPUT_SELECTORS);

          if (frameResult.found) {
            focusFound = true;
            focusSelector = frameResult.selector;
          } else {
            logger.warn('Core frame found but no input element', { domSnip: (frameResult as any).domSnip?.substring(0, 300) });
          }
        } catch (err: any) {
          logger.warn('frame.evaluate failed', { error: err.message });
        }
      }

      // Fallback: try contentDocument approach on main page
      if (!focusFound) {
        const fallbackResult = await wwPage.evaluate((selectors: string[]) => {
          let doc: Document = document;
          const iframes = Array.from(document.querySelectorAll('iframe'));
          for (const iframe of iframes) {
            const src = (iframe as HTMLIFrameElement).src || '';
            if (!src.includes('def_cbu_web_im_core') && !src.includes('web_im_core')) continue;
            try {
              const iframeDoc = (iframe as HTMLIFrameElement).contentDocument ||
                                ((iframe as HTMLIFrameElement).contentWindow as any)?.document;
              if (iframeDoc && iframeDoc.body) { doc = iframeDoc; break; }
            } catch { continue; }
          }
          for (const sel of selectors) {
            const el = doc.querySelector(sel) as HTMLElement;
            if (el && el.offsetHeight > 0) {
              el.focus();
              el.click();
              return { found: true, selector: sel };
            }
          }
          return { found: false, selector: '' };
        }, INPUT_SELECTORS);

        if (fallbackResult.found) {
          focusFound = true;
          focusSelector = fallbackResult.selector;
        }
      }

      if (!focusFound) {
        logger.warn('Could not find chat input field in any frame', { url: wwPage.url().substring(0, 100) });
        // Save DOM for debugging
        await wwPage.evaluate(() => {
          const allText = document.documentElement.innerHTML.substring(0, 3000);
          (window as any).__debugDom = allText;
        }).catch(() => {});
        return false;
      }

      logger.info('Found chat input', { selector: focusSelector, method: coreFrame ? 'frame' : 'contentDocument' });
      await randomDelay(500, 1000);

      // Type the message — use frame if available, otherwise keyboard on page
      if (coreFrame && focusSelector) {
        try {
          await coreFrame.type(focusSelector, message, { delay: 15 });
        } catch {
          await wwPage.keyboard.type(message, { delay: 20 });
        }
      } else {
        await wwPage.keyboard.type(message, { delay: 20 });
      }
      await randomDelay(800, 1500);

      // Step 4: Click send button
      let sendClicked = false;
      if (coreFrame) {
        try {
          sendClicked = await coreFrame.evaluate(() => {
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
        } catch { /* fallthrough */ }
      }

      if (!sendClicked) {
        // Fallback: contentDocument send
        sendClicked = await wwPage.evaluate(() => {
          let doc: Document = document;
          const iframes = Array.from(document.querySelectorAll('iframe'));
          for (const iframe of iframes) {
            const src = (iframe as HTMLIFrameElement).src || '';
            if (!src.includes('def_cbu_web_im_core') && !src.includes('web_im_core')) continue;
            try {
              const iframeDoc = (iframe as HTMLIFrameElement).contentDocument ||
                                ((iframe as HTMLIFrameElement).contentWindow as any)?.document;
              if (iframeDoc && iframeDoc.body) { doc = iframeDoc; break; }
            } catch { continue; }
          }
          const btns = Array.from(doc.querySelectorAll('button, [class*="send"], [class*="Send"]'));
          for (const btn of btns) {
            const text = (btn.textContent || '').trim();
            if ((text === '发送' || text === 'Send' || text.includes('发送')) && (btn as HTMLElement).offsetHeight > 0) {
              (btn as HTMLElement).click();
              return true;
            }
          }
          return false;
        });
      }

      if (!sendClicked) {
        await wwPage.keyboard.press('Enter');
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

  /**
   * Navigate to the main Wangwang conversation list (inbox) and return all conversations
   * that have unread messages or recent replies from the other party.
   * Much faster than opening 275 individual chats.
   */
  /**
   * Scan the Wangwang inbox for unread conversations.
   * seedSellerUrl is required — we use any seller's amos URL to open Wangwang,
   * then the left panel shows the full inbox regardless of which seller we picked.
   */
  async scanWangwangInbox(seedSellerUrl?: string): Promise<{ conversations: Array<{ id: string; name: string; lastMsg: string; hasUnread: boolean }>, domSample: string }> {
    if (!this.page) throw new Error('Browser not initialized');

    // Build amos URL — use a seed seller to open Wangwang (without uid it never navigates)
    let seedLoginId = '';
    if (seedSellerUrl) {
      const m = seedSellerUrl.match(/https?:\/\/shop([^.]+)\.1688\.com/);
      if (m) seedLoginId = m[1];
    }
    const inboxUrl = seedLoginId
      ? `https://amos.alicdn.com/getcid.aw?v=3&groupid=0&s=1&charset=utf-8&uid=${encodeURIComponent(seedLoginId)}&site=cnalichn`
      : 'https://amos.alicdn.com/getcid.aw?v=3&groupid=0&s=1&charset=utf-8&site=cnalichn';

    // With a uid, the amos URL navigates to Wangwang and networkidle2 works fine.
    // Without uid, it never navigates — so domcontentloaded is the fallback.
    const waitUntil = seedLoginId ? 'networkidle2' : 'domcontentloaded';
    await this.page.goto(inboxUrl, { waitUntil, timeout: 30000 }).catch(() => {});
    await sleep(3000);

    // Prefer web version
    await this.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        if ((btn.textContent || '').includes('优先使用网页版') && (btn as HTMLElement).offsetHeight > 0) {
          btn.click();
          return;
        }
      }
    }).catch(() => {});
    await sleep(4000);

    // Find web IM tab (amos opens a new tab with Wangwang)
    const allPages = await this.browser!.pages();
    for (const p of allPages) {
      if (p.url().includes('air.1688.com') || p.url().includes('def_cbu_web_im')) {
        this.page = p;
        await p.bringToFront();
        break;
      }
    }
    await sleep(5000);

    // Access the core iframe's DOM via contentDocument (avoids detached Frame errors).
    // Parent frame URL:  def_cbu_web_im/index.html    (wrapper, no conversation items)
    // Core iframe URL:   def_cbu_web_im_core/index.html (has .conversation-item elements)
    // Helper to locate the core iframe document that contains .conversation-item elements
    const getCoreDoc = () => this.page!.evaluate(() => {
      const iframes = Array.from(document.querySelectorAll('iframe'));
      for (const iframe of iframes) {
        const src = (iframe as HTMLIFrameElement).src || '';
        if (!src.includes('def_cbu_web_im_core') && !src.includes('web_im_core')) continue;
        try {
          const d = (iframe as HTMLIFrameElement).contentDocument ||
                    ((iframe as HTMLIFrameElement).contentWindow as any)?.document;
          if (d && d.querySelectorAll('.conversation-item').length > 0) return true;
        } catch { /* cross-origin */ }
      }
      return false;
    });

    // Find the Wangwang core iframe frame via Puppeteer's page.frames() —
    // this avoids cross-origin access issues from page.evaluate() contentDocument.
    const getCoreFrame = () => {
      const frames = this.page!.frames();
      return frames.find(f =>
        f.url().includes('def_cbu_web_im_core') ||
        f.url().includes('web_im_core')
      ) || null;
    };

    // Scroll the conversation list down using the real frame context.
    // Returns the number of .conversation-item elements visible after scroll.
    const scrollInboxList = async (scrollAmount: number): Promise<number> => {
      const frame = getCoreFrame();
      if (!frame) return 0;
      try {
        return await frame.evaluate((amount: number) => {
          // Try all plausible scroll containers (inspect DOM to find exact class)
          const containers = [
            document.querySelector('.conversation-list'),
            document.querySelector('.im-conversation-list'),
            document.querySelector('.session-list'),
            document.querySelector('[class*="conversation-list"]'),
            document.querySelector('[class*="session-list"]'),
            document.querySelector('[class*="chatList"]'),
            document.querySelector('[class*="chat-list"]'),
            document.querySelector('[class*="msgList"]'),
            document.querySelector('[class*="msg-list"]'),
            // Fallback: parent of first conversation item
            document.querySelector('.conversation-item')?.parentElement,
          ].filter((el): el is HTMLElement => !!el && el instanceof HTMLElement);

          if (containers.length > 0) {
            containers[0].scrollTop += amount;
          } else {
            // Last resort: scroll the body
            document.documentElement.scrollTop += amount;
            document.body.scrollTop += amount;
          }
          return document.querySelectorAll('.conversation-item').length;
        }, scrollAmount);
      } catch { return 0; }
    };

    // Read conversations from the core iframe frame.
    // Falls back to page.evaluate(contentDocument) if frame isn't found directly.
    const readConversations = async (): Promise<{ conversations: Array<{ id: string; name: string; lastMsg: string; hasUnread: boolean }>, domSample: string }> => {
      const frame = getCoreFrame();

      const extract = (doc: Document) => {
        const domSample = doc.body ? doc.body.innerHTML.substring(0, 5000) : '';
        const convItems = Array.from(doc.querySelectorAll('.conversation-item'));
        const conversations = convItems.map(item => {
          const nameEl = item.querySelector('.name');
          const descEl = item.querySelector('.desc');
          const badge = item.querySelector('.unread-badge');
          const hasUnread = !!(badge && (badge.textContent || '').trim() !== '');
          return {
            id: item.id || '',
            name: nameEl ? (nameEl.textContent || '').trim() : '',
            lastMsg: descEl ? (descEl.textContent || '').trim() : '',
            hasUnread,
          };
        });
        return { conversations, domSample };
      };

      // Preferred: use the frame directly (no cross-origin issues)
      if (frame) {
        try {
          return await frame.evaluate(() => {
            const domSample = document.body ? document.body.innerHTML.substring(0, 5000) : '';
            const convItems = Array.from(document.querySelectorAll('.conversation-item'));
            const conversations = convItems.map(item => {
              const nameEl = item.querySelector('.name');
              const descEl = item.querySelector('.desc');
              const badge = item.querySelector('.unread-badge');
              const hasUnread = !!(badge && (badge.textContent || '').trim() !== '');
              return {
                id: item.id || '',
                name: nameEl ? (nameEl.textContent || '').trim() : '',
                lastMsg: descEl ? (descEl.textContent || '').trim() : '',
                hasUnread,
              };
            });
            return { conversations, domSample };
          });
        } catch { /* fall through to page.evaluate */ }
      }

      // Fallback: access core iframe via page.evaluate contentDocument
      return this.page!.evaluate(() => {
        let doc: Document = document;
        const iframes = Array.from(document.querySelectorAll('iframe'));
        for (const iframe of iframes) {
          const src = (iframe as HTMLIFrameElement).src || '';
          if (!src.includes('def_cbu_web_im_core') && !src.includes('web_im_core')) continue;
          try {
            const iframeDoc = (iframe as HTMLIFrameElement).contentDocument ||
                              ((iframe as HTMLIFrameElement).contentWindow as any)?.document;
            if (iframeDoc && iframeDoc.querySelectorAll('.conversation-item').length > 0) {
              doc = iframeDoc;
              break;
            }
          } catch { continue; }
        }
        const domSample = doc.body ? doc.body.innerHTML.substring(0, 5000) : '';
        const convItems = Array.from(doc.querySelectorAll('.conversation-item'));
        const conversations = convItems.map(item => {
          const nameEl = item.querySelector('.name');
          const descEl = item.querySelector('.desc');
          const badge = item.querySelector('.unread-badge');
          const hasUnread = !!(badge && (badge.textContent || '').trim() !== '');
          return {
            id: item.id || '',
            name: nameEl ? (nameEl.textContent || '').trim() : '',
            lastMsg: descEl ? (descEl.textContent || '').trim() : '',
            hasUnread,
          };
        });
        return { conversations, domSample };
      });
    };

    // Read initial batch
    let result = await readConversations();
    const seenIds = new Set<string>(result.conversations.map((c: any) => c.id || c.name));
    const allConversations = [...result.conversations];

    // Auto-save DOM sample to help debug scroll container class names
    if (result.domSample && result.conversations.length < 20) {
      const fs = require('fs');
      fs.writeFileSync('/tmp/wangwang-inbox-dom-auto.txt', result.domSample);
    }

    // Scroll down up to 20 times (600px per round) to surface buried replies.
    // Uses the real Puppeteer frame — much more reliable than contentDocument guessing.
    const SCROLL_ROUNDS = 20;
    for (let round = 0; round < SCROLL_ROUNDS; round++) {
      await scrollInboxList(600);
      await sleep(700);
      const batch = await readConversations();
      let newCount = 0;
      for (const conv of batch.conversations) {
        const key = conv.id || conv.name;
        if (!seenIds.has(key)) {
          seenIds.add(key);
          allConversations.push(conv);
          newCount++;
        }
      }
      // Stop early if no new items appeared (bottom of list)
      if (newCount === 0) {
        logger.debug(`Inbox scroll: no new items at round ${round + 1}, stopping`);
        break;
      }
    }

    logger.info('Wangwang inbox scanned', {
      conversationCount: allConversations.length,
      unreadCount: allConversations.filter((c: any) => c.hasUnread).length,
    });

    return { conversations: allConversations, domSample: result.domSample };
  }

  /**
   * Open a Wangwang chat with a seller and check if they have replied to our outreach.
   * Uses comprehensive DOM inspection to find actual class names used by Wangwang.
   */
  async checkWangwangReply(sellerUrl: string, debug = false): Promise<{ hasReply: boolean; replyText: string; domSample?: string }> {
    if (!this.page) throw new Error('Browser not initialized');

    let sellerLoginId = sellerUrl;
    const shopMatch = sellerUrl.match(/https?:\/\/shop([^.]+)\.1688\.com/);
    if (shopMatch) sellerLoginId = shopMatch[1];

    const wangwangUrl = `https://amos.alicdn.com/getcid.aw?v=3&groupid=0&s=1&charset=utf-8&uid=${encodeURIComponent(sellerLoginId)}&site=cnalichn`;

    try {
      // Close any stale Wangwang tabs from previous calls to avoid iframe detachment
      // and stale page references on subsequent sellers.
      const prePages = await this.browser!.pages();
      for (const p of prePages) {
        const url = p.url();
        if (p !== this.page && (url.includes('air.1688.com') || url.includes('def_cbu_web_im') || url.includes('wwwebim.1688.com'))) {
          await p.close().catch(() => {});
        }
      }

      // .catch() because amos→wwwebim redirect can temporarily detach the main frame
      await this.page.goto(wangwangUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      await randomDelay(3000, 5000);

      // Prefer web version button
      await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const btn of buttons) {
          if ((btn.textContent || '').includes('优先使用网页版') && (btn as HTMLElement).offsetHeight > 0) {
            btn.click();
            return;
          }
        }
      }).catch(() => {});
      await sleep(3000);

      // Find the Wangwang web IM tab and wait for it to fully load.
      // The air.1688.com tab loads and may do internal SPA navigation after opening.
      // We reassign this.page so the NEXT call's "close stale tabs" step can clean it up.
      const allPages = await this.browser!.pages();
      for (const p of allPages) {
        if (p.url().includes('air.1688.com') || p.url().includes('def_cbu_web_im')) {
          this.page = p;
          await p.bringToFront();
          break;
        }
      }
      // Wait for the page to fully stabilize (SPA loads, conversation list renders)
      try {
        await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 });
      } catch { /* may not navigate again — that's fine */ }
      await sleep(3000);

      const wwPage = this.page;

      // Use the conversation list to detect replies.
      // Conversation item IDs: "BUYER_ID.1-SELLER_ID.1#CHANNEL@cntaobao"
      // Unread replies show as <div class="unread-badge">N</div> inside the item.
      //
      // We evaluate in the PARENT PAGE (wwPage) and access the core iframe's DOM
      // via iframe.contentDocument — this avoids "detached Frame" errors that occur
      // when using Puppeteer frame references (the iframe gets recreated by SPA navigation).
      const numericId = sellerLoginId.replace(/[^0-9]/g, '');

      const result = await wwPage.evaluate((params: { loginId: string; numericId: string; isDebug: boolean }) => {
        const { loginId, numericId, isDebug } = params;

        // Find the def_cbu_web_im_core iframe and get its document
        // (same-origin: air.1688.com parent + air.1688.com iframe → contentDocument works)
        let doc: Document = document; // fallback to main page
        const iframes = Array.from(document.querySelectorAll('iframe'));
        for (const iframe of iframes) {
          const src = (iframe as HTMLIFrameElement).src || '';
          if (!src.includes('def_cbu_web_im_core') && !src.includes('web_im_core')) continue;
          try {
            const iframeDoc = (iframe as HTMLIFrameElement).contentDocument ||
                              ((iframe as HTMLIFrameElement).contentWindow as any)?.document;
            if (iframeDoc && iframeDoc.querySelectorAll('.conversation-item').length > 0) {
              doc = iframeDoc;
              break;
            }
          } catch { continue; }
        }

        const domSample = isDebug ? doc.body.innerHTML.substring(0, 10000) : '';
        const convItems = Array.from(doc.querySelectorAll('.conversation-item'));

        // Find the conversation item matching this seller
        let targetHasUnread = false;
        let targetDesc = '';
        let targetFound = false;

        for (const item of convItems) {
          const itemId = item.id || '';
          // Match "-SELLER_ID." pattern in conversation ID
          const isMatch = (loginId && itemId.includes('-' + loginId + '.')) ||
                          (numericId && numericId.length >= 6 && itemId.includes('-' + numericId + '.'));
          if (!isMatch) continue;

          targetFound = true;
          const badge = item.querySelector('.unread-badge');
          const descEl = item.querySelector('.desc');
          targetDesc = descEl ? (descEl.textContent || '').trim() : '';
          if (badge && (badge.textContent || '').trim() !== '') {
            targetHasUnread = true;
          }
          break;
        }

        // Collect all unread conversations (for logging/debug)
        const unreadConvs: Array<{ id: string; name: string; desc: string }> = [];
        for (const item of convItems) {
          const badge = item.querySelector('.unread-badge');
          if (badge && (badge.textContent || '').trim() !== '') {
            const nameEl = item.querySelector('.name');
            const descEl = item.querySelector('.desc');
            unreadConvs.push({
              id: item.id || '',
              name: nameEl ? (nameEl.textContent || '').trim() : '',
              desc: descEl ? (descEl.textContent || '').trim() : '',
            });
          }
        }

        return { targetFound, targetHasUnread, targetDesc, unreadConvs, convCount: convItems.length, domSample };
      }, { loginId: sellerLoginId, numericId, isDebug: debug });

      logger.debug('checkWangwangReply result', {
        sellerLoginId,
        targetFound: result.targetFound,
        targetHasUnread: result.targetHasUnread,
        convCount: result.convCount,
        unreadConvCount: result.unreadConvs.length,
      });

      if (result.targetHasUnread) {
        const replyText = result.targetDesc || 'Unread message detected';
        return { hasReply: true, replyText, domSample: result.domSample };
      }

      return { hasReply: false, replyText: '', domSample: result.domSample };
    } catch (error) {
      logger.warn('checkWangwangReply failed', { sellerLoginId, error: (error as Error).message });
      return { hasReply: false, replyText: '' };
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

export async function create1688Scraper(headless?: boolean, profile?: 'primary' | 'sourcing'): Promise<Scraper1688> {
  const scraper = new Scraper1688(headless, profile);
  await scraper.initialize();
  return scraper;
}
