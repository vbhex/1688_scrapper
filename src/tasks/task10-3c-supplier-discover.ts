/**
 * Task 10: 3C Supplier Discovery for Amazon
 *
 * Searches 1688 for 3C electronics factories/suppliers using company search.
 * Extracts unique store info, deduplicates against existing providers,
 * and inserts new suppliers into the providers table for outreach.
 *
 * Usage:
 *   node dist/tasks/task10-3c-supplier-discover.js [--category earphones] [--limit 20] [--dry-run] [--headless]
 *
 * Options:
 *   --category <name>  Only search this 3C category (default: all 13)
 *   --limit <n>        Max suppliers per keyword (default: 20)
 *   --dry-run          Print what would be inserted without writing to DB
 *   --headless         Run browser in headless mode
 *
 * Runs on: China MacBook (requires 1688 access)
 */

import { create1688Scraper } from '../scrapers/1688Scraper';
import {
  getProviderByPlatformId,
  upsertProvider,
  closeDatabase,
} from '../database/db';
import { createChildLogger } from '../utils/logger';
import { randomDelay } from '../utils/helpers';
import { SUPPLIER_3C_KEYWORDS, SupplierSearchResult } from '../models/product';

const logger = createChildLogger('task10-3c-discover');

interface CLIOptions {
  category: string | null;
  limit: number;
  dryRun: boolean;
  headless: boolean;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = { category: null, limit: 20, dryRun: false, headless: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') options.dryRun = true;
    else if (args[i] === '--headless') options.headless = true;
    else if ((args[i] === '--category' || args[i] === '-c') && args[i + 1]) {
      options.category = args[++i];
    } else if ((args[i] === '--limit' || args[i] === '-l') && args[i + 1]) {
      options.limit = parseInt(args[++i]) || 20;
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs();
  logger.info('Task 10: 3C Supplier Discovery', options);

  // Determine which categories to search
  const categoriesToSearch = options.category
    ? { [options.category]: SUPPLIER_3C_KEYWORDS[options.category] }
    : SUPPLIER_3C_KEYWORDS;

  if (options.category && !SUPPLIER_3C_KEYWORDS[options.category]) {
    logger.error(`Unknown category: ${options.category}`);
    logger.info('Available categories:', Object.keys(SUPPLIER_3C_KEYWORDS).join(', '));
    process.exit(1);
  }

  const scraper = await create1688Scraper(options.headless);

  let totalDiscovered = 0;
  let totalNew = 0;
  let totalDuplicate = 0;

  try {
    for (const [category, keywords] of Object.entries(categoriesToSearch)) {
      logger.info(`\n${'='.repeat(60)}`);
      logger.info(`Category: ${category} (${keywords.length} keywords)`);
      logger.info('='.repeat(60));

      const allSuppliers: SupplierSearchResult[] = [];
      const seenIds = new Set<string>();

      for (const keyword of keywords) {
        logger.info(`Searching: "${keyword}"`);

        const suppliers = await scraper.searchSuppliers(keyword, options.limit);
        logger.info(`Found ${suppliers.length} suppliers for "${keyword}"`);

        for (const s of suppliers) {
          if (!seenIds.has(s.sellerId)) {
            seenIds.add(s.sellerId);
            allSuppliers.push(s);
          }
        }

        // Delay between searches to avoid rate limiting
        await randomDelay(5000, 8000);
      }

      logger.info(`Category "${category}": ${allSuppliers.length} unique suppliers found`);

      // Deduplicate against existing providers and insert new ones
      for (const supplier of allSuppliers) {
        totalDiscovered++;

        // Check if already in providers table
        const existing = await getProviderByPlatformId('1688', supplier.sellerId);
        if (existing) {
          totalDuplicate++;
          logger.debug(`Duplicate: ${supplier.storeName} (${supplier.sellerId}) — already in providers`);
          continue;
        }

        if (options.dryRun) {
          logger.info(`[DRY RUN] Would insert: ${supplier.storeName} | ${supplier.storeUrl} | category: ${category}`);
          totalNew++;
          continue;
        }

        // Insert into providers table
        const providerId = await upsertProvider({
          providerName: supplier.storeName,
          platform: '1688',
          platformId: supplier.sellerId,
          shopUrl: supplier.storeUrl,
          trustLevel: 'new',
          totalProducts: 0,
          notes: JSON.stringify({
            source: '3c_outreach',
            targetPlatform: 'amazon',
            category,
            mainProducts: supplier.mainProducts || '',
            location: supplier.location || '',
            discoveredAt: new Date().toISOString(),
          }),
        });

        // Update the new columns (source, target_platform, main_categories)
        // These are set via direct SQL since upsertProvider doesn't include them yet
        const pool = (await import('../database/db')).getPool;
        const p = await pool();
        await p.execute(
          `UPDATE providers SET source = '3c_outreach', target_platform = 'amazon', main_categories = ? WHERE id = ?`,
          [JSON.stringify([category]), providerId]
        );

        totalNew++;
        logger.info(`Inserted: ${supplier.storeName} | ${supplier.storeUrl} | category: ${category}`);
      }

      // Delay between categories
      if (Object.keys(categoriesToSearch).indexOf(category) < Object.keys(categoriesToSearch).length - 1) {
        logger.info('Waiting before next category...');
        await randomDelay(8000, 12000);
      }
    }

    logger.info('\n' + '='.repeat(60));
    logger.info('Task 10 Summary:');
    logger.info(`  Total found: ${totalDiscovered}`);
    logger.info(`  New suppliers: ${totalNew}`);
    logger.info(`  Duplicates skipped: ${totalDuplicate}`);
    logger.info('='.repeat(60));

  } finally {
    await scraper.close();
    closeDatabase();
  }
}

main().catch((err) => {
  logger.error('Task 10 failed', { error: err.message, stack: err.stack });
  closeDatabase();
  process.exit(1);
});
