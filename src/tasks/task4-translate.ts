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
  getProductVariantsWithValues,
  updateVariantNameTranslation,
  updateVariantValueTranslation,
  VariantEN,
} from '../database/repositories';
import { closeDatabase, getPool } from '../database/db';
import { RowDataPacket } from 'mysql2/promise';
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

  // Only translate products that are brand-verified (in authorized_products).
  // This saves translation fees — unverified products don't get translated.
  // Pipeline: Task 1→2→3 → Task 8 (verify) → Task 4 (translate) → Task 5 → Excel
  const pool = await getPool();
  const safeLimit = Math.max(1, Math.floor(limit));
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT p.id, p.id_1688 AS id1688, p.status, p.url, p.title_zh AS titleZh, p.category, p.raw_data AS rawData
     FROM products p
     JOIN authorized_products ap ON ap.product_id = p.id AND ap.active = TRUE
     WHERE p.status = 'images_checked'
     ORDER BY p.id ASC
     LIMIT ${safeLimit}`
  );
  const products = rows as any[];
  if (products.length === 0) {
    logger.info('No authorized products to translate (need Task 8 verification first)');
    closeDatabase();
    return;
  }

  logger.info(`Found ${products.length} authorized products to translate`);

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

        // NEW: Translate normalized variant structure
        await translateNormalizedVariants(prod.id);

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

/**
 * Translate normalized variant structure (dimensions and values).
 * Uses batch translation to minimize API calls.
 */
async function translateNormalizedVariants(productId: number): Promise<void> {
  const { translateBatchPublic } = await import('../services/translator');

  const variants = await getProductVariantsWithValues(productId);
  if (variants.length === 0) return;

  // Collect all texts that need translation into one batch
  const textsToTranslate: string[] = [];
  const textMap: Array<{ type: 'dimension' | 'value'; variantId: number; valueId?: number; zh: string }> = [];

  for (const variant of variants) {
    if (!variant.variantNameEn && variant.variantNameZh) {
      textsToTranslate.push(variant.variantNameZh);
      textMap.push({ type: 'dimension', variantId: variant.id!, zh: variant.variantNameZh });
    }
    for (const value of variant.values) {
      if (!value.valueNameEn && value.valueNameZh) {
        textsToTranslate.push(value.valueNameZh);
        textMap.push({ type: 'value', variantId: variant.id!, valueId: value.id!, zh: value.valueNameZh });
      }
    }
  }

  if (textsToTranslate.length === 0) return;

  // Single batch call instead of N individual calls
  const translated = await translateBatchPublic(textsToTranslate);

  // Apply translations
  for (let i = 0; i < textMap.length; i++) {
    const entry = textMap[i];
    const translatedText = translated[i] || entry.zh;

    try {
      if (entry.type === 'dimension') {
        await updateVariantNameTranslation(entry.variantId, translatedText);
        logger.info('Translated variant dimension', { productId, zh: entry.zh, en: translatedText });
      } else {
        const cleanValue = cleanVariantName(translatedText);
        await updateVariantValueTranslation(entry.valueId!, cleanValue);
        logger.info('Translated variant value', { productId, zh: entry.zh, en: cleanValue });
      }
    } catch (error) {
      logger.warn('Failed to save variant translation', {
        productId, type: entry.type, zh: entry.zh, error: (error as Error).message,
      });
    }
  }
}

main().catch((error) => {
  logger.error('Unhandled error', { error: error.message });
  process.exit(1);
});
