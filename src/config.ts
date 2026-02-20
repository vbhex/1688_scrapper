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
    filters: {
      minPriceCNY: getEnvNumber('MIN_PRICE_CNY', 37),
      maxPriceCNY: getEnvNumber('MAX_PRICE_CNY', 500),
      minOrderQty: getEnvNumber('MIN_ORDER_QTY', 1),
      priceMarkup: getEnvNumber('PRICE_MARKUP', 2),
      categories: getEnvArray('CATEGORIES', [
        'earphones', 'smart watches', 'speakers', 'action cameras',
        'wireless charger', 'gaming mouse', 'mechanical keyboard', 'power bank',
        'ip camera', 'portable projector', 'translator', 'lavalier microphone',
        'usb hub', 'webcam', 'solar panel', 'smart ring', 'gps tracker',
        'soundbar', 'vr glasses', 'gimbal stabilizer', 'power station',
        'smart doorbell', 'phone cooler', 'sim router',
      ]),
      excludeBrands: getEnvArray('EXCLUDE_BRANDS', [
        'apple', 'iphone', 'ipad', 'airpods', 'airpod', 'inpods', 'macbook',
        'huaqiangbei',
        'samsung', 'galaxy buds',
        'sony', 'bose', 'jbl', 'beats', 'nike', 'adidas',
        'google pixel', 'microsoft', 'nintendo', 'dyson', 'gopro', 'dji',
        'gucci', 'louis vuitton', 'prada', 'rolex', 'sennheiser',
        'lenovo', 'huawei', 'xiaomi', 'oppo', 'vivo', 'oneplus',
        'logitech', 'razer', 'corsair', 'steelseries', 'hyperx', 'cherry', 'bloody',
        'remax', 'ldnio', 'anker', 'baseus',
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
