import axios from 'axios';
import path from 'path';
import fs from 'fs';
import { createChildLogger } from '../utils/logger';
import { config } from '../config';
import { ImageAnalysisResult } from '../models/product';
import { downloadImage, ensureDirectoryExists, cleanupTempFiles, sleep } from '../utils/helpers';

const logger = createChildLogger('imageAnalyzer');

// ─── Provider detection ───────────────────────────────────────────────

type OcrProvider = 'google' | 'tesseract';

function getOcrProvider(): OcrProvider {
  if (config.google.apiKey) return 'google';
  return 'tesseract';
}

// ─── Shared text analysis ─────────────────────────────────────────────

// Chinese character ranges
const CHINESE_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\u{f900}-\u{faff}\u{2f800}-\u{2fa1f}]/u;

// Common watermark patterns
const WATERMARK_PATTERNS = [
  /1688/i,
  /taobao/i,
  /tmall/i,
  /alibaba/i,
  /淘宝/,
  /天猫/,
  /阿里/,
  /厂家/,
  /直销/,
  /批发/,
  /工厂/,
  /www\./i,
  /\.com/i,
  /\.cn/i,
  /©/,
  /®/,
  /™/,
];

function containsChineseText(text: string): boolean {
  return CHINESE_REGEX.test(text);
}

function containsWatermark(text: string): boolean {
  return WATERMARK_PATTERNS.some(pattern => pattern.test(text));
}

function buildResult(imageUrl: string, detectedText: string[]): ImageAnalysisResult {
  const fullText = detectedText.join(' ');
  const hasChineseText = containsChineseText(fullText);
  const hasWatermark = containsWatermark(fullText);

  return {
    imageUrl,
    hasChineseText,
    hasWatermark,
    detectedText,
    passed: !hasWatermark,
  };
}

function passOnError(imageUrl: string): ImageAnalysisResult {
  return { imageUrl, hasChineseText: false, hasWatermark: false, detectedText: [], passed: true };
}

// ═══════════════════════════════════════════════════════════════════════
// Google Vision API
// ═══════════════════════════════════════════════════════════════════════

const VISION_API_URL = 'https://vision.googleapis.com/v1/images:annotate';

interface VisionResponse {
  responses: Array<{
    textAnnotations?: Array<{ description: string; locale?: string }>;
    error?: { code: number; message: string };
  }>;
}

async function googleAnalyzeBase64(base64Data: string, imageUrl: string): Promise<ImageAnalysisResult> {
  try {
    const response = await axios.post<VisionResponse>(
      `${VISION_API_URL}?key=${config.google.apiKey}`,
      {
        requests: [{
          image: { content: base64Data },
          features: [{ type: 'TEXT_DETECTION', maxResults: 50 }],
        }],
      },
      { timeout: 30000 }
    );

    const result = response.data.responses[0];
    if (result.error) {
      logger.error('Vision API error', { imageUrl: imageUrl.substring(0, 60), error: result.error.message });
      return passOnError(imageUrl);
    }

    const detectedText = (result.textAnnotations || [])
      .map(a => a.description)
      .filter(t => t && t.length > 0);

    return buildResult(imageUrl, detectedText);
  } catch (error) {
    logger.error('Google Vision analysis failed', { imageUrl: imageUrl.substring(0, 60), error: (error as Error).message });
    return passOnError(imageUrl);
  }
}

async function googleAnalyzeUrl(imageUrl: string): Promise<ImageAnalysisResult> {
  try {
    const response = await axios.post<VisionResponse>(
      `${VISION_API_URL}?key=${config.google.apiKey}`,
      {
        requests: [{
          image: { source: { imageUri: imageUrl } },
          features: [{ type: 'TEXT_DETECTION', maxResults: 50 }],
        }],
      },
      { timeout: 30000 }
    );

    const result = response.data.responses[0];
    if (result.error) {
      logger.error('Vision API error', { imageUrl: imageUrl.substring(0, 60), error: result.error.message });
      return passOnError(imageUrl);
    }

    const detectedText = (result.textAnnotations || [])
      .map(a => a.description)
      .filter(t => t && t.length > 0);

    return buildResult(imageUrl, detectedText);
  } catch (error) {
    logger.error('Google Vision URL analysis failed', { imageUrl: imageUrl.substring(0, 60), error: (error as Error).message });
    return passOnError(imageUrl);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Tesseract.js (local OCR — no API needed)
// ═══════════════════════════════════════════════════════════════════════

let tesseractWorker: any = null;

async function getTesseractWorker(): Promise<any> {
  if (tesseractWorker) return tesseractWorker;

  const Tesseract = require('tesseract.js');
  const projectRoot = path.resolve(__dirname, '..', '..');
  const localTessdata = path.join(projectRoot, 'data', 'tessdata');
  const useLocal = fs.existsSync(path.join(localTessdata, 'chi_sim.traineddata'));

  if (useLocal) {
    tesseractWorker = await Tesseract.createWorker(['chi_sim', 'eng'], 1, {
      langPath: localTessdata,
      gzip: false,
    });
  } else {
    tesseractWorker = await Tesseract.createWorker(['chi_sim', 'eng'], 1);
  }

  logger.info('Tesseract.js worker initialized (chi_sim+eng)', { localTessdata: useLocal });
  return tesseractWorker;
}

async function tesseractAnalyzeBuffer(imageBuffer: Buffer, imageUrl: string): Promise<ImageAnalysisResult> {
  try {
    const worker = await getTesseractWorker();
    const { data } = await worker.recognize(imageBuffer);

    const detectedText = data.text
      .split('\n')
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0);

    const result = buildResult(imageUrl, detectedText);

    logger.debug('Tesseract analysis', {
      imageUrl: imageUrl.substring(0, 50),
      hasChineseText: result.hasChineseText,
      hasWatermark: result.hasWatermark,
      passed: result.passed,
      textLength: data.text.length,
    });

    return result;
  } catch (error) {
    logger.error('Tesseract analysis failed', { imageUrl: imageUrl.substring(0, 60), error: (error as Error).message });
    return passOnError(imageUrl);
  }
}

async function tesseractAnalyzeUrl(imageUrl: string): Promise<ImageAnalysisResult> {
  try {
    // Download image to buffer first
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const buffer = Buffer.from(response.data);
    return tesseractAnalyzeBuffer(buffer, imageUrl);
  } catch (error) {
    logger.error('Tesseract URL analysis failed (download)', { imageUrl: imageUrl.substring(0, 60), error: (error as Error).message });
    return passOnError(imageUrl);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Cleanup — call when done with all images
// ═══════════════════════════════════════════════════════════════════════

export async function terminateOcrWorker(): Promise<void> {
  if (tesseractWorker) {
    await tesseractWorker.terminate();
    tesseractWorker = null;
    logger.info('Tesseract worker terminated');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Public API (unchanged interface for callers)
// ═══════════════════════════════════════════════════════════════════════

export async function analyzeImageFromBase64(base64Data: string, imageUrl: string): Promise<ImageAnalysisResult> {
  const provider = getOcrProvider();

  if (provider === 'google') {
    return googleAnalyzeBase64(base64Data, imageUrl);
  }

  // Tesseract: convert base64 to buffer
  const buffer = Buffer.from(base64Data, 'base64');
  return tesseractAnalyzeBuffer(buffer, imageUrl);
}

export async function analyzeImageFromUrl(imageUrl: string): Promise<ImageAnalysisResult> {
  const provider = getOcrProvider();

  if (provider === 'google') {
    return googleAnalyzeUrl(imageUrl);
  }

  return tesseractAnalyzeUrl(imageUrl);
}

export async function analyzeProductImages(
  imageUrls: string[]
): Promise<{ allPassed: boolean; results: ImageAnalysisResult[] }> {
  if (imageUrls.length === 0) return { allPassed: true, results: [] };

  logger.info('Analyzing product images', { count: imageUrls.length, provider: getOcrProvider() });

  const results: ImageAnalysisResult[] = [];
  let allPassed = true;

  for (const imageUrl of imageUrls) {
    const result = await analyzeImageFromUrl(imageUrl);
    results.push(result);
    if (!result.passed) {
      allPassed = false;
      logger.info('Image failed analysis', {
        imageUrl: imageUrl.substring(0, 50),
        hasChineseText: result.hasChineseText,
        hasWatermark: result.hasWatermark,
      });
    }
    await sleep(200);
  }

  if (!allPassed) {
    logger.info('Product images failed - contains Chinese text or watermarks');
  } else {
    logger.info('All product images passed analysis');
  }

  return { allPassed, results };
}

export async function analyzeProductImagesWithDownload(
  imageUrls: string[],
  productId: string
): Promise<{ allPassed: boolean; results: ImageAnalysisResult[] }> {
  if (imageUrls.length === 0) return { allPassed: true, results: [] };

  const tempDir = path.join(config.paths.tempImages, productId);
  ensureDirectoryExists(tempDir);

  logger.info('Downloading and analyzing product images', { count: imageUrls.length, productId, provider: getOcrProvider() });

  const results: ImageAnalysisResult[] = [];
  let allPassed = true;

  try {
    for (let i = 0; i < imageUrls.length; i++) {
      const imageUrl = imageUrls[i];
      const localPath = path.join(tempDir, `image_${i}.jpg`);

      const downloaded = await downloadImage(imageUrl, localPath);
      if (!downloaded) {
        results.push(passOnError(imageUrl));
        continue;
      }

      // For Google Vision, use file-based analysis
      if (getOcrProvider() === 'google') {
        const imageContent = fs.readFileSync(localPath);
        const base64Image = imageContent.toString('base64');
        const result = await googleAnalyzeBase64(base64Image, imageUrl);
        results.push(result);
      } else {
        // For Tesseract, read file into buffer
        const buffer = fs.readFileSync(localPath);
        const result = await tesseractAnalyzeBuffer(buffer, imageUrl);
        results.push(result);
      }

      if (!results[results.length - 1].passed) {
        allPassed = false;
      }

      await sleep(200);
    }
  } finally {
    cleanupTempFiles(tempDir);
    try { fs.rmdirSync(tempDir); } catch { }
  }

  return { allPassed, results };
}
