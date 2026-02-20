/**
 * Image Translator Service
 * 
 * Translates Chinese text in product images to English using:
 * 1. OCR to detect text and positions
 * 2. Translation API
 * 3. Image processing to overlay translated text (Sharp)
 * 
 * Provider auto-detection:
 *   - GOOGLE_CLOUD_API_KEY → Google Vision API (best OCR quality)
 *   - BAIDU_TRANSLATE_APPID + BAIDU_TRANSLATE_SECRET → Baidu Picture Translation API
 *   - Otherwise → Tesseract.js with preprocessing (good for basic text)
 * 
 * Translation uses existing translator service (Baidu or Google)
 */

import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createChildLogger } from '../utils/logger';
import { config } from '../config';
import { downloadImage, ensureDirectoryExists, sleep } from '../utils/helpers';
import { translateText } from './translator';

const FormData = require('form-data');

const logger = createChildLogger('imageTranslator');

// ─── Types ────────────────────────────────────────────────────────────────

export interface TextRegion {
  text: string;
  translatedText: string;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  vertices?: Array<{ x: number; y: number }>;
}

export interface ImageTranslationResult {
  originalUrl: string;
  translatedImagePath: string;
  textRegions: TextRegion[];
  success: boolean;
  error?: string;
}

// ─── Provider Detection ───────────────────────────────────────────────────

type OcrProvider = 'google' | 'baidu' | 'tesseract';

// Track if Baidu picture translation API works (it requires separate activation)
let baiduPicTranslationFailed = false;

function getOcrProvider(): OcrProvider {
  if (config.google.apiKey) return 'google';
  // Only use Baidu picture translation if credentials exist AND it hasn't persistently failed
  if (config.baidu.translateAppId && config.baidu.translateSecret && !baiduPicTranslationFailed) return 'baidu';
  return 'tesseract';
}

// ═══════════════════════════════════════════════════════════════════════════
// Google Vision API — Extract Text with Positions
// ═══════════════════════════════════════════════════════════════════════════

const VISION_API_URL = 'https://vision.googleapis.com/v1/images:annotate';

interface GoogleVisionVertex {
  x: number;
  y: number;
}

interface GoogleVisionTextAnnotation {
  description: string;
  boundingPoly?: {
    vertices: GoogleVisionVertex[];
  };
  locale?: string;
}

interface GoogleVisionResponse {
  responses: Array<{
    textAnnotations?: GoogleVisionTextAnnotation[];
    error?: { code: number; message: string };
  }>;
}

async function extractTextWithGoogleVision(imageBuffer: Buffer): Promise<TextRegion[]> {
  try {
    const base64Image = imageBuffer.toString('base64');
    
    const response = await axios.post<GoogleVisionResponse>(
      `${VISION_API_URL}?key=${config.google.apiKey}`,
      {
        requests: [{
          image: { content: base64Image },
          features: [{ type: 'TEXT_DETECTION', maxResults: 100 }],
        }],
      },
      { timeout: 30000 }
    );

    const result = response.data.responses[0];
    if (result.error) {
      logger.error('Google Vision API error', { error: result.error.message });
      return [];
    }

    const annotations = result.textAnnotations || [];
    if (annotations.length === 0) return [];

    // First annotation is the full text, rest are individual words/blocks
    // We skip the first one and process individual text blocks
    const textRegions: TextRegion[] = [];

    for (let i = 1; i < annotations.length; i++) {
      const ann = annotations[i];
      if (!ann.boundingPoly || !ann.boundingPoly.vertices) continue;

      const vertices = ann.boundingPoly.vertices;
      if (vertices.length < 3) continue;

      // Calculate bounding box
      const xs = vertices.map(v => v.x || 0);
      const ys = vertices.map(v => v.y || 0);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      const width = Math.max(...xs) - x;
      const height = Math.max(...ys) - y;

      // Only process if text contains Chinese characters
      if (containsChinese(ann.description)) {
        textRegions.push({
          text: ann.description,
          translatedText: '', // Will be filled later
          boundingBox: { x, y, width, height },
          vertices: vertices,
        });
      }
    }

    return textRegions;
  } catch (error) {
    logger.error('Google Vision text extraction failed', { error: (error as Error).message });
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Baidu Picture Translation API — Extract & Translate Text with Positions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Baidu Picture Translation API (图片翻译)
 * Doc: https://fanyi-api.baidu.com/doc/26
 * Uses the same credentials as text translation (BAIDU_TRANSLATE_APPID + BAIDU_TRANSLATE_SECRET)
 * 
 * Endpoint: https://fanyi-api.baidu.com/api/trans/vip/pictrans/v1
 */

const BAIDU_PIC_TRANSLATE_URL = 'https://fanyi-api.baidu.com/api/trans/vip/image';
const BAIDU_PIC_TRANSLATE_URL_ALT = 'https://fanyi-api.baidu.com/api/trans/vip/pictrans/v1';
const BAIDU_PIC_TRANSLATE_URL_ALT_HOST = 'https://api.fanyi.baidu.com/api/trans/vip/image';
const BAIDU_PIC_TRANSLATE_URL_ALT_HOST_2 = 'https://api.fanyi.baidu.com/api/trans/vip/pictrans/v1';

interface BaiduPicTranslateResponse {
  from?: string;
  to?: string;
  result_num?: number;
  result?: Array<{
    src: string;
    dst: string;
    rect?: {
      left: number;
      top: number;
      width: number;
      height: number;
    };
    loc?: {
      left: number;
      top: number;
      width: number;
      height: number;
    };
  }>;
  data?: Array<{
    src: string;
    dst: string;
    loc: {
      left: number;
      top: number;
      width: number;
      height: number;
    };
    angle?: number;
    cut_image?: string;
  }>;
  error_code?: string;
  error_msg?: string;
}

async function extractTextWithBaiduPictureTranslate(imageBuffer: Buffer): Promise<TextRegion[]> {
  try {
    const appid = config.baidu.translateAppId;
    const secret = config.baidu.translateSecret;

    const callBaiduPicApi = async (
      url: string,
      buffer: Buffer,
      mode: 'urlencoded' | 'multipartBinary' | 'multipartBase64' = 'urlencoded'
    ): Promise<BaiduPicTranslateResponse> => {
      const base64Image = buffer.toString('base64');
      const salt = Date.now().toString();
      const from = 'auto';
      const to = 'en';

      // Sign: MD5(appid + image + salt + secret)
      const sign = crypto.createHash('md5')
        .update(appid + base64Image + salt + secret)
        .digest('hex');

      logger.debug('Baidu picture translate payload sizes', {
        bufferSize: buffer.length,
        base64Length: base64Image.length,
        mode,
        url,
      });

      if (mode === 'multipartBinary') {
        const form = new FormData();
        form.append('appid', appid);
        form.append('image', buffer, {
          filename: 'image.jpg',
          contentType: 'image/jpeg',
        });
        form.append('from', from);
        form.append('to', to);
        form.append('salt', salt);
        form.append('sign', sign);

        const response = await axios.post<BaiduPicTranslateResponse>(
          url,
          form,
          {
            headers: form.getHeaders(),
            timeout: 30000,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
          }
        );

        return response.data;
      }

      if (mode === 'multipartBase64') {
        const form = new FormData();
        form.append('appid', appid);
        form.append('image', base64Image);
        form.append('from', from);
        form.append('to', to);
        form.append('salt', salt);
        form.append('sign', sign);

        const response = await axios.post<BaiduPicTranslateResponse>(
          url,
          form,
          {
            headers: form.getHeaders(),
            timeout: 30000,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
          }
        );

        return response.data;
      }

      const params = new URLSearchParams();
      params.append('appid', appid);
      params.append('image', base64Image);
      params.append('from', from);
      params.append('to', to);
      params.append('salt', salt);
      params.append('sign', sign);

      const response = await axios.post<BaiduPicTranslateResponse>(
        url,
        params.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 30000,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        }
      );

      return response.data;
    };

    const callBaiduPictransApi = async (url: string, buffer: Buffer): Promise<BaiduPicTranslateResponse> => {
      const base64Image = buffer.toString('base64');
      const salt = Date.now().toString();
      const from = 'auto';
      const to = 'en';
      const cuid = 'APICUID';
      const mac = 'mac';
      const version = '3';
      const paste = '1';

      // pictrans signature: appid+image+salt+cuid+mac+version+paste+from+to+secret
      const sign = crypto.createHash('md5')
        .update(appid + base64Image + salt + cuid + mac + version + paste + from + to + secret)
        .digest('hex');

      const params = new URLSearchParams();
      params.append('appid', appid);
      params.append('image', base64Image);
      params.append('from', from);
      params.append('to', to);
      params.append('salt', salt);
      params.append('cuid', cuid);
      params.append('mac', mac);
      params.append('version', version);
      params.append('paste', paste);
      params.append('sign', sign);

      const response = await axios.post<BaiduPicTranslateResponse>(
        url,
        params.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 30000,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        }
      );

      return response.data;
    };

    let workingBuffer = imageBuffer;

    // Light compression if image is large
    if (workingBuffer.length > 1_900_000) {
      try {
        const sharp = require('sharp');
        workingBuffer = await sharp(workingBuffer)
          .jpeg({ quality: 80 })
          .toBuffer();
        logger.info('Compressed image for Baidu Picture Translation', {
          originalSize: imageBuffer.length,
          compressedSize: workingBuffer.length,
        });
      } catch (err) {
        logger.warn('Failed to compress image for Baidu Picture Translation', {
          error: (err as Error).message,
        });
      }
    }

    // Try primary endpoint (urlencoded)
    let data = await callBaiduPicApi(BAIDU_PIC_TRANSLATE_URL, workingBuffer, 'urlencoded');

    // If image size error, retry with smaller image
    if (data.error_code === '517') {
      logger.warn('Baidu Picture Translation returned 517, retrying with smaller image');
      try {
        const sharp = require('sharp');
        workingBuffer = await sharp(workingBuffer)
          .resize({ width: 800, height: 800, fit: 'inside' })
          .jpeg({ quality: 70 })
          .toBuffer();
        data = await callBaiduPicApi(BAIDU_PIC_TRANSLATE_URL, workingBuffer, 'urlencoded');
      } catch (err) {
        logger.warn('Failed to resize image', { error: (err as Error).message });
      }
    }

    // If still failing with 517, the API is likely not activated for this account
    if (data.error_code === '517') {
      logger.warn('Baidu Picture Translation API not available (error 517 persists). Falling back to Tesseract.js for OCR.');
      baiduPicTranslationFailed = true;
      // Fall back to Tesseract immediately for this image
      return await extractTextWithTesseract(imageBuffer);
    }

    if (data.error_code) {
      logger.error('Baidu Picture Translation API error', {
        code: data.error_code,
        msg: data.error_msg,
      });
      return [];
    }

    const resultItems = data.result || data.data || [];
    if (resultItems.length === 0) {
      logger.info('Baidu Picture Translation returned no text');
      return [];
    }

    const textRegions: TextRegion[] = [];

    for (const item of resultItems) {
      if (!containsChinese(item.src)) continue;

      const rect = (item as any).rect || (item as any).loc;
      if (!rect) continue;

      textRegions.push({
        text: item.src,
        translatedText: item.dst,
        boundingBox: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        },
      });
    }

    logger.info(`Baidu Picture Translation detected ${textRegions.length} Chinese text regions`);
    return textRegions;
  } catch (error) {
    logger.error('Baidu Picture Translation failed', {
      error: (error as Error).message,
      response: axios.isAxiosError(error) ? error.response?.data : undefined,
    });
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tesseract.js — Extract Text with Positions
// ═══════════════════════════════════════════════════════════════════════════

let tesseractWorker: any = null;

async function getTesseractWorker(): Promise<any> {
  if (tesseractWorker) return tesseractWorker;

  const Tesseract = require('tesseract.js');
  const projectRoot = path.resolve(__dirname, '..', '..');

  // Check multiple possible locations for trained data files
  const possiblePaths = [
    path.join(projectRoot, 'tessdata'),             // tessdata/ in repo root
    projectRoot,                                    // repo root directly
    path.join(projectRoot, 'data', 'tessdata'),     // data/tessdata/
  ];

  let tessDataPath: string | null = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(path.join(p, 'chi_sim.traineddata'))) {
      tessDataPath = p;
      break;
    }
  }

  if (tessDataPath) {
    logger.info('Using local Tesseract trained data', { path: tessDataPath });
    tesseractWorker = await Tesseract.createWorker(['chi_sim', 'eng'], 1, {
      langPath: tessDataPath,
      gzip: false,
    });
  } else {
    logger.info('No local Tesseract data found, will download from CDN');
    tesseractWorker = await Tesseract.createWorker(['chi_sim', 'eng'], 1);
  }

  logger.info('Tesseract.js worker initialized for image translation');
  return tesseractWorker;
}

/**
 * Preprocess image to improve OCR accuracy
 * Try multiple preprocessing strategies
 */
async function preprocessImageForOCR(imageBuffer: Buffer, strategy: 'grayscale' | 'contrast' | 'original' = 'grayscale'): Promise<Buffer> {
  try {
    const sharp = require('sharp');
    
    if (strategy === 'original') {
      return imageBuffer;
    }
    
    if (strategy === 'grayscale') {
      // Gentle processing: grayscale + normalize only
      return await sharp(imageBuffer)
        .grayscale()
        .normalize()
        .toBuffer();
    }
    
    if (strategy === 'contrast') {
      // Aggressive: high contrast for better text detection
      return await sharp(imageBuffer)
        .grayscale()
        .normalize()
        .modulate({ brightness: 1.2, contrast: 1.5 })
        .sharpen()
        .toBuffer();
    }
    
    return imageBuffer;
  } catch (error) {
    logger.warn('Image preprocessing failed, using original', { error: (error as Error).message });
    return imageBuffer;
  }
}

async function extractTextWithTesseract(imageBuffer: Buffer): Promise<TextRegion[]> {
  try {
    const worker = await getTesseractWorker();
    
    // Try multiple preprocessing strategies
    const strategies: Array<'original' | 'grayscale' | 'contrast'> = ['original', 'grayscale', 'contrast'];
    let bestResult: TextRegion[] = [];
    
    for (const strategy of strategies) {
      logger.debug(`Trying Tesseract with '${strategy}' preprocessing`);
      const preprocessed = await preprocessImageForOCR(imageBuffer, strategy);
      
      // Use better OCR parameters for Chinese text
      const { data } = await worker.recognize(preprocessed, {
        rotateAuto: true,
      });

      const textRegions: TextRegion[] = [];

      // Process lines instead of words for better Chinese text detection
      for (const line of data.lines || []) {
        if (!line.text || !containsChinese(line.text)) continue;
        if (line.confidence < 30) continue; // Skip low confidence

        const bbox = line.bbox;
        textRegions.push({
          text: line.text,
          translatedText: '',
          boundingBox: {
            x: bbox.x0,
            y: bbox.y0,
            width: bbox.x1 - bbox.x0,
            height: bbox.y1 - bbox.y0,
          },
        });
      }

      logger.debug(`Tesseract '${strategy}' detected ${textRegions.length} regions`);
      
      // Keep best result (most text detected)
      if (textRegions.length > bestResult.length) {
        bestResult = textRegions;
      }
      
      // If we got good results, stop trying
      if (textRegions.length >= 5) {
        break;
      }
    }

    logger.info(`Tesseract final result: ${bestResult.length} Chinese text regions`);
    return bestResult;
  } catch (error) {
    logger.error('Tesseract text extraction failed', { error: (error as Error).message });
    return [];
  }
}

export async function terminateImageTranslationWorker(): Promise<void> {
  if (tesseractWorker) {
    await tesseractWorker.terminate();
    tesseractWorker = null;
    logger.info('Tesseract image translation worker terminated');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Text Translation
// ═══════════════════════════════════════════════════════════════════════════

function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text);
}

async function translateTextRegions(regions: TextRegion[]): Promise<TextRegion[]> {
  const translated: TextRegion[] = [];

  for (const region of regions) {
    try {
      const translatedText = await translateText(region.text);
      translated.push({
        ...region,
        translatedText: translatedText || region.text,
      });
      await sleep(100); // Rate limiting
    } catch (error) {
      logger.error('Translation failed for text region', { text: region.text, error: (error as Error).message });
      translated.push({
        ...region,
        translatedText: region.text, // Fallback to original
      });
    }
  }

  return translated;
}

// ═══════════════════════════════════════════════════════════════════════════
// Image Processing — Overlay Translated Text
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates a new image with translated text overlaid.
 * 
 * This is a placeholder implementation that uses Node.js Canvas or Sharp.
 * For production, you may want to use:
 * - Sharp library (fast, C++ based)
 * - node-canvas (more flexible, similar to HTML5 Canvas API)
 * - External service like Cloudinary or ImageMagick
 */
async function overlayTranslatedText(
  imageBuffer: Buffer,
  textRegions: TextRegion[],
  outputPath: string
): Promise<boolean> {
  try {
    // Check if Sharp is available
    let sharp: any;
    try {
      sharp = require('sharp');
    } catch {
      logger.warn('Sharp not installed, saving image without text overlay');
      fs.writeFileSync(outputPath, imageBuffer);
      return true;
    }

    // Load the image
    const image = sharp(imageBuffer);
    const metadata = await image.metadata();

    if (!metadata.width || !metadata.height) {
      logger.error('Could not read image dimensions');
      return false;
    }

    // Create SVG overlay with white rectangles and text
    const svgOverlays: string[] = [];

    for (const region of textRegions) {
      const { x, y, width, height } = region.boundingBox;
      
      // Create a white rectangle to cover original text
      svgOverlays.push(
        `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="white" />`
      );

      // Calculate font size based on bounding box height
      const fontSize = Math.max(10, Math.min(height * 0.7, 50));

      // Add translated text (simple positioning)
      // Note: This is a basic implementation. For better results, you'd want to:
      // - Match font style
      // - Handle text wrapping
      // - Better positioning
      svgOverlays.push(
        `<text x="${x + 2}" y="${y + height * 0.75}" font-size="${fontSize}" fill="black" font-family="Arial, sans-serif">${escapeXml(region.translatedText)}</text>`
      );
    }

    const svgOverlay = `
      <svg width="${metadata.width}" height="${metadata.height}">
        ${svgOverlays.join('\n')}
      </svg>
    `;

    // Composite the SVG overlay onto the image
    await image
      .composite([{
        input: Buffer.from(svgOverlay),
        top: 0,
        left: 0,
      }])
      .toFile(outputPath);

    logger.debug('Image with translated text overlay created', { outputPath });
    return true;
  } catch (error) {
    logger.error('Failed to overlay translated text', { error: (error as Error).message });
    
    // Fallback: save original image
    try {
      fs.writeFileSync(outputPath, imageBuffer);
      return true;
    } catch {
      return false;
    }
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Translates Chinese text in an image to English
 * 
 * @param imageUrl - URL of the image to translate
 * @param outputPath - Local path where translated image will be saved
 * @returns Translation result with text regions and success status
 */
export async function translateImageFromUrl(
  imageUrl: string,
  outputPath: string
): Promise<ImageTranslationResult> {
  try {
    logger.info('Downloading image for translation', { url: imageUrl.substring(0, 60) });

    // Download image
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
    });
    const imageBuffer = Buffer.from(response.data);

    return await translateImageFromBuffer(imageBuffer, outputPath, imageUrl);
  } catch (error) {
    logger.error('Failed to download image', { url: imageUrl.substring(0, 60), error: (error as Error).message });
    return {
      originalUrl: imageUrl,
      translatedImagePath: outputPath,
      textRegions: [],
      success: false,
      error: (error as Error).message,
    };
  }
}

/**
 * Translates Chinese text in an image buffer to English
 */
export async function translateImageFromBuffer(
  imageBuffer: Buffer,
  outputPath: string,
  originalUrl: string = ''
): Promise<ImageTranslationResult> {
  try {
    const provider = getOcrProvider();
    logger.info('Extracting text from image', { provider, size: imageBuffer.length });

    // Step 1: Extract text with positions
    let textRegions: TextRegion[] = [];
    if (provider === 'google') {
      textRegions = await extractTextWithGoogleVision(imageBuffer);
    } else if (provider === 'baidu') {
      textRegions = await extractTextWithBaiduPictureTranslate(imageBuffer);
    } else {
      textRegions = await extractTextWithTesseract(imageBuffer);
    }

    if (textRegions.length === 0) {
      logger.info('No Chinese text found in image, saving original');
      ensureDirectoryExists(path.dirname(outputPath));
      fs.writeFileSync(outputPath, imageBuffer);
      return {
        originalUrl,
        translatedImagePath: outputPath,
        textRegions: [],
        success: true,
      };
    }

    logger.info(`Found ${textRegions.length} Chinese text regions in image`);

    // Step 2: Translate text (Baidu picture API returns pre-translated text; others need translation)
    const needsTranslation = textRegions.some(r => !r.translatedText);
    const translatedRegions = needsTranslation
      ? await translateTextRegions(textRegions)
      : textRegions;

    // Step 3: Overlay translated text
    ensureDirectoryExists(path.dirname(outputPath));
    const success = await overlayTranslatedText(imageBuffer, translatedRegions, outputPath);

    return {
      originalUrl,
      translatedImagePath: outputPath,
      textRegions: translatedRegions,
      success,
    };
  } catch (error) {
    logger.error('Image translation failed', { error: (error as Error).message });
    return {
      originalUrl,
      translatedImagePath: outputPath,
      textRegions: [],
      success: false,
      error: (error as Error).message,
    };
  }
}

/**
 * Batch translate multiple product images
 */
export async function translateProductImages(
  imageUrls: string[],
  outputDir: string,
  productId: string
): Promise<ImageTranslationResult[]> {
  if (imageUrls.length === 0) return [];

  logger.info('Translating product images', {
    count: imageUrls.length,
    productId,
    provider: getOcrProvider(),
  });

  ensureDirectoryExists(outputDir);

  const results: ImageTranslationResult[] = [];

  for (let i = 0; i < imageUrls.length; i++) {
    const imageUrl = imageUrls[i];
    const outputPath = path.join(outputDir, `translated_${i}.jpg`);

    const result = await translateImageFromUrl(imageUrl, outputPath);
    results.push(result);

    logger.info(`Translated image ${i + 1}/${imageUrls.length}`, {
      success: result.success,
      textRegions: result.textRegions.length,
    });

    await sleep(500); // Rate limiting
  }

  const successCount = results.filter(r => r.success).length;
  logger.info('Product image translation complete', {
    total: imageUrls.length,
    successful: successCount,
    failed: imageUrls.length - successCount,
  });

  return results;
}
