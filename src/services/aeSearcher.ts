/**
 * AliExpress Product Searcher
 *
 * Searches AliExpress for products matching a 1688 product.
 * Used by Task 5 (AE Enrichment) to find English images/info
 * for 1688 products that have Chinese text in their images.
 *
 * Approach:
 *   1. Take the 1688 product's English title (from products_en)
 *   2. Search AliExpress with those keywords
 *   3. Compare search results by title similarity
 *   4. If a good match is found, scrape the AE product page for images + info
 */

import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page } from 'puppeteer';
import { createChildLogger } from '../utils/logger';

puppeteerExtra.use(StealthPlugin());

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

// ─── Browser Management ─────────────────────────────────────────────────

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser && browser.connected) return browser;

  logger.info('Launching browser for AliExpress search...');
  browser = await puppeteerExtra.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
    defaultViewport: { width: 1440, height: 900 },
  });

  return browser;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    logger.info('AE search browser closed');
  }
}

// ─── Search AliExpress ──────────────────────────────────────────────────

/**
 * Search AliExpress by keywords and return top results.
 */
async function searchAliExpress(keywords: string, maxResults: number = 10): Promise<AeSearchResult[]> {
  const b = await getBrowser();
  const page = await b.newPage();
  const results: AeSearchResult[] = [];

  try {
    // Clean keywords: remove special chars, keep only meaningful words
    const cleanKeywords = keywords
      .replace(/[^\w\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .slice(0, 8) // Max 8 words to avoid over-specific search
      .join(' ');

    const searchUrl = `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(cleanKeywords)}`;
    logger.info('Searching AliExpress', { keywords: cleanKeywords, url: searchUrl });

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000)); // Wait for search results to load

    // Extract search results from the page
    const extracted = await page.evaluate((maxR: number) => {
      const items: Array<{
        productId: string;
        title: string;
        url: string;
        imageUrl: string;
        price: string;
      }> = [];

      // AliExpress search results are typically in card/list elements
      // Try multiple selectors as AE changes their DOM frequently
      const cards = Array.from(document.querySelectorAll(
        'a[href*="/item/"], a[href*="aliexpress.com/item"], [class*="product-card"] a, [class*="SearchProductFeed"] a'
      ));

      const seen = new Set<string>();
      for (const card of cards) {
        if (items.length >= maxR) break;

        const href = (card as HTMLAnchorElement).href || '';
        // Extract product ID from URL: /item/1234567890.html
        const idMatch = href.match(/\/item\/(\d{8,20})\.html/);
        if (!idMatch) continue;
        const productId = idMatch[1];
        if (seen.has(productId)) continue;
        seen.add(productId);

        // Get title from the card or its children
        const titleEl = card.querySelector('h1, h2, h3, [class*="title"], [class*="Title"]') || card;
        const title = (titleEl as HTMLElement).textContent?.trim() || '';
        if (!title || title.length < 5) continue;

        // Get image
        const img = card.querySelector('img') ||
                    card.closest('[class*="card"]')?.querySelector('img');
        const imageUrl = img?.src || img?.getAttribute('data-src') || '';

        // Get price
        const priceEl = card.querySelector('[class*="price"], [class*="Price"]');
        const price = priceEl?.textContent?.trim() || '';

        items.push({
          productId,
          title,
          url: `https://www.aliexpress.com/item/${productId}.html`,
          imageUrl,
          price,
        });
      }

      return items;
    }, maxResults);

    results.push(...extracted);
    logger.info(`AliExpress search returned ${results.length} results`, { keywords: cleanKeywords });
  } catch (error) {
    logger.error('AliExpress search failed', { error: (error as Error).message, keywords });
  } finally {
    await page.close();
  }

  return results;
}

// ─── Scrape AE Product Detail ───────────────────────────────────────────

/**
 * Scrape a single AliExpress product page for images and description.
 */
async function scrapeAeProduct(url: string): Promise<AeProductDetail | null> {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    logger.info('Scraping AE product', { url: url.substring(0, 80) });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));

    const detail = await page.evaluate(() => {
      const result = {
        title: '',
        images: [] as string[],
        description: '',
        price: '',
      };

      // Title
      const titleEl = document.querySelector('h1, [class*="product-title"], [data-pl="product-title"]');
      result.title = titleEl?.textContent?.trim() || '';

      // Images: gallery thumbnails and main image
      const imgEls = Array.from(document.querySelectorAll(
        'img[src*="alicdn"], img[class*="gallery"], img[class*="magnifier"], [class*="image-view"] img'
      ));
      const seen = new Set<string>();
      for (const img of imgEls) {
        let src = (img as HTMLImageElement).src || (img as HTMLImageElement).getAttribute('data-src') || '';
        // Normalize: remove size suffixes to get original size
        src = src.replace(/_\d+x\d+\.\w+$/, '').replace(/\?.*$/, '');
        if (src && src.includes('alicdn') && !seen.has(src) && !src.includes('icon') && !src.includes('logo')) {
          seen.add(src);
          result.images.push(src);
        }
      }

      // Description
      const descEl = document.querySelector(
        '[class*="product-description"], [class*="detail-desc"], [id*="description"]'
      );
      result.description = descEl?.textContent?.trim()?.substring(0, 5000) || '';

      // Price
      const priceEl = document.querySelector('[class*="product-price"], [class*="Price"]');
      result.price = priceEl?.textContent?.trim() || '';

      return result;
    });

    if (!detail.title && detail.images.length === 0) {
      logger.warn('AE product page returned empty data', { url: url.substring(0, 80) });
      return null;
    }

    // Extract product ID from URL
    const idMatch = url.match(/\/item\/(\d+)\.html/);
    const productId = idMatch ? idMatch[1] : '';

    return {
      productId,
      url,
      title: detail.title,
      images: detail.images.slice(0, 10), // Max 10 images
      description: detail.description,
      price: detail.price,
    };
  } catch (error) {
    logger.error('AE product scrape failed', { url: url.substring(0, 80), error: (error as Error).message });
    return null;
  } finally {
    await page.close();
  }
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

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Search AliExpress for a product matching the given English title.
 * Returns the best match with score, or { found: false } if no good match.
 *
 * @param englishTitle - The English title of the 1688 product (from products_en)
 * @param minMatchScore - Minimum similarity score (0-100) to accept a match. Default 25.
 */
export async function findMatchingAeProduct(
  englishTitle: string,
  minMatchScore: number = 25,
): Promise<AeMatchResult> {
  if (!englishTitle || englishTitle.trim().length < 3) {
    return { found: false, matchScore: 0 };
  }

  // Step 1: Search AliExpress
  const searchResults = await searchAliExpress(englishTitle, 10);
  if (searchResults.length === 0) {
    logger.info('No AE search results found', { title: englishTitle.substring(0, 60) });
    return { found: false, matchScore: 0 };
  }

  // Step 2: Find best match by title similarity
  let bestMatch: AeSearchResult | null = null;
  let bestScore = 0;

  for (const result of searchResults) {
    const score = titleSimilarity(englishTitle, result.title);
    logger.debug('Title similarity', {
      score,
      aeTitle: result.title.substring(0, 60),
      sourceTitle: englishTitle.substring(0, 60),
    });
    if (score > bestScore) {
      bestScore = score;
      bestMatch = result;
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
    aeId: bestMatch.productId,
  });

  // Step 3: Scrape the best match's product page for full details
  const detail = await scrapeAeProduct(bestMatch.url);
  if (!detail || detail.images.length === 0) {
    logger.warn('AE match had no usable images, treating as no match');
    return { found: false, matchScore: bestScore };
  }

  return {
    found: true,
    matchScore: bestScore,
    product: detail,
  };
}
