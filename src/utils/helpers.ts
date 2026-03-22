import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { logger } from './logger';
import { BrandEntry, BrandMatch, BrandRiskLevel } from '../models/product';

// ---------------------------------------------------------------------------
// Banned-brands list — DB-backed with JSON fallback.
// Call initBrandCache() once at task startup, then isBannedBrand() is sync.
// ---------------------------------------------------------------------------

interface CachedBrand {
  keyword: string;
  brandName: string;
  riskLevel: BrandRiskLevel;
  exactMatch: boolean;
}

let _brandCache: CachedBrand[] | null = null;
let _brandCacheExpiry = 0;
const BRAND_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Pre-load brand cache from DB. Falls back to JSON if DB unavailable.
 * Call this once at the start of each task's main().
 */
export async function initBrandCache(): Promise<void> {
  if (_brandCache && Date.now() < _brandCacheExpiry) return;

  try {
    // Dynamic import to avoid circular dependency — db.ts imports from models, not helpers
    const { getAllActiveBrands } = await import('../database/db');
    const brands = await getAllActiveBrands();
    _brandCache = flattenBrandsToCache(brands);
    _brandCacheExpiry = Date.now() + BRAND_CACHE_TTL_MS;
    logger.info(`Brand cache loaded from DB: ${_brandCache.length} keywords from ${brands.length} brands`);
  } catch (err: any) {
    logger.warn(`Failed to load brands from DB, falling back to JSON: ${err.message}`);
    _brandCache = loadBrandsFromJson();
    _brandCacheExpiry = Date.now() + BRAND_CACHE_TTL_MS;
  }
}

/**
 * Flatten BrandEntry[] into a flat keyword cache for fast substring matching.
 */
function flattenBrandsToCache(brands: BrandEntry[]): CachedBrand[] {
  const cache: CachedBrand[] = [];
  for (const brand of brands) {
    // Add the primary English name
    cache.push({
      keyword: brand.brandNameEn.toLowerCase(),
      brandName: brand.brandNameEn,
      riskLevel: brand.riskLevel,
      exactMatch: brand.exactMatch,
    });
    // Add Chinese name if present
    if (brand.brandNameZh) {
      cache.push({
        keyword: brand.brandNameZh.toLowerCase(),
        brandName: brand.brandNameEn,
        riskLevel: brand.riskLevel,
        exactMatch: brand.exactMatch,
      });
    }
    // Add all aliases
    if (brand.aliases) {
      for (const alias of brand.aliases) {
        cache.push({
          keyword: alias.toLowerCase(),
          brandName: brand.brandNameEn,
          riskLevel: brand.riskLevel,
          exactMatch: brand.exactMatch,
        });
      }
    }
  }
  return cache;
}

/**
 * JSON fallback — same as the old loadBannedBrands().
 */
function loadBrandsFromJson(): CachedBrand[] {
  const jsonPath = path.resolve(__dirname, '../../banned-brands.json');
  try {
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const cache: CachedBrand[] = [];
    for (const list of Object.values(raw.categories ?? {})) {
      if (Array.isArray(list)) {
        for (const kw of list as string[]) {
          cache.push({
            keyword: kw.toLowerCase(),
            brandName: kw,
            riskLevel: 'high',
            exactMatch: false,
          });
        }
      }
    }
    return cache;
  } catch {
    logger.warn('banned-brands.json not found or invalid — using empty list', { path: jsonPath });
    return [];
  }
}

/**
 * Get the current brand keyword list (for backward compat with code that calls loadBannedBrands).
 */
function getBrandKeywords(): CachedBrand[] {
  if (!_brandCache) {
    // Fallback if initBrandCache() wasn't called — use JSON synchronously
    _brandCache = loadBrandsFromJson();
    _brandCacheExpiry = Date.now() + BRAND_CACHE_TTL_MS;
  }
  return _brandCache;
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
// Uses DB-backed cache (loaded via initBrandCache) with JSON fallback.
export function isBannedBrand(text: string): boolean {
  const lowerText = text.toLowerCase();
  return getBrandKeywords().some(cached => {
    if (cached.exactMatch) {
      // Word-boundary matching to avoid false positives (e.g., "cherry" in "cherry red")
      const regex = new RegExp(`\\b${escapeRegex(cached.keyword)}\\b`, 'i');
      return regex.test(text);
    }
    return lowerText.includes(cached.keyword);
  });
}

/**
 * Enhanced brand check that returns match details (brand name + risk level).
 * Useful for logging which brand was matched.
 */
export function getBannedBrandMatch(text: string): BrandMatch {
  const lowerText = text.toLowerCase();
  for (const cached of getBrandKeywords()) {
    let matched = false;
    if (cached.exactMatch) {
      const regex = new RegExp(`\\b${escapeRegex(cached.keyword)}\\b`, 'i');
      matched = regex.test(text);
    } else {
      matched = lowerText.includes(cached.keyword);
    }
    if (matched) {
      return { matched: true, brandName: cached.brandName, riskLevel: cached.riskLevel };
    }
  }
  return { matched: false };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
