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
      // STRATEGIC PIVOT 2026-03-05: 3C → Clothing & Apparel
      // Old 3C categories removed. Do NOT add them back.
      // Full rationale: documents/aliexpress-store/PLATFORM_PIVOT_3C_TO_CLOTHING.md
      //
      // SEARCH TERM STRATEGY (2026-03-10): Use niche/style-specific terms.
      // Root cause of "Duplicate Laying" failures: generic search terms return commodity
      // items (plain tees/hoodies) already sold by thousands of AliExpress sellers.
      // Fix: add style/design modifiers (印花, oversize, Y2K, 波西米亚) to yield
      // differentiated products that pass AliExpress's duplicate check.
      // Full mapping: src/scrapers/1688Scraper.ts → categoryKeywords
      categories: getEnvArray('CATEGORIES', [
        // Women's — broad OK (outerwear, pants, dresses have enough variety naturally)
        'womens dresses', 'womens jackets', 'womens pants',
        // Women's — niched (plain tees/hoodies were failing as "Duplicate Laying")
        'womens boho', 'womens floral', 'womens tops', 'womens hoodies',
        'womens sets', 'womens cardigan', 'womens sweater',
        // Men's — niched
        'mens graphic', 'mens hoodies', 'mens shirts', 'mens pants', 'mens cargo',
        // Unisex / Streetwear — niche styles
        'streetwear', 'unisex graphic',
        // 'kids clothing' PAUSED — AliExpress requires Mother & Kids templates.
        // Do NOT add back until those templates are downloaded and excel-gen supports them.
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
