import axios from 'axios';
import crypto from 'crypto';
import { createChildLogger } from '../utils/logger';
import { config } from '../config';
import { ProductSpecification, ProductVariants, VariantOption, SkuVariant } from '../models/product';
import { sleep, chunkArray } from '../utils/helpers';

const logger = createChildLogger('translator');

const RATE_LIMIT_DELAY_MS = 100;

// ─── Provider detection ───────────────────────────────────────────────

type TranslateProvider = 'google' | 'baidu';

function getProvider(): TranslateProvider {
  if (config.baidu.translateAppId && config.baidu.translateSecret) {
    return 'baidu';
  }
  if (config.google.apiKey) {
    return 'google';
  }
  throw new Error('No translation API configured. Set GOOGLE_CLOUD_API_KEY or BAIDU_TRANSLATE_APPID + BAIDU_TRANSLATE_SECRET in .env');
}

// ─── HTML entity decoding ─────────────────────────────────────────────

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));
}

// ═══════════════════════════════════════════════════════════════════════
// Google Translate API
// ═══════════════════════════════════════════════════════════════════════

const GOOGLE_TRANSLATE_URL = 'https://translation.googleapis.com/language/translate/v2';

interface GoogleTranslateResponse {
  data: {
    translations: Array<{
      translatedText: string;
      detectedSourceLanguage?: string;
    }>;
  };
}

async function googleTranslateText(text: string): Promise<string> {
  if (!text || text.trim().length === 0) return '';

  const params = new URLSearchParams();
  params.append('q', text);
  params.append('target', 'en');
  params.append('key', config.google.apiKey);

  const response = await axios.post<GoogleTranslateResponse>(
    GOOGLE_TRANSLATE_URL,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );

  return decodeHtmlEntities(response.data.data.translations[0].translatedText);
}

async function googleTranslateBatch(texts: string[]): Promise<string[]> {
  if (texts.length === 0) return [];

  const nonEmpty: Array<{ index: number; text: string }> = [];
  texts.forEach((text, index) => {
    if (text && text.trim().length > 0) nonEmpty.push({ index, text });
  });
  if (nonEmpty.length === 0) return texts.map(() => '');

  const params = new URLSearchParams();
  for (const t of nonEmpty) params.append('q', t.text);
  params.append('target', 'en');
  params.append('key', config.google.apiKey);

  const response = await axios.post<GoogleTranslateResponse>(
    GOOGLE_TRANSLATE_URL,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 }
  );

  const translations = response.data.data.translations;
  const result = texts.map(() => '');
  nonEmpty.forEach((item, i) => {
    result[item.index] = decodeHtmlEntities(translations[i].translatedText);
  });
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// Baidu Translate API
// ═══════════════════════════════════════════════════════════════════════

const BAIDU_TRANSLATE_URL = 'https://fanyi-api.baidu.com/api/trans/vip/translate';

interface BaiduTranslateResponse {
  from: string;
  to: string;
  trans_result?: Array<{ src: string; dst: string }>;
  error_code?: string;
  error_msg?: string;
}

function baiduSign(text: string, salt: string): string {
  const str = config.baidu.translateAppId + text + salt + config.baidu.translateSecret;
  return crypto.createHash('md5').update(str).digest('hex');
}

async function baiduTranslateText(text: string): Promise<string> {
  if (!text || text.trim().length === 0) return '';

  const salt = Date.now().toString();
  const sign = baiduSign(text, salt);

  const params = new URLSearchParams();
  params.append('q', text);
  params.append('from', 'zh');
  params.append('to', 'en');
  params.append('appid', config.baidu.translateAppId);
  params.append('salt', salt);
  params.append('sign', sign);

  const response = await axios.post<BaiduTranslateResponse>(
    BAIDU_TRANSLATE_URL,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );

  if (response.data.error_code) {
    // Error code 54003 = rate limit
    if (response.data.error_code === '54003') {
      logger.warn('Baidu rate limited, waiting before retry');
      await sleep(1500);
      return baiduTranslateText(text);
    }
    throw new Error(`Baidu Translate error ${response.data.error_code}: ${response.data.error_msg}`);
  }

  const results = response.data.trans_result || [];
  return results.map(r => r.dst).join('\n');
}

/**
 * Baidu API only accepts single `q` param (newline-separated for multiple texts).
 * Max 6000 bytes per request. We join with \n and split results back.
 */
async function baiduTranslateBatch(texts: string[]): Promise<string[]> {
  if (texts.length === 0) return [];

  const nonEmpty: Array<{ index: number; text: string }> = [];
  texts.forEach((text, index) => {
    if (text && text.trim().length > 0) nonEmpty.push({ index, text });
  });
  if (nonEmpty.length === 0) return texts.map(() => '');

  // Baidu API has 6000-byte limit per request. Split into chunks.
  const MAX_BYTES = 5000; // Leave some margin
  const chunks: Array<Array<{ index: number; text: string }>> = [];
  let currentChunk: Array<{ index: number; text: string }> = [];
  let currentSize = 0;

  for (const item of nonEmpty) {
    const itemSize = Buffer.byteLength(item.text, 'utf8') + 1; // +1 for \n
    if (currentSize + itemSize > MAX_BYTES && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentSize = 0;
    }
    currentChunk.push(item);
    currentSize += itemSize;
  }
  if (currentChunk.length > 0) chunks.push(currentChunk);

  const result = texts.map(() => '');

  for (const chunk of chunks) {
    const combined = chunk.map(c => c.text).join('\n');
    const salt = Date.now().toString();
    const sign = baiduSign(combined, salt);

    const params = new URLSearchParams();
    params.append('q', combined);
    params.append('from', 'zh');
    params.append('to', 'en');
    params.append('appid', config.baidu.translateAppId);
    params.append('salt', salt);
    params.append('sign', sign);

    const response = await axios.post<BaiduTranslateResponse>(
      BAIDU_TRANSLATE_URL,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 }
    );

    if (response.data.error_code) {
      if (response.data.error_code === '54003') {
        await sleep(1500);
        // Retry this chunk by falling back to individual translations
        for (const item of chunk) {
          try {
            result[item.index] = await baiduTranslateText(item.text);
            await sleep(RATE_LIMIT_DELAY_MS);
          } catch { result[item.index] = item.text; }
        }
        continue;
      }
      logger.error('Baidu batch translation error', { error_code: response.data.error_code, error_msg: response.data.error_msg });
      // Fall back to individual
      for (const item of chunk) {
        try {
          result[item.index] = await baiduTranslateText(item.text);
          await sleep(RATE_LIMIT_DELAY_MS);
        } catch { result[item.index] = item.text; }
      }
      continue;
    }

    const transResults = response.data.trans_result || [];
    // Baidu returns one trans_result per line in the input
    for (let i = 0; i < chunk.length && i < transResults.length; i++) {
      result[chunk[i].index] = transResults[i].dst;
    }

    // Baidu free tier: max 1 QPS (standard) or 10 QPS (premium)
    await sleep(1100);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// Unified API (auto-detects provider)
// ═══════════════════════════════════════════════════════════════════════

async function translateBatch(texts: string[]): Promise<string[]> {
  const provider = getProvider();

  try {
    if (provider === 'baidu') return await baiduTranslateBatch(texts);
    return await googleTranslateBatch(texts);
  } catch (error) {
    const err = error as any;
    if (err.response?.status === 429) {
      logger.warn('Rate limited, waiting before retry');
      await sleep(1000);
      return translateBatch(texts);
    }
    logger.error('Batch translation failed, falling back to individual', { error: err.message });

    const fallback: string[] = [];
    for (const text of texts) {
      try {
        fallback.push(await translateText(text));
        await sleep(RATE_LIMIT_DELAY_MS);
      } catch { fallback.push(text); }
    }
    return fallback;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Public API (unchanged interface for callers)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Translates a single text string from Chinese to English
 * Auto-detects provider (Baidu or Google) based on config
 */
export async function translateText(text: string): Promise<string> {
  const provider = getProvider();
  if (provider === 'baidu') return baiduTranslateText(text);
  return googleTranslateText(text);
}

/**
 * Public batch translation — translates multiple texts in one API call.
 * Much faster than calling translateText() N times.
 */
export async function translateBatchPublic(texts: string[]): Promise<string[]> {
  return translateBatch(texts);
}

export async function translateTitle(title: string): Promise<string> {
  logger.info('Translating title', { title: title.substring(0, 50), provider: getProvider() });
  return translateText(title);
}

export async function translateDescription(description: string): Promise<string> {
  if (!description || description.trim().length === 0) return '';

  logger.info('Translating description', { length: description.length, provider: getProvider() });

  if (description.length > 5000) {
    const paragraphs = description.split(/\n\n+/);
    const chunks = chunkArray(paragraphs, 10);
    const translatedParagraphs: string[] = [];
    for (const chunk of chunks) {
      const translated = await translateBatch(chunk);
      translatedParagraphs.push(...translated);
      await sleep(RATE_LIMIT_DELAY_MS);
    }
    return translatedParagraphs.join('\n\n');
  }

  return translateText(description);
}

export async function translateSpecifications(
  specs: ProductSpecification[]
): Promise<ProductSpecification[]> {
  if (specs.length === 0) return [];

  logger.info('Translating specifications', { count: specs.length });

  const allTexts: string[] = [];
  specs.forEach(spec => { allTexts.push(spec.name); allTexts.push(spec.value); });

  const chunks = chunkArray(allTexts, 20);
  const allTranslated: string[] = [];
  for (const chunk of chunks) {
    const translated = await translateBatch(chunk);
    allTranslated.push(...translated);
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  const translatedSpecs: ProductSpecification[] = [];
  for (let i = 0; i < specs.length; i++) {
    translatedSpecs.push({
      name: allTranslated[i * 2] || specs[i].name,
      value: allTranslated[i * 2 + 1] || specs[i].value,
    });
  }
  return translatedSpecs;
}

export async function translateVariants(
  variants: ProductVariants
): Promise<ProductVariants> {
  if (!variants || variants.options.length === 0) return variants;

  logger.info('Translating variant options', {
    optionCount: variants.options.length,
    skuCount: variants.skus.length,
  });

  const allTexts: string[] = [];
  for (const option of variants.options) {
    allTexts.push(option.name);
    for (const val of option.values) allTexts.push(val);
  }

  const translated = await translateBatch(allTexts);

  const valueMap: Record<string, string> = {};
  const translatedOptions: VariantOption[] = [];
  let idx = 0;

  for (const option of variants.options) {
    const translatedName = translated[idx] || option.name;
    idx++;
    const translatedValues: string[] = [];
    for (const val of option.values) {
      const translatedVal = translated[idx] || val;
      valueMap[val] = translatedVal;
      translatedValues.push(translatedVal);
      idx++;
    }
    translatedOptions.push({ name: translatedName, values: translatedValues });
  }

  const nameMap: Record<string, string> = {};
  for (let i = 0; i < variants.options.length; i++) {
    nameMap[variants.options[i].name] = translatedOptions[i].name;
  }

  const translatedSkus: SkuVariant[] = variants.skus.map(sku => ({
    ...sku,
    optionValues: Object.fromEntries(
      Object.entries(sku.optionValues).map(([key, val]) => [
        nameMap[key] || key,
        valueMap[val] || val,
      ])
    ),
  }));

  return { options: translatedOptions, skus: translatedSkus };
}

export interface TranslationResult {
  titleEN: string;
  descriptionEN: string;
  specificationsEN: ProductSpecification[];
  variantsEN?: ProductVariants;
}

export async function translateProduct(
  title: string,
  description: string,
  specifications: ProductSpecification[],
  variants?: ProductVariants,
): Promise<TranslationResult> {
  logger.info('Starting product translation', { provider: getProvider() });

  const provider = getProvider();

  // Batch title + short descriptions together to reduce API calls
  let titleEN: string;
  let descriptionEN: string;
  if (description.length <= 5000) {
    // Batch title and description in one call
    const batch = await translateBatch([title, description]);
    titleEN = batch[0] || title;
    descriptionEN = batch[1] || description;
  } else {
    titleEN = await translateTitle(title);
    descriptionEN = await translateDescription(description);
  }
  const specificationsEN = await translateSpecifications(specifications);
  let variantsEN: ProductVariants | undefined;

  if (variants && variants.options.length > 0) {
    variantsEN = await translateVariants(variants);
  }

  logger.info('Product translation completed');

  return {
    titleEN,
    descriptionEN,
    specificationsEN,
    ...(variantsEN ? { variantsEN } : {}),
  };
}
