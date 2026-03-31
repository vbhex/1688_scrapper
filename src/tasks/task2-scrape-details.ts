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
  deleteProductVariants,
  insertProductVariant,
  insertVariantValues,
  insertVariantSkus,
  RawImage,
  RawVariant,
  ProductVariant,
  VariantValue,
  VariantSku,
} from '../database/repositories';
import { closeDatabase, getPool, upsertProvider, upsertAuthorizedProduct } from '../database/db';
import { createChildLogger } from '../utils/logger';
import { isBannedBrand, initBrandCache, get1688FullImageUrl, sleep } from '../utils/helpers';
import { ScrapedProduct } from '../models/product';

const logger = createChildLogger('task2-scrape');

function parseArgs(): { limit: number; headless: boolean; category?: string } {
  const args = process.argv.slice(2);
  let limit = 10;
  let headless = false;
  let category: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--limit' || args[i] === '-l') && args[i + 1]) {
      limit = parseInt(args[++i]) || limit;
    } else if (args[i] === '--headless') {
      headless = true;
    } else if ((args[i] === '--category' || args[i] === '-c') && args[i + 1]) {
      category = args[++i];
    }
  }
  return { limit, headless, category };
}

async function main(): Promise<void> {
  const { limit, headless, category } = parseArgs();
  logger.info('Task 2: Detail Scraping', { limit, headless, ...(category && { category }) });

  // Load brand list from DB (falls back to JSON if DB unavailable)
  await initBrandCache();

  // Get discovered products
  const products = await getProductsByStatusWithLimit('discovered', limit, category);
  if (products.length === 0) {
    logger.info('No discovered products to scrape');
    closeDatabase();
    return;
  }

  logger.info(`Found ${products.length} products to scrape details for`);

  let scraper = await create1688Scraper(headless, 'sourcing');
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
      logger.info(`Scraping ${scraped + failed + 1}/${products.length}: ${prod.titleZh?.substring(0, 50) ?? prod.id1688}`);

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
          logger.info('Banned brand detected in title/description, skipping', { id: prod.id1688 });
          await updateStatus(prod.id, 'skipped', 'Banned brand in title/description');
          failed++;
          continue;
        }

        // Brand check on seller name (some sellers specialise in knockoff brands)
        if (detailed.seller.name && isBannedBrand(detailed.seller.name)) {
          logger.info('Banned brand detected in seller name, skipping', {
            id: prod.id1688, sellerName: detailed.seller.name.substring(0, 60),
          });
          await updateStatus(prod.id, 'skipped', 'Banned brand in seller name');
          failed++;
          continue;
        }

        // Brand check on product specifications.
        // IMPORTANT: Only check spec VALUES when the spec KEY is a brand-declaration field
        // (品牌 / 商标 / brand / trademark).  Checking ALL spec values caused 400+ false
        // positives — common English words like "heat press", "oriental", "supreme quality",
        // "champion grade" match brand keywords but are innocent material/design descriptors.
        // Spec KEYS are always checked (catches "NIKE material:" type field labels).
        const BRAND_SPEC_KEYS = ['品牌', '商标', 'brand', 'trademark'];
        const specBannedEntry = detailed.specifications.find(spec => {
          // Always check the spec key name
          if (isBannedBrand(spec.name)) return true;
          // Only check spec value when the key declares brand/trademark
          const isBrandField = BRAND_SPEC_KEYS.some(k =>
            spec.name.toLowerCase().includes(k.toLowerCase())
          );
          return isBrandField && isBannedBrand(spec.value);
        });
        if (specBannedEntry) {
          logger.info('Banned brand detected in specifications, skipping', {
            id: prod.id1688, spec: `${specBannedEntry.name}: ${specBannedEntry.value}`.substring(0, 80),
          });
          await updateStatus(prod.id, 'skipped', 'Banned brand in specifications');
          failed++;
          continue;
        }

        // Brand check on variant option names and values
        // 1688 knockoff sellers sometimes hide brand names in variant labels
        // e.g., optionValues: { "颜色": "Ralph Lauren white" }
        if (detailed.variants) {
          let variantBrandFound = '';
          outer: for (const sku of detailed.variants.skus) {
            for (const [key, val] of Object.entries(sku.optionValues)) {
              if (isBannedBrand(key) || isBannedBrand(val)) {
                variantBrandFound = `${key}: ${val}`;
                break outer;
              }
            }
          }
          if (!variantBrandFound) {
            for (const opt of detailed.variants.options) {
              if (isBannedBrand(opt.name)) { variantBrandFound = opt.name; break; }
              const bannedVal = opt.values.find(v => isBannedBrand(v));
              if (bannedVal) { variantBrandFound = `${opt.name}: ${bannedVal}`; break; }
            }
          }
          if (variantBrandFound) {
            logger.info('Banned brand detected in variant values, skipping', {
              id: prod.id1688, variant: variantBrandFound.substring(0, 80),
            });
            await updateStatus(prod.id, 'skipped', `Banned brand in variant: ${variantBrandFound.substring(0, 100)}`);
            failed++;
            continue;
          }
        }

        // Clean up old data if re-running
        await deleteImagesRaw(prod.id);
        await deleteVariantsRaw(prod.id);
        await deleteProductVariants(prod.id); // NEW: cleanup normalized variants

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
          sellerId: detailed.seller.sellerId || undefined,
          sellerShopUrl: detailed.seller.shopUrl || undefined,
          sellerWangwangId: detailed.seller.wangwangId || undefined,
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

        // Insert variants (PARALLEL WRITE: both old flat structure and new normalized structure)
        if (detailed.variants && detailed.variants.skus.length > 0) {
          const colorOption = detailed.variants.options.find(o =>
            o.name.includes('颜色') || o.name.includes('色') || o.name.includes('款')
          );
          const optionName = colorOption?.name || detailed.variants.options[0]?.name || '颜色';

          // OLD STRUCTURE: Flat variant rows (backwards compatibility)
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

          // NEW STRUCTURE: Normalized multi-dimensional variants
          // Group by option/dimension name to handle multi-variant products (e.g., Color + Size)
          const dimensionMap = new Map<string, Set<string>>();
          
          for (const sku of detailed.variants.skus) {
            for (const [dimName, valueName] of Object.entries(sku.optionValues)) {
              if (!dimensionMap.has(dimName)) {
                dimensionMap.set(dimName, new Set());
              }
              dimensionMap.get(dimName)!.add(valueName);
            }
          }

          const variantIdMap = new Map<string, number>(); // dimension name -> variant ID

          // Insert variant dimensions
          let sortOrder = 0;
          for (const [dimName, valuesSet] of dimensionMap.entries()) {
            const variantId = await insertProductVariant({
              productId: prod.id,
              variantNameZh: dimName,
              sortOrder: sortOrder++,
            });
            variantIdMap.set(dimName, variantId);

            // Insert values for this dimension
            const values: VariantValue[] = Array.from(valuesSet).map((valueName, idx) => {
              // Find image for this value (if exists)
              const skuWithValue = detailed.variants!.skus.find(s => s.optionValues[dimName] === valueName);
              const imageUrl = skuWithValue?.image ? get1688FullImageUrl(skuWithValue.image) : undefined;

              return {
                variantId,
                valueNameZh: valueName,
                imageUrl,
                sortOrder: idx,
              };
            });

            await insertVariantValues(values);
          }

          // Insert SKU combinations
          const skus: VariantSku[] = detailed.variants.skus.map((sku) => ({
            productId: prod.id,
            variantValuesJson: sku.optionValues, // e.g., {"颜色": "红色", "尺寸": "大"}
            priceCny: sku.priceCNY,
            stock: sku.stock || 0,
            available: sku.available,
            imageUrl: sku.image ? get1688FullImageUrl(sku.image) : undefined,
          }));

          await insertVariantSkus(skus);

          logger.info('Variants inserted (dual-write)', {
            oldFormat: variants.length,
            dimensions: dimensionMap.size,
            skuCombinations: skus.length,
          });
        }

        // Update title_zh in products table
        const p = await getPool();
        await p.execute(
          'UPDATE products SET title_zh = ? WHERE id = ?',
          [detailed.title, prod.id]
        );

        // ── Provider tracking: upsert seller into providers table ──
        if (detailed.seller.sellerId) {
          try {
            await upsertProvider({
              providerName: detailed.seller.name || 'Unknown',
              platform: '1688',
              platformId: detailed.seller.sellerId,
              wangwangId: detailed.seller.wangwangId,
              shopUrl: detailed.seller.shopUrl,
              trustLevel: 'new',
              totalProducts: 1,
            });
          } catch (provErr: any) {
            logger.warn('Failed to upsert provider', { sellerId: detailed.seller.sellerId, error: provErr.message });
          }
        }

        // ── Brand spec tagging (for Task 8 outreach) ──
        // Do NOT auto-authorize — all products go through Task 8 seller verification.
        // But tag the brand spec value so Task 8 knows what to ask:
        //   "品牌: 无" → Task 8 asks: is this really unbranded?
        //   "品牌: SomeBrand" (not in banned list) → likely seller's own brand,
        //     Task 8 asks for authorization docs (usually safe, seller owns it)
        //   "品牌: SomeBrand" (in banned list) → already caught by isBannedBrand() above
        const brandSpec = detailed.specifications.find(s =>
          s.name === '品牌' || s.name === 'brand' || s.name === '品牌/型号'
        );
        if (brandSpec) {
          const brandValue = brandSpec.value.trim();
          const isNoBrand = /^(无品牌|无|OEM|自主品牌|other|其他|null|没有|N\/A|none)$/i.test(brandValue);
          if (!isNoBrand && brandValue.length > 0) {
            // Seller claims a specific brand — likely their own. Tag it for Task 8
            // to request authorization docs (品牌授权书)
            logger.info('Seller-claimed brand detected', {
              id: prod.id1688,
              brand: brandValue,
              action: 'Task 8 will request authorization',
            });
          }
        }

        await updateStatus(prod.id, 'detail_scraped');
        scraped++;
        logger.info(`Scraped successfully`, {
          id: prod.id1688,
          images: images.length,
          variants: detailed.variants?.skus.length || 0,
        });

      } catch (error) {
        const msg = (error as Error).message || '';
        logger.error('Failed to scrape product', { id: prod.id1688, error: msg });

        // Detached frame = browser page crashed. Recreate scraper and retry once.
        if (msg.includes('detached Frame') || msg.includes('detached frame') || msg.includes('Target closed') || msg.includes('Session closed')) {
          logger.warn('Browser frame detached, recreating scraper and retrying...', { id: prod.id1688 });
          try {
            await scraper.close().catch(() => {});
            scraper = await create1688Scraper(headless, 'sourcing');
            const reloggedIn = await scraper.login();
            if (reloggedIn) {
              const basicProduct2: ScrapedProduct = {
                id1688: prod.id1688, title: prod.titleZh, description: '',
                priceCNY: 0, images: [], specifications: [], seller: { name: '' },
                category: prod.category, minOrderQty: 1, url: prod.url, scrapedAt: new Date(),
              };
              const detailed2 = await scraper.getProductDetails(basicProduct2);
              await deleteImagesRaw(prod.id);
              await deleteVariantsRaw(prod.id);
              await deleteProductVariants(prod.id);
              await insertProductRaw({
                productId: prod.id, titleZh: detailed2.title, descriptionZh: detailed2.description,
                specificationsZh: detailed2.specifications, priceCny: detailed2.priceCNY,
                minOrderQty: detailed2.minOrderQty, sellerName: detailed2.seller.name, sellerRating: detailed2.seller.rating || 0,
              });
              const images2: RawImage[] = detailed2.images.map((url, i) => ({
                productId: prod.id, imageUrl: get1688FullImageUrl(url), imageType: 'gallery' as const, sortOrder: i,
              }));
              if (images2.length > 0) await insertImagesRaw(images2);
              const p2 = await getPool();
              await p2.execute('UPDATE products SET title_zh = ? WHERE id = ?', [detailed2.title, prod.id]);
              await updateStatus(prod.id, 'detail_scraped');
              scraped++;
              logger.info('Retry succeeded after browser recreate', { id: prod.id1688, images: images2.length });
              continue;
            }
          } catch (retryErr) {
            logger.error('Retry after browser recreate also failed', { id: prod.id1688, error: (retryErr as Error).message });
          }
        }

        await updateStatus(prod.id, 'failed', msg);
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
