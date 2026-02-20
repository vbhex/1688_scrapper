/**
 * Tencent Cloud COS (Cloud Object Storage) Uploader
 * 
 * Uploads translated images to COS and returns public URLs.
 * Images are stored permanently on COS, local temp files are deleted after upload.
 */

// @ts-ignore - COS SDK doesn't have official TypeScript types
import COS from 'cos-nodejs-sdk-v5';
import fs from 'fs';
import path from 'path';
import { createChildLogger } from '../utils/logger';
import { config } from '../config';

const logger = createChildLogger('cosUploader');

let cosClient: any = null;

/**
 * Initialize COS client (lazy initialization)
 */
function getCOSClient(): any {
  if (cosClient) return cosClient;

  if (!config.tencent.secretId || !config.tencent.secretKey) {
    throw new Error('Tencent Cloud credentials not configured. Set TENCENT_SECRET_ID and TENCENT_SECRET_KEY in .env');
  }

  if (!config.tencent.cos.bucketName || !config.tencent.cos.region) {
    throw new Error('COS configuration missing. Set COS_BUCKET_NAME and COS_REGION in .env');
  }

  cosClient = new COS({
    SecretId: config.tencent.secretId,
    SecretKey: config.tencent.secretKey,
  });

  logger.info('COS client initialized', {
    bucket: config.tencent.cos.bucketName,
    region: config.tencent.cos.region,
  });

  return cosClient;
}

/**
 * Upload a file to COS
 * 
 * @param localFilePath - Local file path to upload
 * @param cosKey - COS object key (path in bucket), e.g., "products/123456/image_0.jpg"
 * @returns Public URL of the uploaded file
 */
export async function uploadFileToCOS(
  localFilePath: string,
  cosKey: string
): Promise<string> {
  const cos = getCOSClient();
  const bucket = config.tencent.cos.bucketName;
  const region = config.tencent.cos.region;

  return new Promise((resolve, reject) => {
    cos.putObject(
      {
        Bucket: bucket,
        Region: region,
        Key: cosKey,
        Body: fs.createReadStream(localFilePath),
        ContentType: getContentType(localFilePath),
      },
      (err, data) => {
        if (err) {
          logger.error('COS upload failed', {
            cosKey,
            error: err.message,
          });
          reject(err);
          return;
        }

        // Construct public URL
        // Format: https://{bucket}.cos.{region}.myqcloud.com/{key}
        const publicUrl = `https://${bucket}.cos.${region}.myqcloud.com/${cosKey}`;

        logger.debug('File uploaded to COS', {
          cosKey,
          url: publicUrl,
          etag: data.ETag,
        });

        resolve(publicUrl);
      }
    );
  });
}

/**
 * Upload multiple files to COS
 * 
 * @param files - Array of { localPath, cosKey }
 * @returns Array of { cosKey, url, success, error? }
 */
export async function uploadMultipleFilesToCOS(
  files: Array<{ localPath: string; cosKey: string }>
): Promise<Array<{ cosKey: string; url: string; success: boolean; error?: string }>> {
  const results: Array<{ cosKey: string; url: string; success: boolean; error?: string }> = [];

  for (const file of files) {
    try {
      const url = await uploadFileToCOS(file.localPath, file.cosKey);
      results.push({
        cosKey: file.cosKey,
        url,
        success: true,
      });
    } catch (error) {
      results.push({
        cosKey: file.cosKey,
        url: '',
        success: false,
        error: (error as Error).message,
      });
    }
  }

  return results;
}

/**
 * Upload translated image to COS
 * Automatically generates COS key based on product ID and image index
 * 
 * @param localFilePath - Local translated image path
 * @param productId1688 - 1688 product ID
 * @param imageIndex - Image index (0, 1, 2, ...)
 * @returns Public COS URL
 */
export async function uploadTranslatedImage(
  localFilePath: string,
  productId1688: string,
  imageIndex: number
): Promise<string> {
  // Generate COS key: translated_images/{product_id}/image_{index}.jpg
  const ext = path.extname(localFilePath) || '.jpg';
  const cosKey = `translated_images/${productId1688}/image_${imageIndex}${ext}`;

  return uploadFileToCOS(localFilePath, cosKey);
}

/**
 * Delete a file from COS (cleanup if needed)
 */
export async function deleteFileFromCOS(cosKey: string): Promise<boolean> {
  const cos = getCOSClient();
  const bucket = config.tencent.cos.bucketName;
  const region = config.tencent.cos.region;

  return new Promise((resolve) => {
    cos.deleteObject(
      {
        Bucket: bucket,
        Region: region,
        Key: cosKey,
      },
      (err) => {
        if (err) {
          logger.error('COS delete failed', { cosKey, error: err.message });
          resolve(false);
          return;
        }
        logger.debug('File deleted from COS', { cosKey });
        resolve(true);
      }
    );
  });
}

/**
 * Get content type based on file extension
 */
function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
  };
  return contentTypes[ext] || 'application/octet-stream';
}

/**
 * Check if COS is configured
 */
export function isCOSConfigured(): boolean {
  return !!(
    config.tencent.secretId &&
    config.tencent.secretKey &&
    config.tencent.cos.bucketName &&
    config.tencent.cos.region
  );
}
