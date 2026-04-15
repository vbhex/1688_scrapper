/**
 * Task 3: Image Processing
 * Analyzes images for Chinese text and watermarks using OCR.
 * Products with >= 3 passing gallery images advance; others are skipped.
 *
 * Provider auto-detection:
 *   - GOOGLE_CLOUD_API_KEY set → Google Vision API
 *   - Otherwise → Tesseract.js (local OCR, no API needed)
 *
 * Images are analyzed via URL-based download.
 *
 * Usage: node dist/tasks/task3-image-check.js --limit 10
 */

import { analyzeImageFromUrl, terminateOcrWorker } from '../services/imageAnalyzer';
import {
  getProductsByStatusWithLimit,
  updateStatus,
  getImagesRaw,
  insertImageOk,
  countPassedGalleryImages,
} from '../database/repositories';
import { closeDatabase } from '../database/db';
import { createChildLogger } from '../utils/logger';
import { sleep } from '../utils/helpers';

const logger = createChildLogger('task3-images');

const MIN_PASSING_GALLERY_IMAGES = 3;

function parseArgs(): { limit: number; category?: string } {
  const args = process.argv.slice(2);
  let limit = 0; // 0 = unlimited, process all available
  let category: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--limit' || args[i] === '-l') && args[i + 1]) {
      limit = parseInt(args[++i]) || limit;
    } else if ((args[i] === '--category' || args[i] === '-c') && args[i + 1]) {
      category = args[++i];
    }
  }
  return { limit, category };
}

async function main(): Promise<void> {
  const { limit, category } = parseArgs();
  logger.info('Task 3: Image Checking', { limit, ...(category && { category }) });

  const products = await getProductsByStatusWithLimit('detail_scraped', limit, category);
  if (products.length === 0) {
    logger.info('No products to check images for');
    closeDatabase();
    return;
  }

  logger.info(`Found ${products.length} products to check images`);

  let checked = 0;
  let passed = 0;
  let skippedCount = 0;

  try {
    for (const prod of products) {
      logger.info(`Checking ${checked + 1}/${products.length}: ${prod.titleZh?.substring(0, 50) ?? prod.id1688}`);

      const rawImages = await getImagesRaw(prod.id);
      if (rawImages.length === 0) {
        logger.warn('No images found for product', { id: prod.id1688 });
        await updateStatus(prod.id, 'skipped', 'No images');
        skippedCount++;
        checked++;
        continue;
      }

      // Analyze each image via URL
      for (const rawImg of rawImages) {
        const result = await analyzeImageFromUrl(rawImg.imageUrl);

        await insertImageOk({
          productId: prod.id,
          rawImageId: rawImg.id,
          imageUrl: rawImg.imageUrl,
          imageType: rawImg.imageType,
          sortOrder: rawImg.sortOrder,
          variantValue: rawImg.variantValue,
          hasChineseText: result.hasChineseText,
          hasWatermark: result.hasWatermark,
          passed: result.passed,
        });

        await sleep(200); // Rate limit API calls
      }

      // Check if enough gallery images passed
      const passedGalleryCount = await countPassedGalleryImages(prod.id);

      if (passedGalleryCount >= MIN_PASSING_GALLERY_IMAGES) {
        await updateStatus(prod.id, 'images_checked');
        passed++;
        logger.info('Product passed image check', {
          id: prod.id1688,
          passedGallery: passedGalleryCount,
          totalImages: rawImages.length,
        });
      } else {
        await updateStatus(prod.id, 'skipped', `Only ${passedGalleryCount} gallery images passed (need ${MIN_PASSING_GALLERY_IMAGES})`);
        skippedCount++;
        logger.info('Product failed image check — not enough clean images', {
          id: prod.id1688,
          passedGallery: passedGalleryCount,
        });
      }

      checked++;
      await sleep(500); // Rate limit between products
    }

    logger.info('Task 3 complete', { checked, passed, skipped: skippedCount });
  } catch (error) {
    logger.error('Task 3 failed', { error: (error as Error).message });
  } finally {
    await terminateOcrWorker();
    closeDatabase();
  }
}

main().catch((error) => {
  logger.error('Unhandled error', { error: error.message });
  process.exit(1);
});
