/**
 * Task 5: AliExpress Enrichment
 *
 * For each translated product, checks if its images contain Chinese text.
 * - NO Chinese text → Advance directly to 'ae_enriched' (images are usable as-is)
 * - HAS Chinese text → Search AliExpress for the same product:
 *     - Found → Store AE images + English info, advance to 'ae_enriched'
 *     - Not found → Skip the product (cannot list with Chinese images)
 *
 * Usage:
 *   node dist/tasks/task5-ae-enrich.js --limit 10
 */

import { RowDataPacket } from 'mysql2/promise';
import { getPool, closeDatabase } from '../database/db';
import { getProductsByStatusWithLimit, updateStatus } from '../database/repositories';
import { findMatchingAeProduct } from '../services/aeSearcher';
import { ProductStatus } from '../models/product';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('task5-ae-enrich');

function log(msg: string) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

/**
 * Check if a product has ANY gallery images with Chinese text.
 * Returns { hasChinese, totalGallery, chineseCount, cleanCount }
 */
async function checkProductImagesChinese(productId: number): Promise<{
  hasChinese: boolean;
  totalGallery: number;
  chineseCount: number;
  cleanCount: number;
}> {
  const pool = await getPool();
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT has_chinese_text, image_type
     FROM products_images_ok
     WHERE product_id = ? AND passed = 1 AND image_type = 'gallery'
     ORDER BY sort_order`,
    [productId]
  );

  const totalGallery = rows.length;
  const chineseCount = rows.filter(r => r.has_chinese_text).length;
  const cleanCount = totalGallery - chineseCount;

  return {
    hasChinese: chineseCount > 0,
    totalGallery,
    chineseCount,
    cleanCount,
  };
}

/**
 * Get the English title for a product from products_en.
 */
async function getEnglishTitle(productId: number): Promise<string | null> {
  const pool = await getPool();
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT title_en FROM products_en WHERE product_id = ?',
    [productId]
  );
  return rows.length > 0 ? rows[0].title_en : null;
}

/**
 * Store AE match data in products_ae_match.
 */
async function saveAeMatch(
  productId: number,
  hasChinese: boolean,
  aeProductId?: string,
  aeUrl?: string,
  aeTitle?: string,
  aeImages?: string[],
  aeDescription?: string,
  matchScore?: number,
): Promise<void> {
  const pool = await getPool();
  await pool.execute(
    `INSERT INTO products_ae_match
     (product_id, has_chinese_images, ae_product_id, ae_url, ae_title, ae_images, ae_description, match_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       has_chinese_images = VALUES(has_chinese_images),
       ae_product_id = VALUES(ae_product_id),
       ae_url = VALUES(ae_url),
       ae_title = VALUES(ae_title),
       ae_images = VALUES(ae_images),
       ae_description = VALUES(ae_description),
       match_score = VALUES(match_score),
       matched_at = CURRENT_TIMESTAMP`,
    [
      productId,
      hasChinese,
      aeProductId || null,
      aeUrl || null,
      aeTitle || null,
      aeImages ? JSON.stringify(aeImages) : null,
      aeDescription || null,
      matchScore || 0,
    ]
  );
}

async function main() {
  const args = process.argv.slice(2);
  let limit = 10;
  const limitIdx = args.indexOf('--limit');
  if (limitIdx >= 0 && args[limitIdx + 1]) {
    limit = parseInt(args[limitIdx + 1]) || limit;
  }

  log('=== Task 5: AliExpress Enrichment ===');

  // Get translated products ready for enrichment
  const products = await getProductsByStatusWithLimit('translated', limit);
  if (products.length === 0) {
    log('No translated products to process.');
    closeDatabase();
    return;
  }

  log(`Processing ${products.length} translated products...`);

  let enriched = 0;
  let skipped = 0;
  let directPass = 0;

  for (let i = 0; i < products.length; i++) {
    const prod = products[i];
    log(`\n[${i + 1}/${products.length}] ${prod.titleZh || prod.id1688}`);

    try {
      // Step 1: Check if images have Chinese text
      const imgCheck = await checkProductImagesChinese(prod.id);
      log(`  Images: ${imgCheck.totalGallery} gallery, ${imgCheck.chineseCount} with Chinese text`);

      if (!imgCheck.hasChinese) {
        // ─── CLEAN IMAGES: advance directly ───
        log(`  No Chinese text in images — passing directly`);
        await saveAeMatch(prod.id, false);
        await updateStatus(prod.id, 'ae_enriched' as ProductStatus);
        directPass++;
        continue;
      }

      // ─── HAS CHINESE TEXT: search AliExpress ───
      log(`  Chinese text detected in ${imgCheck.chineseCount}/${imgCheck.totalGallery} images — searching AliExpress...`);

      const englishTitle = await getEnglishTitle(prod.id);
      if (!englishTitle) {
        log(`  No English title found — skipping`);
        await updateStatus(prod.id, 'skipped' as ProductStatus, 'No English title for AE search');
        skipped++;
        continue;
      }

      log(`  Searching AE for: "${englishTitle.substring(0, 60)}..."`);
      const match = await findMatchingAeProduct(englishTitle);

      if (match.found && match.product) {
        // ─── FOUND ON AE: store match data ───
        log(`  MATCH FOUND (score ${match.matchScore}): ${match.product.title.substring(0, 60)}`);
        log(`  AE images: ${match.product.images.length}`);

        await saveAeMatch(
          prod.id,
          true,
          match.product.productId,
          match.product.url,
          match.product.title,
          match.product.images,
          match.product.description,
          match.matchScore,
        );
        await updateStatus(prod.id, 'ae_enriched' as ProductStatus);
        enriched++;
      } else if (imgCheck.cleanCount >= 3) {
        // ─── NO AE MATCH BUT ENOUGH CLEAN IMAGES: advance using clean 1688 images ───
        log(`  No AE match, but ${imgCheck.cleanCount} clean gallery images available — advancing with clean images`);
        await saveAeMatch(prod.id, false); // hasChinese=false → import uses clean images
        await updateStatus(prod.id, 'ae_enriched' as ProductStatus);
        directPass++;
      } else {
        // ─── NOT FOUND ON AE AND TOO FEW CLEAN IMAGES: skip ───
        log(`  No AE match, only ${imgCheck.cleanCount} clean images (need 3) — skipping`);
        await saveAeMatch(prod.id, true);
        await updateStatus(
          prod.id,
          'skipped' as ProductStatus,
          `Chinese images, no AE match (best score: ${match.matchScore})`,
        );
        skipped++;
      }

    } catch (error) {
      log(`  ERROR: ${(error as Error).message}`);
      logger.error('AE enrichment failed for product', {
        productId: prod.id,
        error: (error as Error).message,
      });
      skipped++;
    }
  }

  log(`\n========================================`);
  log(`AE Enrichment complete!`);
  log(`  Total: ${products.length}`);
  log(`  Direct pass (clean images): ${directPass}`);
  log(`  AE enriched: ${enriched}`);
  log(`  Skipped: ${skipped}`);
  log(`========================================`);

  closeDatabase();
}

main().catch(err => {
  console.error('Fatal error:', err);
  closeDatabase();
  process.exit(1);
});
