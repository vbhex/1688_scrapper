/**
 * Task 2b: Re-scrape Variants for Products Missing Variant Data
 *
 * Targets products with status 'exported' or 'translated' that have no entries
 * in products_variants_raw. Re-visits the 1688 page just to extract variant/SKU
 * data without modifying other product fields.
 *
 * Usage:
 *   node dist/tasks/task2b-rescrape-variants.js [--limit 20] [--headless]
 *
 * Runs on: China MacBook (needs browser access to 1688.com)
 */

import { create1688Scraper } from '../scrapers/1688Scraper';
import {
  deleteVariantsRaw,
  insertVariantsRaw,
  deleteProductVariants,
  insertProductVariant,
  insertVariantValues,
  insertVariantSkus,
  RawVariant,
  ProductVariant,
  VariantValue,
  VariantSku,
} from '../database/repositories';
import { closeDatabase, getPool } from '../database/db';
import { createChildLogger } from '../utils/logger';
import { get1688FullImageUrl, sleep } from '../utils/helpers';
import { RowDataPacket } from 'mysql2/promise';

const logger = createChildLogger('task2b-rescrape-variants');

function parseArgs(): { limit: number; headless: boolean } {
  const args = process.argv.slice(2);
  let limit = 20;
  let headless = false;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--limit' || args[i] === '-l') && args[i + 1]) {
      limit = parseInt(args[++i]) || limit;
    } else if (args[i] === '--headless') {
      headless = true;
    }
  }
  return { limit, headless };
}

async function main(): Promise<void> {
  const { limit, headless } = parseArgs();
  logger.info('Task 2b: Re-scrape Variants', { limit, headless });

  const pool = await getPool();

  // Find products that have been exported/translated but have no variant data at all
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT p.id, p.id_1688, p.url, p.title_zh
     FROM products p
     WHERE p.status IN ('exported', 'translated', 'listed')
       AND NOT EXISTS (
         SELECT 1 FROM products_variants_raw pvr WHERE pvr.product_id = p.id
       )
     ORDER BY p.id ASC
     LIMIT ${Math.max(1, Math.floor(limit))}`
  );

  if (rows.length === 0) {
    logger.info('All products already have variant data — nothing to re-scrape.');
    closeDatabase();
    return;
  }

  logger.info(`Found ${rows.length} products with no variant data to re-scrape`);

  const scraper = await create1688Scraper(headless, 'sourcing');
  let done = 0;
  let noVariants = 0;
  let failed = 0;

  try {
    const loggedIn = await scraper.login();
    if (!loggedIn) {
      logger.error('Failed to login to 1688.com');
      return;
    }

    for (const prod of rows) {
      logger.info(`[${done + noVariants + failed + 1}/${rows.length}] ${prod.title_zh?.substring(0, 50)}`);

      try {
        const basicProduct = {
          id1688: prod.id_1688,
          title: prod.title_zh || '',
          description: '',
          priceCNY: 0,
          images: [],
          specifications: [],
          seller: { name: '' },
          category: '',
          minOrderQty: 1,
          url: prod.url,
          scrapedAt: new Date(),
        };

        const detailed = await scraper.getProductDetails(basicProduct);

        if (!detailed.variants || detailed.variants.skus.length === 0) {
          logger.info('No variants found on 1688 page — product has single SKU', { id: prod.id_1688 });
          noVariants++;
          await sleep(2000);
          continue;
        }

        logger.info(`Found ${detailed.variants.options.length} option(s), ${detailed.variants.skus.length} SKU(s)`, {
          id: prod.id_1688,
          options: detailed.variants.options.map(o => `${o.name}(${o.values.length})`).join(', '),
        });

        // Clear old (empty) variant data and re-insert
        await deleteVariantsRaw(prod.id);
        await deleteProductVariants(prod.id);

        const colorOption = detailed.variants.options.find(o =>
          o.name.includes('颜色') || o.name.includes('色') || o.name.includes('款')
        );
        const primaryOption = colorOption || detailed.variants.options[0];
        const optionName = primaryOption?.name || '颜色';

        // OLD flat structure (used by excel generator and task4 translate)
        const variantsRaw: RawVariant[] = detailed.variants.skus.map((sku, i) => ({
          productId: prod.id,
          optionName,
          optionValue: sku.optionValues[optionName] || Object.values(sku.optionValues)[0] || '',
          priceCny: sku.priceCNY,
          stock: sku.stock || 0,
          imageUrl: sku.image ? get1688FullImageUrl(sku.image) : undefined,
          available: sku.available,
          sortOrder: i,
        }));
        await insertVariantsRaw(variantsRaw);

        // NEW normalized structure (product_variants / variant_values / variant_skus)
        const dimensionValues = new Map<string, Set<string>>();
        for (const sku of detailed.variants.skus) {
          for (const [dimName, valueName] of Object.entries(sku.optionValues)) {
            if (!dimensionValues.has(dimName)) dimensionValues.set(dimName, new Set());
            dimensionValues.get(dimName)!.add(valueName);
          }
        }

        const variantIdMap = new Map<string, number>();
        for (const [dimName, valuesSet] of dimensionValues) {
          const variantId = await insertProductVariant({
            productId: prod.id,
            variantNameZh: dimName,
          } as ProductVariant);
          variantIdMap.set(dimName, variantId);

          const values: VariantValue[] = Array.from(valuesSet).map((valueName, idx) => {
            const skuWithValue = detailed.variants!.skus.find(s => s.optionValues[dimName] === valueName);
            const imageUrl = skuWithValue?.image ? get1688FullImageUrl(skuWithValue.image) : undefined;
            return { variantId, valueNameZh: valueName, imageUrl, sortOrder: idx } as VariantValue;
          });
          await insertVariantValues(values);
        }

        const skuRows: VariantSku[] = detailed.variants.skus.map(sku => ({
          productId: prod.id,
          skuCode: Object.values(sku.optionValues).join('-'),
          variantValuesJson: sku.optionValues,
          priceCny: sku.priceCNY,
          stock: sku.stock || 0,
          available: sku.available,
          imageUrl: sku.image ? get1688FullImageUrl(sku.image) : undefined,
        } as VariantSku));
        await insertVariantSkus(skuRows);

        done++;
        logger.info('Variants saved', { id: prod.id_1688, skus: skuRows.length });
        await sleep(3000);

      } catch (err) {
        logger.error('Failed to re-scrape variants', { id: prod.id_1688, error: (err as Error).message });
        failed++;
        await sleep(5000);
      }
    }

  } finally {
    await scraper.close();
    closeDatabase();
  }

  logger.info('Task 2b complete', { done, noVariants, failed, total: rows.length });
}

main().catch(err => {
  logger.error('Fatal error', { error: err.message });
  process.exit(1);
});
