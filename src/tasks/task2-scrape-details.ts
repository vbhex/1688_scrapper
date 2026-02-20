/**
 * Task 2: Detail Scraping
 * Visits each discovered product's 1688 page and scrapes full details
 * into normalized tables (products_raw, products_images_raw, products_variants_raw).
 *
 * Usage: node dist/tasks/task2-scrape-details.js --limit 10
 * Runs on: China MacBook
 */

import { create1688Scraper } from '../scrapers/1688Scraper';
import {
  getProductsByStatusWithLimit,
  updateStatus,
  insertProductRaw,
  insertImagesRaw,
  insertVariantsRaw,
  deleteImagesRaw,
  deleteVariantsRaw,
  RawImage,
  RawVariant,
} from '../database/repositories';
import { closeDatabase, getPool } from '../database/db';
import { createChildLogger } from '../utils/logger';
import { isBannedBrand, get1688FullImageUrl, sleep } from '../utils/helpers';
import { ScrapedProduct } from '../models/product';

const logger = createChildLogger('task2-scrape');

function parseArgs(): { limit: number; headless: boolean } {
  const args = process.argv.slice(2);
  let limit = 10;
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
  logger.info('Task 2: Detail Scraping', { limit, headless });

  // Get discovered products
  const products = await getProductsByStatusWithLimit('discovered', limit);
  if (products.length === 0) {
    logger.info('No discovered products to scrape');
    closeDatabase();
    return;
  }

  logger.info(`Found ${products.length} products to scrape details for`);

  const scraper = await create1688Scraper(headless);
  let scraped = 0;
  let failed = 0;

  try {
    // Login to 1688
    const loggedIn = await scraper.login();
    if (!loggedIn) {
      logger.error('Failed to login to 1688.com');
      return;
    }

    for (const prod of products) {
      logger.info(`Scraping ${scraped + failed + 1}/${products.length}: ${prod.titleZh.substring(0, 50)}`);

      try {
        // Create a minimal ScrapedProduct to pass to getProductDetails
        const basicProduct: ScrapedProduct = {
          id1688: prod.id1688,
          title: prod.titleZh,
          description: '',
          priceCNY: 0,
          images: [],
          specifications: [],
          seller: { name: '' },
          category: prod.category,
          minOrderQty: 1,
          url: prod.url,
          scrapedAt: new Date(),
        };

        const detailed = await scraper.getProductDetails(basicProduct);

        // Brand check on full title + description
        if (isBannedBrand(detailed.title) || isBannedBrand(detailed.description)) {
          logger.info('Banned brand detected in details, skipping', { id: prod.id1688 });
          await updateStatus(prod.id, 'skipped', 'Banned brand in details');
          failed++;
          continue;
        }

        // Clean up old data if re-running
        await deleteImagesRaw(prod.id);
        await deleteVariantsRaw(prod.id);

        // Insert into products_raw
        await insertProductRaw({
          productId: prod.id,
          titleZh: detailed.title,
          descriptionZh: detailed.description,
          specificationsZh: detailed.specifications,
          priceCny: detailed.priceCNY,
          minOrderQty: detailed.minOrderQty,
          sellerName: detailed.seller.name,
          sellerRating: detailed.seller.rating || 0,
        });

        // Insert gallery images
        const images: RawImage[] = detailed.images.map((url, i) => ({
          productId: prod.id,
          imageUrl: get1688FullImageUrl(url),
          imageType: 'gallery' as const,
          sortOrder: i,
        }));

        // Insert variant images (if different from gallery)
        const galleryUrls = new Set(images.map(img => img.imageUrl));
        if (detailed.variants) {
          for (const sku of detailed.variants.skus) {
            if (sku.image) {
              const fullUrl = get1688FullImageUrl(sku.image);
              if (!galleryUrls.has(fullUrl)) {
                // Find the color value for this variant
                const colorOption = detailed.variants.options.find(o =>
                  o.name.includes('颜色') || o.name.includes('色') || o.name.includes('款')
                );
                const colorValue = colorOption
                  ? sku.optionValues[colorOption.name] || ''
                  : Object.values(sku.optionValues)[0] || '';

                images.push({
                  productId: prod.id,
                  imageUrl: fullUrl,
                  imageType: 'variant',
                  sortOrder: images.length,
                  variantValue: colorValue,
                });
                galleryUrls.add(fullUrl);
              }
            }
          }
        }

        if (images.length > 0) {
          await insertImagesRaw(images);
          logger.info('Images inserted', { count: images.length });
        }

        // Insert variants
        if (detailed.variants && detailed.variants.skus.length > 0) {
          const colorOption = detailed.variants.options.find(o =>
            o.name.includes('颜色') || o.name.includes('色') || o.name.includes('款')
          );
          const optionName = colorOption?.name || detailed.variants.options[0]?.name || '颜色';

          const variants: RawVariant[] = detailed.variants.skus.map((sku, i) => ({
            productId: prod.id,
            optionName,
            optionValue: sku.optionValues[optionName] || Object.values(sku.optionValues)[0] || '',
            priceCny: sku.priceCNY,
            stock: sku.stock || 0,
            imageUrl: sku.image ? get1688FullImageUrl(sku.image) : undefined,
            available: sku.available,
            sortOrder: i,
          }));

          await insertVariantsRaw(variants);
        }

        // Update title_zh in products table
        const p = await getPool();
        await p.execute(
          'UPDATE products SET title_zh = ? WHERE id = ?',
          [detailed.title, prod.id]
        );

        await updateStatus(prod.id, 'detail_scraped');
        scraped++;
        logger.info(`Scraped successfully`, {
          id: prod.id1688,
          images: images.length,
          variants: detailed.variants?.skus.length || 0,
        });

      } catch (error) {
        logger.error('Failed to scrape product', {
          id: prod.id1688,
          error: (error as Error).message,
        });
        await updateStatus(prod.id, 'failed', (error as Error).message);
        failed++;
      }
    }

    logger.info('Task 2 complete', { scraped, failed });
  } catch (error) {
    logger.error('Task 2 failed', { error: (error as Error).message });
  } finally {
    await scraper.close();
    closeDatabase();
  }
}

main().catch((error) => {
  logger.error('Unhandled error', { error: error.message });
  process.exit(1);
});
