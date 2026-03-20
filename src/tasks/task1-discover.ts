/**
 * Task 1: Product Discovery
 * Searches 1688.com for products and saves basic info to the database.
 *
 * Usage: node dist/tasks/task1-discover.js --category earphones --limit 20
 * Runs on: China MacBook
 */

import { create1688Scraper } from '../scrapers/1688Scraper';
import { discoverProduct } from '../database/repositories';
import { closeDatabase } from '../database/db';
import { createChildLogger } from '../utils/logger';
import { isBannedBrand } from '../utils/helpers';
import { isPriceInRange } from '../services/priceConverter';
import { config, RED_OCEAN_CLI_CATEGORIES } from '../config';

const logger = createChildLogger('task1-discover');

interface CLIOptions {
  category: string;
  limit: number;
  headless: boolean;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {
    category: 'earphones',
    limit: 20,
    headless: false,
  };

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--category' || args[i] === '-c') && args[i + 1]) {
      options.category = args[++i];
    } else if ((args[i] === '--limit' || args[i] === '-l') && args[i + 1]) {
      options.limit = parseInt(args[++i]) || options.limit;
    } else if (args[i] === '--headless') {
      options.headless = true;
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs();

  // RED OCEAN GUARD — block banned L1 categories before opening a browser
  if (RED_OCEAN_CLI_CATEGORIES.has(options.category.toLowerCase())) {
    logger.error(
      `BLOCKED: "${options.category}" is a Red Ocean category (Women's Clothing, Men's Clothing, or Novelty & Special Use). ` +
      `These L1 categories are permanently banned for AliExpress store 2087779. ` +
      `See documents/aliexpress-store/aliexpress-2087779-blue-ocean-categories.md for approved targets.`
    );
    process.exit(1);
  }

  logger.info('Task 1: Product Discovery', options);

  const scraper = await create1688Scraper(options.headless);
  let discovered = 0;
  let skipped = 0;
  let duplicates = 0;

  try {
    // Login to 1688
    logger.info('Logging into 1688.com');
    const loggedIn = await scraper.login();
    if (!loggedIn) {
      logger.error('Failed to login to 1688.com');
      return;
    }

    // Search for products (returns basic info — no detail scraping yet)
    logger.info('Searching for products', { category: options.category, limit: options.limit });
    const products = await scraper.searchProducts(options.category, options.limit);
    logger.info('Found products from search', { count: products.length });

    // Insert each discovered product
    for (const product of products) {
      // Brand check
      if (isBannedBrand(product.title)) {
        logger.info('Skipping banned brand', { title: product.title.substring(0, 60) });
        skipped++;
        continue;
      }

      // Price range check
      if (product.priceCNY > 0 && !isPriceInRange(product.priceCNY)) {
        logger.info('Skipping price out of range', { price: product.priceCNY });
        skipped++;
        continue;
      }

      // MOQ check
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
        options.category,
        thumbnailUrl,
      );

      if (id) {
        discovered++;
        logger.info(`Discovered ${discovered}: ${product.title.substring(0, 50)}`);
      } else {
        duplicates++;
      }
    }

    logger.info('Task 1 complete', { discovered, skipped, duplicates });
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
