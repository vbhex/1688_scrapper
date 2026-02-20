/**
 * Task 5: Image Translation
 * 
 * Translates Chinese text in product images to English using OCR + Translation + Image Overlay.
 * 
 * This task:
 * 1. Takes products with status 'images_checked' or 'translated'
 * 2. Gets images marked with has_chinese_text = true
 * 3. Uses OCR to extract Chinese text and positions
 * 4. Translates Chinese text to English
 * 5. Creates new images with English text overlaid
 * 6. Saves translated images to a designated folder
 * 7. Updates database with translated image paths
 * 
 * Provider auto-detection (same as other tasks):
 *   - GOOGLE_CLOUD_API_KEY → Google Vision API
 *   - Otherwise → Tesseract.js (local OCR)
 * 
 * Usage: node dist/tasks/task5-translate-images.js --limit 10
 */

import path from 'path';
import fs from 'fs';
import {
  translateProductImages,
  terminateImageTranslationWorker,
  ImageTranslationResult,
} from '../services/imageTranslator';
import {
  uploadTranslatedImage,
  isCOSConfigured,
} from '../services/cosUploader';
import {
  getProductsByStatusWithLimit,
  updateStatus,
  getImagesOk,
} from '../database/repositories';
import { closeDatabase, getPool } from '../database/db';
import { createChildLogger } from '../utils/logger';
import { ensureDirectoryExists } from '../utils/helpers';
import { config } from '../config';
import { ProductStatus } from '../models/product';
import { ResultSetHeader } from 'mysql2/promise';

const logger = createChildLogger('task5-translate-images');

interface TranslatedImage {
  productId: number;
  rawImageId: number;
  originalImageUrl: string;
  translatedImageUrl: string;
  cosKey: string;
  textRegionsCount: number;
  success: boolean;
}

function parseArgs(): { limit: number; forceRetranslate: boolean } {
  const args = process.argv.slice(2);
  let limit = 10;
  let forceRetranslate = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--limit' || args[i] === '-l') && args[i + 1]) {
      limit = parseInt(args[++i]) || limit;
    }
    if (args[i] === '--force' || args[i] === '-f') {
      forceRetranslate = true;
    }
  }

  return { limit, forceRetranslate };
}

/**
 * Save translated image metadata to database
 */
async function saveTranslatedImage(img: TranslatedImage): Promise<void> {
  const pool = await getPool();

  await pool.execute<ResultSetHeader>(
    `INSERT INTO products_images_translated
       (product_id, raw_image_id, original_image_url, translated_image_url, cos_key, text_regions_count, success)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE 
       translated_image_url = VALUES(translated_image_url),
       cos_key = VALUES(cos_key),
       text_regions_count = VALUES(text_regions_count),
       success = VALUES(success),
       translated_at = CURRENT_TIMESTAMP`,
    [
      img.productId,
      img.rawImageId,
      img.originalImageUrl,
      img.translatedImageUrl,
      img.cosKey,
      img.textRegionsCount,
      img.success ? 1 : 0,
    ]
  );
}

/**
 * Check if product images have already been translated
 */
async function hasTranslatedImages(productId: number): Promise<boolean> {
  const pool = await getPool();
  const [rows] = await pool.query<any[]>(
    'SELECT COUNT(*) as count FROM products_images_translated WHERE product_id = ? AND success = 1',
    [productId]
  );
  return rows[0].count > 0;
}

async function main(): Promise<void> {
  const { limit, forceRetranslate } = parseArgs();
  logger.info('Task 5: Image Translation', { limit, forceRetranslate });

  // Check if COS is configured
  if (!isCOSConfigured()) {
    logger.error('Tencent Cloud COS is not configured. Please set TENCENT_SECRET_ID, TENCENT_SECRET_KEY, COS_BUCKET_NAME, and COS_REGION in .env');
    closeDatabase();
    process.exit(1);
  }

  logger.info('COS is configured, images will be uploaded to Tencent Cloud');

  // Accept both 'images_checked' and 'translated' status
  const statuses: ProductStatus[] = ['images_checked', 'translated'];
  let allProducts: any[] = [];

  for (const status of statuses) {
    const products = await getProductsByStatusWithLimit(status, limit);
    allProducts = allProducts.concat(products);
  }

  // Remove duplicates and limit
  allProducts = Array.from(new Map(allProducts.map(p => [p.id, p])).values()).slice(0, limit);

  if (allProducts.length === 0) {
    logger.info('No products to translate images for');
    closeDatabase();
    return;
  }

  logger.info(`Found ${allProducts.length} products to process`);

  let processed = 0;
  let successCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  try {
    for (const prod of allProducts) {
      logger.info(`Processing ${processed + 1}/${allProducts.length}: ${prod.titleZh?.substring(0, 50) || prod.id1688}`);

      // Skip if already translated (unless force retranslate)
      if (!forceRetranslate && await hasTranslatedImages(prod.id)) {
        logger.info('Product images already translated, skipping', { id: prod.id1688 });
        skippedCount++;
        processed++;
        continue;
      }

      // Get all images for this product (including ones with Chinese text)
      const images = await getImagesOk(prod.id, false);

      if (images.length === 0) {
        logger.warn('No images found for product', { id: prod.id1688 });
        skippedCount++;
        processed++;
        continue;
      }

      // Filter to only images with Chinese text or watermarks that we want to translate
      const imagesToTranslate = images.filter(img => img.hasChineseText);

      if (imagesToTranslate.length === 0) {
        logger.info('No images with Chinese text found for product', { id: prod.id1688 });
        skippedCount++;
        processed++;
        continue;
      }

      logger.info(`Found ${imagesToTranslate.length} images with Chinese text to translate`);

      // Create output directory for this product (temporary)
      const outputDir = path.join(config.paths.tempImages, 'translated', prod.id1688);
      ensureDirectoryExists(outputDir);

      // Translate images
      const imageUrls = imagesToTranslate.map(img => img.imageUrl);
      const results = await translateProductImages(imageUrls, outputDir, prod.id1688);

      // Upload to COS and save results to database
      let productSuccess = true;
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const originalImage = imagesToTranslate[i];

        if (!result.success) {
          productSuccess = false;
          logger.error('Image translation failed', {
            id: prod.id1688,
            imageUrl: result.originalUrl.substring(0, 60),
            error: result.error,
          });
          
          await saveTranslatedImage({
            productId: prod.id,
            rawImageId: originalImage.rawImageId,
            originalImageUrl: result.originalUrl,
            translatedImageUrl: '',
            cosKey: '',
            textRegionsCount: result.textRegions.length,
            success: false,
          });
          continue;
        }

        // Upload translated image to COS
        try {
          logger.info(`Uploading image ${i + 1}/${results.length} to COS`, { id: prod.id1688 });
          
          const cosUrl = await uploadTranslatedImage(
            result.translatedImagePath,
            prod.id1688,
            i
          );

          const cosKey = `translated_images/${prod.id1688}/image_${i}${path.extname(result.translatedImagePath)}`;

          await saveTranslatedImage({
            productId: prod.id,
            rawImageId: originalImage.rawImageId,
            originalImageUrl: result.originalUrl,
            translatedImageUrl: cosUrl,
            cosKey: cosKey,
            textRegionsCount: result.textRegions.length,
            success: true,
          });

          logger.info('Image uploaded to COS successfully', {
            id: prod.id1688,
            url: cosUrl.substring(0, 80),
          });

          // Delete local file after successful upload
          try {
            fs.unlinkSync(result.translatedImagePath);
          } catch (err) {
            logger.warn('Failed to delete local temp file', {
              path: result.translatedImagePath,
              error: (err as Error).message,
            });
          }
        } catch (error) {
          productSuccess = false;
          logger.error('Failed to upload image to COS', {
            id: prod.id1688,
            error: (error as Error).message,
          });

          await saveTranslatedImage({
            productId: prod.id,
            rawImageId: originalImage.rawImageId,
            originalImageUrl: result.originalUrl,
            translatedImageUrl: '',
            cosKey: '',
            textRegionsCount: result.textRegions.length,
            success: false,
          });
        }
      }

      // Clean up temporary directory
      try {
        fs.rmdirSync(outputDir, { recursive: true });
      } catch (err) {
        logger.warn('Failed to clean up temp directory', {
          dir: outputDir,
          error: (err as Error).message,
        });
      }

      // Update product status to 'images_translated'
      if (productSuccess) {
        await updateStatus(prod.id, 'images_translated' as ProductStatus);
        successCount++;
        logger.info('Product images translated and uploaded successfully', {
          id: prod.id1688,
          translatedCount: results.length,
        });
      } else {
        failedCount++;
        logger.warn('Some images failed to translate or upload', { id: prod.id1688 });
      }

      processed++;
    }

    logger.info('Task 5 complete', {
      processed,
      successful: successCount,
      skipped: skippedCount,
      failed: failedCount,
    });
  } catch (error) {
    logger.error('Task 5 failed', { error: (error as Error).message });
  } finally {
    await terminateImageTranslationWorker();
    closeDatabase();
  }
}

main().catch((error) => {
  logger.error('Unhandled error', { error: error.message });
  process.exit(1);
});
