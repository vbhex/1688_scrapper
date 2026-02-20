/**
 * Task 5: Image Quality Filtering (New Strategy)
 * 
 * NEW STRATEGY: Instead of translating Chinese text, we filter out images with Chinese text
 * 
 * This task:
 * 1. Takes products with status 'images_checked' or 'translated'
 * 2. Uses Tesseract OCR to detect Chinese text in images
 * 3. Marks images with Chinese text as 'has_chinese_text = true'
 * 4. If too many images have Chinese text (>50%), marks product as 'images_skipped'
 * 5. Otherwise marks product as 'images_clean' for clean images ready for upload
 * 
 * Usage: node dist/tasks/task5-filter-images.js --limit 10 --max-chinese-ratio 0.5
 */

import path from 'path';
import fs from 'fs';
import axios from 'axios';
import {
  getProductsByStatusWithLimit,
  updateStatus,
  getImagesOk,
  updateImageChineseTextStatus,
} from '../database/repositories';
import { closeDatabase, getPool } from '../database/db';
import { createChildLogger } from '../utils/logger';
import { ensureDirectoryExists } from '../utils/helpers';
import { config } from '../config';
import { ProductStatus } from '../models/product';
import { ResultSetHeader } from 'mysql2/promise';

const logger = createChildLogger('task5-filter-images');

interface DetectionResult {
  imageId: number;
  hasChineseText: boolean;
  confidence: number;
  textRegions: Array<{
    text: string;
    boundingBox: { x: number; y: number; width: number; height: number };
  }>;
}

function parseArgs(): { 
  limit: number; 
  maxChineseRatio: number;
  forceRecheck: boolean;
} {
  const args = process.argv.slice(2);
  let limit = 10;
  let maxChineseRatio = 0.5; // Skip product if >50% images have Chinese text
  let forceRecheck = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--limit' || args[i] === '-l') && args[i + 1]) {
      limit = parseInt(args[++i]) || limit;
    }
    if ((args[i] === '--max-chinese-ratio' || args[i] === '-r') && args[i + 1]) {
      maxChineseRatio = parseFloat(args[++i]) || maxChineseRatio;
    }
    if (args[i] === '--force' || args[i] === '-f') {
      forceRecheck = true;
    }
  }

  return { limit, maxChineseRatio, forceRecheck };
}

/**
 * Detect Chinese text in image using Tesseract.js
 */
async function detectChineseText(imageUrl: string): Promise<{
  hasChineseText: boolean;
  confidence: number;
  textRegions: Array<{ text: string; boundingBox: any }>;
}> {
  try {
    // Download image
    const response = await axios.get(imageUrl, { 
      responseType: 'arraybuffer',
      timeout: 30000 
    });
    
    const imageBuffer = Buffer.from(response.data);
    
    // Use Tesseract.js for detection (not translation)
    const Tesseract = require('tesseract.js');
    
    // Use Chinese + English language pack
    const worker = await Tesseract.createWorker(['chi_sim', 'eng'], 1, {
      logger: m => logger.debug('Tesseract:', m),
    });

    // Detect text with positions
    const { data } = await worker.recognize(imageBuffer, {}, { blocks: true });
    await worker.terminate();

    const textRegions: Array<{ text: string; boundingBox: any }> = [];
    let totalConfidence = 0;
    let regionCount = 0;

    // Check for Chinese text in detected regions
    for (const block of (data.blocks || [])) {
      for (const para of (block.paragraphs || [])) {
        for (const line of (para.lines || [])) {
          for (const word of (line.words || [])) {
            if (!word.text) continue;
            
            // Check if text contains Chinese characters
            if (containsChinese(word.text)) {
              textRegions.push({
                text: word.text.trim(),
                boundingBox: word.bbox,
              });
              totalConfidence += word.confidence || 0;
              regionCount++;
            }
          }
        }
      }
    }

    const hasChineseText = textRegions.length > 0;
    const avgConfidence = regionCount > 0 ? totalConfidence / regionCount : 0;

    logger.info('Chinese text detection completed', {
      hasChineseText,
      regionCount: textRegions.length,
      avgConfidence: avgConfidence.toFixed(1),
    });

    return {
      hasChineseText,
      confidence: avgConfidence,
      textRegions,
    };

  } catch (error) {
    logger.error('Failed to detect Chinese text', { 
      imageUrl: imageUrl.substring(0, 60),
      error: (error as Error).message 
    });
    
    return {
      hasChineseText: false,
      confidence: 0,
      textRegions: [],
    };
  }
}

/**
 * Check if text contains Chinese characters
 */
function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text);
}

/**
 * Check if product has already been checked for Chinese text
 */
async function hasBeenChecked(productId: number): Promise<boolean> {
  const pool = await getPool();
  const [rows] = await pool.query<any[]>(
    'SELECT COUNT(*) as count FROM products_images WHERE product_id = ? AND has_chinese_text IS NOT NULL',
    [productId]
  );
  return rows[0].count > 0;
}

async function main(): Promise<void> {
  const { limit, maxChineseRatio, forceRecheck } = parseArgs();
  logger.info('Task 5: Image Quality Filtering', { 
    limit, 
    maxChineseRatio, 
    forceRecheck 
  });

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
    logger.info('No products to filter images for');
    closeDatabase();
    return;
  }

  logger.info(`Found ${allProducts.length} products to process`);

  let processed = 0;
  let cleanProducts = 0;    // Products with mostly clean images
  let skippedProducts = 0;  // Products with too much Chinese text
  let errorProducts = 0;    // Products with processing errors

  try {
    for (const prod of allProducts) {
      logger.info(`Processing ${processed + 1}/${allProducts.length}: ${prod.titleZh?.substring(0, 50) || prod.id1688}`);

      // Skip if already checked (unless force recheck)
      if (!forceRecheck && await hasBeenChecked(prod.id)) {
        logger.info('Product images already checked, skipping', { id: prod.id1688 });
        processed++;
        continue;
      }

      // Get all images for this product
      const images = await getImagesOk(prod.id, false);

      if (images.length === 0) {
        logger.warn('No images found for product', { id: prod.id1688 });
        errorProducts++;
        processed++;
        continue;
      }

      logger.info(`Found ${images.length} images to check`);

      let chineseTextImages = 0;
      let totalChecked = 0;
      let detectionErrors = 0;

      // Check each image for Chinese text
      for (const image of images) {
        try {
          logger.info(`Checking image ${totalChecked + 1}/${images.length}`, {
            url: image.imageUrl.substring(image.imageUrl.lastIndexOf('/') + 1),
          });

          const detection = await detectChineseText(image.imageUrl);
          
          // Update database with detection result
          await updateImageChineseTextStatus(
            image.rawImageId,
            detection.hasChineseText,
            detection.confidence
          );

          if (detection.hasChineseText) {
            chineseTextImages++;
            logger.info(`Found Chinese text in image (${detection.textRegions.length} regions)`, {
              confidence: detection.confidence.toFixed(1),
            });
          } else {
            logger.info('No Chinese text detected');
          }

          totalChecked++;
          
          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 500));

        } catch (error) {
          logger.error('Failed to check image', {
            imageUrl: image.imageUrl.substring(0, 60),
            error: (error as Error).message,
          });
          detectionErrors++;
        }
      }

      // Calculate ratio of images with Chinese text
      const chineseRatio = totalChecked > 0 ? chineseTextImages / totalChecked : 0;
      const hasTooMuchChineseText = chineseRatio > maxChineseRatio;

      logger.info(`Product image analysis complete`, {
        id: prod.id1688,
        totalImages: images.length,
        checkedImages: totalChecked,
        chineseTextImages,
        chineseRatio: (chineseRatio * 100).toFixed(1) + '%',
        detectionErrors,
        hasTooMuchChineseText,
      });

      // Update product status based on Chinese text ratio
      if (detectionErrors > totalChecked / 2) {
        // Too many errors, mark as failed
        await updateStatus(prod.id, 'images_error' as ProductStatus);
        errorProducts++;
        logger.warn('Too many detection errors, marking as failed', { id: prod.id1688 });
      } else if (hasTooMuchChineseText) {
        // Too much Chinese text, skip this product
        await updateStatus(prod.id, 'images_skipped' as ProductStatus);
        skippedProducts++;
        logger.info('Too many images with Chinese text, skipping product', { 
          id: prod.id1688,
          ratio: (chineseRatio * 100).toFixed(1) + '%',
        });
      } else {
        // Clean images, ready for upload
        await updateStatus(prod.id, 'images_clean' as ProductStatus);
        cleanProducts++;
        logger.info('Product has clean images, ready for upload', { id: prod.id1688 });
      }

      processed++;
    }

    logger.info('Task 5 complete', {
      processed,
      cleanProducts,
      skippedProducts,
      errorProducts,
    });
  } catch (error) {
    logger.error('Task 5 failed', { error: (error as Error).message });
  } finally {
    closeDatabase();
  }
}

main().catch((error) => {
  logger.error('Unhandled error', { error: error.message });
  process.exit(1);
});