/**
 * Task 4: Translation
 * Translates product data from Chinese to English, converts prices,
 * and maps color families.
 *
 * Usage: node dist/tasks/task4-translate.js --limit 10
 */

import { translateProduct } from '../services/translator';
import { convertPrice } from '../services/priceConverter';
import {
  getProductsByStatusWithLimit,
  updateStatus,
  getProductRaw,
  getVariantsRaw,
  insertProductEN,
  insertVariantsEN,
  VariantEN,
} from '../database/repositories';
import { closeDatabase } from '../database/db';
import { createChildLogger } from '../utils/logger';
import { findClosestColorFamily, cleanVariantName } from '../utils/helpers';

const logger = createChildLogger('task4-translate');

function parseArgs(): { limit: number } {
  const args = process.argv.slice(2);
  let limit = 10;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--limit' || args[i] === '-l') && args[i + 1]) {
      limit = parseInt(args[++i]) || limit;
    }
  }
  return { limit };
}

async function main(): Promise<void> {
  const { limit } = parseArgs();
  logger.info('Task 4: Translation', { limit });

  const products = await getProductsByStatusWithLimit('images_checked', limit);
  if (products.length === 0) {
    logger.info('No products to translate');
    closeDatabase();
    return;
  }

  logger.info(`Found ${products.length} products to translate`);

  let translated = 0;
  let failed = 0;

  try {
    for (const prod of products) {
      logger.info(`Translating ${translated + failed + 1}/${products.length}: ${prod.titleZh.substring(0, 50)}`);

      try {
        // Get raw data
        const raw = await getProductRaw(prod.id);
        if (!raw) {
          logger.warn('No raw data found', { id: prod.id1688 });
          await updateStatus(prod.id, 'failed', 'No raw data');
          failed++;
          continue;
        }

        // Get variants
        const rawVariants = await getVariantsRaw(prod.id);

        // Build variants structure for translator
        let variantsForTranslation: { options: Array<{ name: string; values: string[] }>; skus: any[] } | undefined;
        if (rawVariants.length > 0) {
          // Group variants by option name
          const optionGroups = new Map<string, string[]>();
          for (const v of rawVariants) {
            const values = optionGroups.get(v.optionName) || [];
            if (!values.includes(v.optionValue)) {
              values.push(v.optionValue);
            }
            optionGroups.set(v.optionName, values);
          }

          const options = Array.from(optionGroups.entries()).map(([name, values]) => ({ name, values }));
          const skus = rawVariants.map(v => ({
            optionValues: { [v.optionName]: v.optionValue },
            priceCNY: Number(v.priceCny),
            stock: v.stock,
            image: v.imageUrl,
            available: v.available,
          }));

          variantsForTranslation = { options, skus };
        }

        // Translate
        const translation = await translateProduct(
          raw.titleZh,
          raw.descriptionZh,
          raw.specificationsZh,
          variantsForTranslation,
        );

        // Convert price
        const priceUsd = await convertPrice(Number(raw.priceCny));

        // Store raw CLI category name (no AliExpress sheet mapping)
        const category = prod.category;

        // Insert translated product
        await insertProductEN({
          productId: prod.id,
          titleEn: translation.titleEN,
          descriptionEn: translation.descriptionEN,
          specificationsEn: translation.specificationsEN,
          priceUsd,
          category,
        });

        // Insert translated variants with color family mapping
        if (rawVariants.length > 0 && translation.variantsEN) {
          const variantsEn: VariantEN[] = [];

          for (let i = 0; i < rawVariants.length; i++) {
            const rawV = rawVariants[i];
            const translatedSku = translation.variantsEN.skus[i];

            // Get translated option value
            const optionNameEn = translatedSku
              ? Object.keys(translatedSku.optionValues)[0] || 'Color'
              : 'Color';
            const optionValueEn = translatedSku
              ? Object.values(translatedSku.optionValues)[0] || cleanVariantName(rawV.optionValue)
              : cleanVariantName(rawV.optionValue);

            // Map to color family
            const colorFamily = findClosestColorFamily(optionValueEn) ||
              findClosestColorFamily(rawV.optionValue);

            // Convert variant price
            const variantPriceUsd = await convertPrice(Number(rawV.priceCny));

            variantsEn.push({
              productId: prod.id,
              rawVariantId: rawV.id,
              optionNameEn,
              optionValueEn: cleanVariantName(optionValueEn),
              optionValueZh: rawV.optionValue,
              priceUsd: variantPriceUsd,
              colorFamily,
              sortOrder: rawV.sortOrder,
            });
          }

          await insertVariantsEN(variantsEn);
        }

        await updateStatus(prod.id, 'translated');
        translated++;
        logger.info('Product translated', {
          id: prod.id1688,
          titleEn: translation.titleEN.substring(0, 60),
          priceUsd,
          variants: rawVariants.length,
        });

      } catch (error) {
        logger.error('Failed to translate product', {
          id: prod.id1688,
          error: (error as Error).message,
        });
        await updateStatus(prod.id, 'failed', (error as Error).message);
        failed++;
      }
    }

    logger.info('Task 4 complete', { translated, failed });
  } catch (error) {
    logger.error('Task 4 failed', { error: (error as Error).message });
  } finally {
    closeDatabase();
  }
}

main().catch((error) => {
  logger.error('Unhandled error', { error: error.message });
  process.exit(1);
});
