/**
 * Task 1: Product Discovery
 * Searches 1688.com for products and saves basic info to the database.
 *
 * Usage:
 *   node dist/tasks/task1-discover.js --category earphones --limit 20
 *   node dist/tasks/task1-discover.js --all-blue-ocean --limit 25     # loop ALL 335 enabled categories
 *   node dist/tasks/task1-discover.js --all-blue-ocean --limit 25 --l1 "Watches"  # filter by L1
 *   node dist/tasks/task1-discover.js --all-blue-ocean --limit 25 --batch 5 --resume  # 5 categories, skip completed
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
  batch: number;      // 0 = all, N = process N categories then exit (for alternating with Task 2)
  resume: boolean;    // Skip categories that already have >= limit products in DB
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {
    category: 'earphones',
    allBlueOcean: false,
    l1Filter: '',
    limit: 20,
    headless: false,
    batch: 0,
    resume: false,
  };

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--category' || args[i] === '-c') && args[i + 1]) {
      options.category = args[++i];
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
    const id = await discoverProduct(
      product.id1688,
      product.url,
      product.title,
      categoryLabel,
      thumbnailUrl,
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

  const scraper = await create1688Scraper(options.headless);
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

    for (const cat of categories) {
      try {
        categoriesProcessed++;
        logger.info(`[${categoriesProcessed}/${categories.length}] Processing: ${cat.label} (${cat.searchTerm})`, { l1: cat.l1 });

        const result = await discoverCategory(scraper, cat.searchTerm, cat.label, options.limit);
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
