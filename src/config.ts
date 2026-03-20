import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export interface Config {
  alibaba1688: {
    username: string;
    password: string;
  };
  google: {
    apiKey: string;
  };
  baidu: {
    translateAppId: string;
    translateSecret: string;
  };
  tencent: {
    secretId: string;
    secretKey: string;
    cos: {
      bucketName: string;
      region: string;
    };
  };
  filters: {
    minPriceCNY: number;
    maxPriceCNY: number;
    minOrderQty: number;
    priceMarkup: number;
    categories: string[];
    excludeBrands: string[];
  };
  runtime: {
    testMode: boolean;
    testProductLimit: number;
  };
  proxy: {
    server: string;
    username: string;
    password: string;
  };
  mysql: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  paths: {
    logs: string;
    tempImages: string;
  };
}

function getEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name];
  if (!value && defaultValue === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value || defaultValue || '';
}

function getEnvNumber(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const parsed = parseFloat(value);
  if (isNaN(parsed)) {
    throw new Error(`Invalid number for environment variable: ${name}`);
  }
  return parsed;
}

function getEnvBoolean(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true';
}

function getEnvArray(name: string, defaultValue: string[]): string[] {
  const value = process.env[name];
  if (!value) return defaultValue;
  return value.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

export function loadConfig(): Config {
  const projectRoot = path.resolve(__dirname, '..');

  return {
    alibaba1688: {
      username: getEnvVar('ALIBABA_1688_USERNAME', ''),
      password: getEnvVar('ALIBABA_1688_PASSWORD', ''),
    },
    google: {
      apiKey: getEnvVar('GOOGLE_CLOUD_API_KEY', ''),
    },
    baidu: {
      translateAppId: getEnvVar('BAIDU_TRANSLATE_APPID', ''),
      translateSecret: getEnvVar('BAIDU_TRANSLATE_SECRET', ''),
    },
    tencent: {
      secretId: getEnvVar('TENCENT_SECRET_ID', ''),
      secretKey: getEnvVar('TENCENT_SECRET_KEY', ''),
      cos: {
        bucketName: getEnvVar('COS_BUCKET_NAME', ''),
        region: getEnvVar('COS_REGION', 'ap-guangzhou'),
      },
    },
    filters: {
      minPriceCNY: getEnvNumber('MIN_PRICE_CNY', 37),
      maxPriceCNY: getEnvNumber('MAX_PRICE_CNY', 500),
      minOrderQty: getEnvNumber('MIN_ORDER_QTY', 1),
      priceMarkup: getEnvNumber('PRICE_MARKUP', 2),
      // RED OCEAN RULE (2026-03-20): Women's Clothing and Men's Clothing L1 categories
      // are permanently BANNED from scraping for AliExpress store 2087779.
      // ALL sub-categories under both L1s are saturated Red Oceans.
      // Do NOT add any 'womens *' or 'mens *' clothing categories back to this list.
      //
      // ACTIVE TARGETS: Watches, Apparel Accessories (Hats, Scarves, Hair, Eyewear, Belts)
      // Full strategy: documents/aliexpress-store/aliexpress-2087779-blue-ocean-categories.md
      // Full keyword mapping: src/scrapers/1688Scraper.ts → categoryKeywords
      categories: getEnvArray('CATEGORIES', [
        // ── Watches (AE L1: Watches) ──────────────────────────────────────────
        'quartz watches',       // → QuartzWristwatches
        'fashion watches',      // → QuartzWristwatches (fashion/casual)
        'couple watches',       // → CoupleWatches
        'digital watches',      // → DigitalWristwatches

        // ── Hats & Caps (AE L1: Apparel Accessories) ─────────────────────────
        'bucket hats',          // → BucketHats
        'baseball caps',        // → BaseballCaps
        'beanies',              // → Hats
        'cowboy hats',          // → CowboyHats

        // ── Scarves (AE L1: Apparel Accessories) ─────────────────────────────
        'silk scarves',         // → SilkScarves
        'winter scarves',       // → Scarves
        'sun scarves',          // → SunProtectiveScarf

        // ── Hair Accessories (AE L1: Apparel Accessories) ────────────────────
        'hair claws',           // → HairClaw
        'hair pins',            // → HairPin
        'hair accessories set', // → HairAccessoriesSet

        // ── Eyewear (AE L1: Apparel Accessories) ─────────────────────────────
        'blue light glasses',   // → BlueLightBlockingGlasses
        'reading glasses',      // → ReadingGlasses (or EyeglassesFrames)
        'polarized sunglasses', // → Sunglasses
        'sports sunglasses',    // → SportsSunglasses

        // ── Belts & Gloves (AE L1: Apparel Accessories) ──────────────────────
        'fashion belts',        // → Belts
        'fashion gloves',       // → GlovesMittens

        // RED OCEAN — DO NOT RE-ADD:
        // 'womens skirts', 'womens jumpsuits', 'womens blazers', 'womens leggings',
        // 'womens sleepwear', 'womens cardigan', 'womens dresses', 'womens jackets',
        // 'womens sets', 'mens polo', 'mens shorts', 'mens suits', 'mens cargo',
        // 'mens shirts', 'denim jackets' — ALL Women's/Men's Clothing L1 = Red Ocean
      ]),
      excludeBrands: getEnvArray('EXCLUDE_BRANDS', [
        // 3C / electronics (keep — still filter if they appear in search)
        'apple', 'iphone', 'ipad', 'airpods', 'airpod', 'inpods', 'macbook',
        'huaqiangbei', 'samsung', 'galaxy buds', 'sony', 'bose', 'jbl', 'beats',
        'google pixel', 'microsoft', 'nintendo', 'dyson', 'gopro', 'dji',
        'lenovo', 'huawei', 'xiaomi', 'oppo', 'vivo', 'oneplus',
        'logitech', 'razer', 'corsair', 'steelseries', 'hyperx', 'cherry', 'bloody',
        'remax', 'ldnio', 'anker', 'baseus', 'sennheiser',
        // Fashion / clothing (Clothing & Apparel pivot — AliExpress trademark violations)
        'nike', 'adidas', 'puma', 'new balance', 'under armour', 'reebok',
        'gucci', 'louis vuitton', 'prada', 'rolex', 'chanel', 'hermes', 'burberry',
        'versace', 'balenciaga', 'cartier',
        'zara', 'h&m', 'shein', 'uniqlo', 'mango', 'topshop',
        'lululemon', 'gymshark',
        'supreme', 'off-white', 'stone island', 'palace', 'stüssy', 'stussy',
        'bape', 'a bathing ape', 'north face', 'patagonia', 'columbia',
        // Trademarked fabric brands (AliExpress flags as IP infringement)
        'tencel', 'coolmax', 'thermolite', 'gore-tex', 'goretex', 'primaloft',
        'polartec', 'supplex', 'cordura', 'outlast', 'cocona', 'seacell',
      ]),
    },
    runtime: {
      testMode: getEnvBoolean('TEST_MODE', false),
      testProductLimit: getEnvNumber('TEST_PRODUCT_LIMIT', 5),
    },
    proxy: {
      server: getEnvVar('PROXY_SERVER', ''),
      username: getEnvVar('PROXY_USERNAME', ''),
      password: getEnvVar('PROXY_PASSWORD', ''),
    },
    mysql: {
      host: getEnvVar('MYSQL_HOST', 'localhost'),
      port: getEnvNumber('MYSQL_PORT', 3306),
      user: getEnvVar('MYSQL_USER', 'root'),
      password: getEnvVar('MYSQL_PASSWORD', ''),
      database: getEnvVar('MYSQL_DATABASE', '1688_source'),
    },
    paths: {
      logs: path.join(projectRoot, 'logs'),
      tempImages: path.join(projectRoot, 'temp_images'),
    },
  };
}

export const config = loadConfig();
