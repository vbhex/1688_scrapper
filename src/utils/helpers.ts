import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { logger } from './logger';

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return sleep(delay);
}

export function ensureDirectoryExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export async function downloadImage(url: string, destPath: string): Promise<boolean> {
  try {
    const response = await axios({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    const dir = path.dirname(destPath);
    ensureDirectoryExists(dir);

    fs.writeFileSync(destPath, response.data);
    return true;
  } catch (error) {
    logger.error('Failed to download image', { url, error: (error as Error).message });
    return false;
  }
}

export function cleanupTempFiles(dirPath: string): void {
  try {
    if (fs.existsSync(dirPath)) {
      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        fs.unlinkSync(path.join(dirPath, file));
      }
    }
  } catch (error) {
    logger.warn('Failed to cleanup temp files', { dirPath, error: (error as Error).message });
  }
}

export function isAppleBrand(text: string): boolean {
  return isBannedBrand(text);
}

// CRITICAL: Never scrape/list products from major brands — AliExpress will punish the store
// Updated for Clothing & Apparel pivot — keep 3C brands + add clothing-specific
export function isBannedBrand(text: string): boolean {
  const bannedBrands = [
    // 3C / electronics
    'apple', 'iphone', 'ipad', 'ipod', 'airpods', 'airpod', 'inpods', 'macbook',
    'imac', 'mac mini', 'mac pro', 'apple watch', 'homepod', 'airtag',
    'huaqiangbei', 'samsung', 'galaxy buds', 'galaxy watch', 'galaxy tab',
    'sony', 'playstation', 'walkman', 'xperia', 'wf-1000', 'wh-1000',
    'google pixel', 'pixel buds', 'chromecast', 'nest hub',
    'bose', 'jbl', 'beats by dre', 'beats studio', 'beats solo', 'beats fit',
    'microsoft', 'xbox', 'surface pro', 'surface laptop',
    'nintendo', 'switch oled',
    'huawei', 'freebuds', 'xiaomi', 'oppo', 'vivo', 'oneplus', 'lenovo',
    'logitech', 'razer', 'corsair', 'steelseries', 'hyperx',
    'cherry', 'asus rog', 'zowie', 'bloody',
    'remax', 'ldnio', 'anker', 'baseus',
    'dyson', 'lg electronics',
    'sennheiser', 'bang & olufsen', 'b&o', 'marshall',
    'gopro', 'dji', 'canon', 'nikon', 'fujifilm',
    // Fashion / clothing (Clothing & Apparel pivot) — English
    'nike', 'adidas', 'puma', 'new balance', 'under armour', 'reebok',
    'rolex', 'cartier', 'gucci', 'louis vuitton', 'prada', 'hermes', 'chanel',
    'burberry', 'versace', 'balenciaga', 'dior', 'fendi', 'givenchy',
    'zara', 'h&m', 'shein', 'uniqlo', 'mango', 'topshop',
    'lululemon', 'gymshark',
    'supreme', 'off-white', 'stone island', 'palace', 'stüssy', 'stussy',
    'bape', 'a bathing ape',
    'north face', 'patagonia', 'columbia',
    'ralph lauren', 'polo ralph', 'tommy hilfiger', 'calvin klein', 'lacoste',
    'hugo boss', 'michael kors', 'coach', 'kate spade', 'fila',
    'gap', "levi's", 'levis',
    // Chinese brand names — CRITICAL: 1688 titles are in Chinese
    '耐克',          // Nike
    '阿迪达斯',      // Adidas
    '彪马',          // Puma
    '新百伦',        // New Balance
    '安德玛',        // Under Armour
    '锐步',          // Reebok
    '优衣库',        // Uniqlo
    '北面',          // The North Face
    '哥伦比亚',      // Columbia
    '古驰',          // Gucci
    '路易威登',      // Louis Vuitton
    '普拉达',        // Prada
    '香奈儿',        // Chanel
    '巴宝莉',        // Burberry
    '博柏利',        // Burberry (alternate)
    '范思哲',        // Versace
    '巴黎世家',      // Balenciaga
    '迪奥',          // Dior
    '爱马仕',        // Hermès
    '卡地亚',        // Cartier
    '劳力士',        // Rolex
    '李宁',          // Li-Ning (major Chinese brand)
    '安踏',          // Anta (major Chinese brand)
    '特步',          // Xtep
    '匹克',          // Peak
    '鸿星尔克',      // Erke
    '361°', '361度', // 361°
    '斐乐',          // Fila (in China)
    '拉夫劳伦',      // Ralph Lauren
    '汤米',          // Tommy Hilfiger
    '卡尔文克莱恩',  // Calvin Klein
    '拉科斯特',      // Lacoste
    '雨果博斯',      // Hugo Boss
    '迈克科尔斯',    // Michael Kors
    // Adidas brand symbols used in titles to evade brand filter
    '三叶草',        // Adidas Originals clover logo (三叶草 = three-leaf clover)
    '三条杠',        // Adidas three stripes signature
  ];

  const lowerText = text.toLowerCase();
  return bannedBrands.some(brand => lowerText.includes(brand));
}

// Convert 1688 image URL to full-size version by stripping thumbnail suffixes
// e.g. ...cib.jpg_460x460q100.jpg_.webp → ...cib.jpg
//      ...cib.jpg_b.jpg → ...cib.jpg
//      ...cib.jpg_.webp → ...cib.jpg
export function get1688FullImageUrl(url: string): string {
  // Strip everything after the base image extension (.jpg, .png, .jpeg)
  return url.replace(/\.(jpg|jpeg|png)(_.*)$/i, '.$1');
}

// Map color names to standard English color values.
const COLOR_FAMILY_MAP: Record<string, string> = {
  // English keywords → standard value
  'black': 'black', 'white': 'WHITE', 'red': 'Red', 'blue': 'Blue',
  'green': 'green', 'yellow': 'Yellow', 'pink': 'Pink', 'purple': 'PURPLE',
  'orange': 'Red', 'grey': 'GRAY', 'gray': 'GRAY', 'brown': 'Brown',
  'beige': 'Beige', 'gold': 'Gold', 'silver': 'Silver', 'khaki': 'khaki',
  'navy': 'Navy Blue', 'skin': 'Skin Color', 'cream': 'Beige',
  'ivory': 'Ivory', 'mint': 'Mint', 'wine': 'wine red', 'army': 'army green',
  'sky': 'Sky Blue', 'dark gr': 'Dark Grey', 'dark green': 'dark green',
  'multi': 'MULTI',
  // Chinese keywords → standard value
  '黑': 'black', '白': 'WHITE', '红': 'Red', '蓝': 'Blue', '绿': 'green',
  '黄': 'Yellow', '粉': 'Pink', '紫': 'PURPLE', '橙': 'Red', '灰': 'GRAY',
  '棕': 'Brown', '金': 'Gold', '银': 'Silver', '肤': 'Skin Color',
  '米': 'Beige', '酒': 'wine red', '军': 'army green',
};

export function findClosestColorFamily(colorName: string): string {
  const lower = colorName.toLowerCase();
  for (const [key, value] of Object.entries(COLOR_FAMILY_MAP)) {
    if (lower.includes(key)) return value;
  }
  return 'MULTI';
}

// Clean variant names by stripping marketing text from 1688 sellers.
// e.g., "Premium Black [Low Power, 35h Battery] ★ Bluetooth 5.4" → "Premium Black"
export function cleanVariantName(name: string): string {
  let cleaned = name
    .replace(/[【\[（(★☆●◆▶►→].*/g, '')  // Strip from brackets/stars onward
    .replace(/\s*[+＋]\s*.*/g, '')          // Strip "+packaging" suffixes
    .replace(/\s*[-–—]\s*\d+dB.*/i, '')    // Strip "-35dB..." specs
    .trim();
  if (!cleaned || cleaned.length < 2) cleaned = name.substring(0, 30).trim();
  if (cleaned.length > 30) cleaned = cleaned.substring(0, 30).trim();
  return cleaned;
}

export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9.-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 200);
}

export function roundPrice(price: number): number {
  // Round to standard pricing tiers
  if (price < 10) {
    return Math.ceil(price * 100) / 100; // Round up to cents
  } else if (price < 100) {
    return Math.ceil(price * 10) / 10; // Round up to 10 cents
  } else {
    return Math.ceil(price); // Round up to dollars
  }
}

export function extractPrice(priceText: string): number | null {
  // Extract numeric price from text like "¥123.45" or "123.45元"
  const match = priceText.match(/[\d,]+\.?\d*/);
  if (match) {
    const cleaned = match[0].replace(/,/g, '');
    const price = parseFloat(cleaned);
    return isNaN(price) ? null : price;
  }
  return null;
}

export function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export function retryAsync<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000
): Promise<T> {
  return new Promise(async (resolve, reject) => {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn();
        resolve(result);
        return;
      } catch (error) {
        lastError = error as Error;
        logger.warn(`Attempt ${attempt}/${maxRetries} failed`, { error: lastError.message });

        if (attempt < maxRetries) {
          await sleep(delayMs * attempt);
        }
      }
    }

    reject(lastError);
  });
}
