/**
 * Task 1: Product Discovery
 * Searches 1688.com for products and saves basic info to the database.
 *
 * TWO DISCOVERY MODES run every time:
 *
 *   1. Blue-ocean categories (AliExpress / eBay / Etsy)
 *      Keyword search for brand-safe categories (Phase 1) or all blue-ocean (Phase 2).
 *      source_type = 'brand_safe_discovery' | 'auto_discovery'
 *
 *   2. Verified provider stores (Amazon + any platform in providers.target_platforms)
 *      Checks providers table for trust_level='verified' stores not yet scraped.
 *      Scrapes ALL products from each store page.
 *      source_type = 'manual_seller', provider_id = providers.id
 *      Skips stores scraped within the last 7 days (configurable with --provider-rescrape-days).
 *
 * Usage:
 *   node dist/tasks/task1-discover.js --category earphones --limit 20
 *   node dist/tasks/task1-discover.js --all-blue-ocean --limit 25
 *   node dist/tasks/task1-discover.js --all-blue-ocean --limit 25 --batch 5 --resume
 *   node dist/tasks/task1-discover.js --all-blue-ocean --provider-rescrape-days 3  # re-check stores every 3 days
 * Runs on: China MacBook
 */

import { create1688Scraper } from '../scrapers/1688Scraper';
import { discoverProduct } from '../database/repositories';
import { closeDatabase, getPool } from '../database/db';
import { createChildLogger } from '../utils/logger';
import { isBannedBrand, initBrandCache } from '../utils/helpers';
import { isPriceInRange } from '../services/priceConverter';
import { config, RED_OCEAN_CLI_CATEGORIES } from '../config';
import * as fs from 'fs';
import * as path from 'path';
import { RowDataPacket } from 'mysql2';

const logger = createChildLogger('task1-discover');

interface SearchTermEntry {
  l1: string;
  search_terms_zh: string[];
  enabled: boolean;
  brand_safe?: boolean;
}

interface CLIOptions {
  category: string;
  allBlueOcean: boolean;
  l1Filter: string;
  limit: number;
  headless: boolean;
  batch: number;               // 0 = all, N = process N categories then exit
  resume: boolean;             // Skip categories that already have >= limit products in DB
  providerRescrapedays: number; // Re-scrape verified stores after this many days (default: 7)
  providersOnly: boolean;      // Skip Mode A category search; only run Mode B (verified provider stores)
}

interface VerifiedProvider {
  id: number;
  provider_name: string;
  shop_url: string;
  target_platforms: string[];
  last_scraped_at: Date | null;
  category_keywords: string[] | null; // if set, only products whose title contains ≥1 keyword are imported
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {
    category: '',
    allBlueOcean: true,  // default: process all blue ocean categories
    l1Filter: '',
    limit: 20,
    headless: false,
    batch: 0,
    resume: false,
    providerRescrapedays: 7,
    providersOnly: false,
  };

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--category' || args[i] === '-c') && args[i + 1]) {
      options.category = args[++i];
      options.allBlueOcean = false; // explicit category overrides all-blue-ocean
    } else if (args[i] === '--all-blue-ocean') {
      options.allBlueOcean = true;
    } else if (args[i] === '--l1' && args[i + 1]) {
      options.l1Filter = args[++i];
    } else if ((args[i] === '--limit' || args[i] === '-l') && args[i + 1]) {
      options.limit = parseInt(args[++i]) || options.limit;
    } else if (args[i] === '--headless') {
      options.headless = true;
    } else if (args[i] === '--batch' && args[i + 1]) {
      options.batch = parseInt(args[++i]) || 0;
    } else if (args[i] === '--resume') {
      options.resume = true;
    } else if (args[i] === '--provider-rescrape-days' && args[i + 1]) {
      options.providerRescrapedays = parseInt(args[++i]) || 7;
    } else if (args[i] === '--providers-only') {
      options.providersOnly = true;
    }
  }

  return options;
}

function loadBlueOceanCategories(l1Filter: string): Array<{ sheet: string; searchTerm: string; l1: string; brandSafe: boolean }> {
  const filePath = path.join(__dirname, '..', 'data', 'blue-ocean-search-terms.json');
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const categories: Array<{ sheet: string; searchTerm: string; l1: string; brandSafe: boolean }> = [];

  for (const [sheet, entry] of Object.entries(raw)) {
    if (sheet === '_meta') continue;
    const e = entry as SearchTermEntry;
    if (!e.enabled) continue;
    if (l1Filter && e.l1.toLowerCase() !== l1Filter.toLowerCase()) continue;
    for (const term of e.search_terms_zh) {
      categories.push({ sheet, searchTerm: term, l1: e.l1, brandSafe: !!e.brand_safe });
    }
  }

  // Sort: brand-safe categories first (they flow through pipeline faster)
  categories.sort((a, b) => {
    if (a.brandSafe && !b.brandSafe) return -1;
    if (!a.brandSafe && b.brandSafe) return 1;
    return 0;
  });

  return categories;
}

async function discoverCategory(
  scraper: any,
  searchTerm: string,
  categoryLabel: string,
  limit: number,
  brandSafe: boolean = false,
): Promise<{ discovered: number; skipped: number; duplicates: number }> {
  let discovered = 0;
  let skipped = 0;
  let duplicates = 0;

  logger.info('Searching for products', { category: categoryLabel, searchTerm, limit });
  const products = await scraper.searchProducts(searchTerm, limit);
  logger.info('Found products from search', { count: products.length, searchTerm });

  for (const product of products) {
    if (isBannedBrand(product.title)) {
      logger.info('Skipping banned brand', { title: product.title.substring(0, 60) });
      skipped++;
      continue;
    }

    if (product.priceCNY > 0 && !isPriceInRange(product.priceCNY)) {
      logger.info('Skipping price out of range', { price: product.priceCNY });
      skipped++;
      continue;
    }

    if (product.minOrderQty > config.filters.minOrderQty) {
      logger.info('Skipping high MOQ', { moq: product.minOrderQty });
      skipped++;
      continue;
    }

    const thumbnailUrl = product.images.length > 0 ? product.images[0] : '';
    const sourceType = brandSafe ? 'brand_safe_discovery' : 'auto_discovery';
    const id = await discoverProduct(
      product.id1688,
      product.url,
      product.title,
      categoryLabel,
      thumbnailUrl,
      sourceType,
    );

    if (id) {
      discovered++;
      logger.info(`Discovered ${discovered}: ${product.title.substring(0, 50)}`);
    } else {
      duplicates++;
    }
  }

  return { discovered, skipped, duplicates };
}

async function getVerifiedProviders(reScrapeAfterDays: number): Promise<VerifiedProvider[]> {
  const pool = await getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, provider_name, shop_url, target_platforms, last_scraped_at, category_keywords
     FROM providers
     WHERE trust_level = 'verified'
       AND shop_url IS NOT NULL
       AND (
         last_scraped_at IS NULL
         OR last_scraped_at < DATE_SUB(NOW(), INTERVAL ${Number(reScrapeAfterDays)} DAY)
       )
     ORDER BY last_scraped_at ASC`
  );
  return rows.map(r => ({
    id: r.id,
    provider_name: r.provider_name,
    shop_url: r.shop_url,
    target_platforms: (() => {
      try {
        const p = typeof r.target_platforms === 'string' ? JSON.parse(r.target_platforms) : r.target_platforms;
        return Array.isArray(p) ? p : [];
      } catch { return []; }
    })(),
    last_scraped_at: r.last_scraped_at || null,
    category_keywords: (() => {
      try {
        const k = typeof r.category_keywords === 'string' ? JSON.parse(r.category_keywords) : r.category_keywords;
        return Array.isArray(k) && k.length > 0 ? k : null;
      } catch { return null; }
    })(),
  }));
}

async function markProviderScraped(providerId: number): Promise<void> {
  const pool = await getPool();
  await pool.execute('UPDATE providers SET last_scraped_at = NOW() WHERE id = ?', [providerId]);
}

async function getCompletedCategories(limit: number): Promise<Set<string>> {
  const pool = await getPool();
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT category, COUNT(*) as cnt FROM products
     WHERE status != 'skipped'
     GROUP BY category HAVING cnt >= ?`,
    [limit]
  );
  return new Set(rows.map(r => r.category));
}

async function main(): Promise<void> {
  const options = parseArgs();

  await initBrandCache();

  // Build category list
  let categories: Array<{ searchTerm: string; label: string; l1: string; brandSafe: boolean }>;

  if (options.allBlueOcean) {
    const blueOcean = loadBlueOceanCategories(options.l1Filter);
    categories = blueOcean.map(c => ({
      searchTerm: c.searchTerm,
      label: c.sheet,
      l1: c.l1,
      brandSafe: c.brandSafe,
    }));

    // Resume mode: skip categories already completed
    if (options.resume) {
      const completed = await getCompletedCategories(options.limit);
      const before = categories.length;
      categories = categories.filter(c => !completed.has(c.label));
      logger.info('Resume mode: skipping completed categories', {
        totalBefore: before,
        alreadyCompleted: completed.size,
        remaining: categories.length,
      });
    }

    // Batch mode: only process first N categories
    if (options.batch > 0 && categories.length > options.batch) {
      categories = categories.slice(0, options.batch);
      logger.info('Batch mode: limiting to first N categories', { batch: options.batch });
    }

    logger.info('All Blue Ocean mode', {
      totalCategories: categories.length,
      l1Filter: options.l1Filter || 'ALL',
      limitPerCategory: options.limit,
    });
  } else {
    // Single category mode (legacy)
    if (RED_OCEAN_CLI_CATEGORIES.has(options.category.toLowerCase())) {
      logger.error(
        `BLOCKED: "${options.category}" is a Red Ocean category (Women's Clothing, Men's Clothing, or Novelty & Special Use). ` +
        `These L1 categories are permanently banned for AliExpress store 2087779. ` +
        `See documents/aliexpress-store/aliexpress-2087779-blue-ocean-categories.md for approved targets.`
      );
      process.exit(1);
    }
    categories = [{ searchTerm: options.category, label: options.category, l1: '', brandSafe: false }];
  }

  logger.info('Task 1: Product Discovery', { mode: options.allBlueOcean ? 'all-blue-ocean' : 'single', totalSearchTerms: categories.length });

  const scraper = await create1688Scraper(options.headless, 'sourcing');
  let totalDiscovered = 0;
  let totalSkipped = 0;
  let totalDuplicates = 0;
  let categoriesProcessed = 0;
  let categoriesFailed = 0;

  try {
    logger.info('Logging into 1688.com');
    const loggedIn = await scraper.login();
    if (!loggedIn) {
      logger.error('Failed to login to 1688.com');
      return;
    }

    for (const cat of options.providersOnly ? [] : categories) {
      try {
        categoriesProcessed++;
        logger.info(`[${categoriesProcessed}/${categories.length}] Processing: ${cat.label} (${cat.searchTerm})`, { l1: cat.l1 });

        const result = await discoverCategory(scraper, cat.searchTerm, cat.label, options.limit, cat.brandSafe);
        totalDiscovered += result.discovered;
        totalSkipped += result.skipped;
        totalDuplicates += result.duplicates;

        logger.info(`[${categoriesProcessed}/${categories.length}] Done: ${cat.label}`, {
          discovered: result.discovered,
          skipped: result.skipped,
          duplicates: result.duplicates,
        });

        // Small delay between categories to avoid rate limiting
        if (categoriesProcessed < categories.length) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (catError) {
        categoriesFailed++;
        logger.error(`Category failed: ${cat.label} (${cat.searchTerm})`, { error: (catError as Error).message });
        // Continue to next category — don't abort the whole run
      }
    }

    logger.info('══════════════════════════════════════════');
    logger.info('Task 1: Discovery Complete', {
      categoriesProcessed,
      categoriesFailed,
      totalDiscovered,
      totalSkipped,
      totalDuplicates,
    });
    logger.info('══════════════════════════════════════════');

    // ── VERIFIED PROVIDER STORE SCRAPING ────────────────────────────────────
    // Scrape all products from 1688 stores belonging to trust_level='verified'
    // providers. Products are tagged source_type='manual_seller' and routed to
    // the platforms listed in providers.target_platforms (e.g. ['amazon']).
    // Stores are re-scraped every `providerRescrapedays` days.
    const verifiedProviders = await getVerifiedProviders(options.providerRescrapedays);

    if (verifiedProviders.length === 0) {
      logger.info('No verified providers need scraping right now');
    } else {
      logger.info(`Found ${verifiedProviders.length} verified provider store(s) to scrape`);

      for (const provider of verifiedProviders) {
        logger.info('Scraping verified provider store', {
          id: provider.id,
          name: provider.provider_name,
          shopUrl: provider.shop_url,
          targetPlatforms: provider.target_platforms,
        });

        try {
          const storeProducts = await scraper.scrapeStoreProducts(provider.shop_url, 0);
          let providerDiscovered = 0;
          let providerSkipped = 0;
          let providerDuplicates = 0;

          for (const product of storeProducts) {
            // Category keyword filter — skip products not matching the provider's target category
            if (provider.category_keywords) {
              const titleLower = product.title.toLowerCase();
              const matches = provider.category_keywords.some(kw => titleLower.includes(kw.toLowerCase()));
              if (!matches) {
                providerSkipped++;
                continue;
              }
            }

            if (isBannedBrand(product.title)) {
              logger.info('Provider product: skipping banned brand', { title: product.title.substring(0, 60) });
              providerSkipped++;
              continue;
            }

            const thumbnailUrl = product.images.length > 0 ? product.images[0] : '';
            const id = await discoverProduct(
              product.id1688,
              product.url,
              product.title,
              `provider_${provider.id}`,   // category label identifies the source provider
              thumbnailUrl,
              'manual_seller',
              provider.id,
            );

            if (id) {
              providerDiscovered++;
              logger.info(`Provider product discovered: ${product.title.substring(0, 50)}`);
            } else {
              providerDuplicates++;
            }
          }

          await markProviderScraped(provider.id);

          logger.info('Provider store scrape done', {
            provider: provider.provider_name,
            discovered: providerDiscovered,
            skipped: providerSkipped,
            duplicates: providerDuplicates,
          });

          totalDiscovered += providerDiscovered;
          totalSkipped += providerSkipped;
        } catch (providerErr) {
          logger.error('Provider store scrape failed', {
            provider: provider.provider_name,
            error: (providerErr as Error).message,
          });
        }
      }
    }
    // ── END VERIFIED PROVIDER STORE SCRAPING ────────────────────────────────
  } catch (error) {
    logger.error('Task 1 failed', { error: (error as Error).message });
  } finally {
    await scraper.close();
    closeDatabase();
  }
}

main().catch((error) => {
  logger.error('Unhandled error', { error: error.message });
  process.exit(1);
});
