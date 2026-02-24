/**
 * AliExpress Product Matcher (Internal Database)
 *
 * Matches 1688 products to AliExpress products using the internal
 * `aliexpress_source` database (scraped by ae_scrapper).
 *
 * Approach:
 *   1. Take the 1688 product's English title (from products_en)
 *   2. Extract model numbers from the title
 *   3. Query aliexpress_source.products for candidates
 *   4. Score by model number match + title similarity
 *   5. Return best match with images from product_images table
 */

import { RowDataPacket } from 'mysql2/promise';
import { getPool } from '../database/db';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('aeSearcher');

// ─── Types ──────────────────────────────────────────────────────────────

export interface AeSearchResult {
  productId: string;
  title: string;
  url: string;
  imageUrl: string;
  price: string;
}

export interface AeProductDetail {
  productId: string;
  url: string;
  title: string;
  images: string[];          // Gallery image URLs
  description: string;       // Product description text
  price: string;
}

export interface AeMatchResult {
  found: boolean;
  matchScore: number;        // 0-100
  product?: AeProductDetail;
}

// ─── Generic terms to exclude from model number extraction ──────────────

const GENERIC_TERMS = new Set([
  'usb', 'led', 'lcd', '3d', '5g', '2g', '4g', 'dc', 'ac', 'hd', '1080p',
  '720p', '4k', '8k', 'mp3', 'mp4', 'fm', 'am', 'tv', 'pc', 'dj', 'uk',
  'us', 'eu', 'au', 'ip65', 'ip67', 'ip68', 'ip44', 'ce', 'ul',
  'e-commerce', 'hi-fi', 'wi-fi', 'hi-res', 'in-ear', 'on-ear', 'over-ear',
]);

// ─── Model Number Extraction ────────────────────────────────────────────

/**
 * Extract alphanumeric model identifiers from a title.
 * E.g. "K2", "M118", "TWS-M10", "RX 9070"
 */
export function extractModelNumbers(title: string): string[] {
  const models: string[] = [];
  const seen = new Set<string>();

  // Pattern: letter(s) + optional hyphen + number(s), or number(s) + letter(s)
  // Matches: K2, M118, TWS10, TWS-M10, RX9070, 2.4G, A2S, T10Pro
  const patterns = [
    /\b([A-Z]{1,5}-[A-Z0-9]{1,10})\b/gi,    // Hyphenated: TWS-M10, BT-5.0
    /\b([A-Z]{1,5}\d{1,6}[A-Z0-9]*)\b/gi,    // Letter+number: K2, M118, T10Pro
    /\b(\d{1,4}[A-Z]{1,5}\d*)\b/gi,           // Number+letter: 2S, 9070XT
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(title)) !== null) {
      const model = match[1].toUpperCase();
      if (model.length >= 2 && !seen.has(model) && !GENERIC_TERMS.has(model.toLowerCase())) {
        seen.add(model);
        models.push(model);
      }
    }
  }

  return models;
}

// ─── Title Similarity ───────────────────────────────────────────────────

/**
 * Calculate similarity between two titles (0-100).
 * Uses word overlap (Jaccard-like) scoring.
 */
function titleSimilarity(title1: string, title2: string): number {
  const normalize = (s: string) =>
    s.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(w => w.length > 1); // Drop single-char words

  const words1 = new Set(normalize(title1));
  const words2 = new Set(normalize(title2));

  if (words1.size === 0 || words2.size === 0) return 0;

  let overlap = 0;
  for (const w of words1) {
    if (words2.has(w)) overlap++;
  }

  // Jaccard: intersection / union
  const union = new Set([...words1, ...words2]).size;
  return Math.round((overlap / union) * 100);
}

// ─── Internal DB Queries ────────────────────────────────────────────────

/**
 * Fetch all AE products from the internal aliexpress_source database.
 */
async function searchInternalAeProducts(): Promise<Array<{
  id: number;
  title: string;
  product_url: string;
  price_min: string;
  price_max: string;
}>> {
  const pool = await getPool();
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT p.id, p.title, p.product_url, p.price_min, p.price_max
     FROM aliexpress_source.products p
     WHERE p.status IN ('new', 'detailed')`,
  );
  return rows as Array<{
    id: number;
    title: string;
    product_url: string;
    price_min: string;
    price_max: string;
  }>;
}

/**
 * Get images for a specific AE product from aliexpress_source.product_images.
 */
async function getAeProductImages(aeProductId: number): Promise<string[]> {
  const pool = await getPool();
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT image_url FROM aliexpress_source.product_images
     WHERE product_id = ? ORDER BY image_order`,
    [aeProductId],
  );
  return rows.map((r: RowDataPacket) => r.image_url);
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Search the internal AE database for a product matching the given English title.
 * Returns the best match with score, or { found: false } if no good match.
 *
 * Scoring:
 *   - Model number match: +50 points
 *   - Title similarity (Jaccard): 0-50 points (scaled from 0-100 → 0-50)
 *   - Total: 0-100
 *
 * @param englishTitle - The English title of the 1688 product (from products_en)
 * @param minMatchScore - Minimum score (0-100) to accept a match. Default 25.
 */
export async function findMatchingAeProduct(
  englishTitle: string,
  minMatchScore: number = 25,
): Promise<AeMatchResult> {
  if (!englishTitle || englishTitle.trim().length < 3) {
    return { found: false, matchScore: 0 };
  }

  // Step 1: Extract model numbers from the 1688 English title
  const sourceModels = extractModelNumbers(englishTitle);
  logger.info('Extracted model numbers from source title', {
    title: englishTitle.substring(0, 60),
    models: sourceModels,
  });

  // Step 2: Query all AE products from internal DB
  const aeProducts = await searchInternalAeProducts();
  if (aeProducts.length === 0) {
    logger.info('No AE products in internal database');
    return { found: false, matchScore: 0 };
  }
  logger.info(`Searching ${aeProducts.length} AE products in internal database`);

  // Step 3: Score each AE product
  let bestMatch: typeof aeProducts[0] | null = null;
  let bestScore = 0;

  for (const aeProd of aeProducts) {
    let score = 0;

    // Model number match: +50 if any model number overlaps
    if (sourceModels.length > 0) {
      const aeModels = extractModelNumbers(aeProd.title);
      const hasModelMatch = sourceModels.some(m => aeModels.includes(m));
      if (hasModelMatch) {
        score += 50;
      }
    }

    // Title similarity: 0-50 (Jaccard scaled from 0-100 to 0-50)
    const similarity = titleSimilarity(englishTitle, aeProd.title);
    score += Math.round(similarity / 2);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = aeProd;
    }
  }

  if (!bestMatch || bestScore < minMatchScore) {
    logger.info('No AE match above threshold', {
      bestScore,
      minMatchScore,
      title: englishTitle.substring(0, 60),
    });
    return { found: false, matchScore: bestScore };
  }

  logger.info('Found AE match', {
    score: bestScore,
    aeTitle: bestMatch.title.substring(0, 60),
    aeId: bestMatch.id,
  });

  // Step 4: Fetch images for the best match
  const images = await getAeProductImages(bestMatch.id);
  if (images.length === 0) {
    logger.warn('AE match had no images, treating as no match');
    return { found: false, matchScore: bestScore };
  }

  return {
    found: true,
    matchScore: bestScore,
    product: {
      productId: String(bestMatch.id),
      url: bestMatch.product_url,
      title: bestMatch.title,
      images: images.slice(0, 10),
      description: '',  // Not needed for image replacement use case
      price: bestMatch.price_min || '',
    },
  };
}
