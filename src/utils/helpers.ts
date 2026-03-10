import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { logger } from './logger';

// ---------------------------------------------------------------------------
// Banned-brands list — loaded from banned-brands.json at project root.
// To add/remove brands: edit banned-brands.json (no rebuild needed).
// ---------------------------------------------------------------------------
let _bannedBrandsCache: string[] | null = null;

function loadBannedBrands(): string[] {
  if (_bannedBrandsCache !== null) return _bannedBrandsCache;
  const jsonPath = path.resolve(__dirname, '../../banned-brands.json');
  try {
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const keywords: string[] = [];
    for (const list of Object.values(raw.categories ?? {})) {
      if (Array.isArray(list)) keywords.push(...(list as string[]));
    }
    _bannedBrandsCache = keywords;
  } catch {
    logger.warn('banned-brands.json not found or invalid — using empty list', { path: jsonPath });
    _bannedBrandsCache = [];
  }
  return _bannedBrandsCache;
}

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

// CRITICAL: Never scrape/list products from major brands — AliExpress will punish the store.
// To add/remove brands: edit banned-brands.json at the project root (no rebuild needed).
export function isBannedBrand(text: string): boolean {
  const lowerText = text.toLowerCase();
  return loadBannedBrands().some(brand => lowerText.includes(brand));
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
