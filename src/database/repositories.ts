import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { getPool } from './db';
import { createChildLogger } from '../utils/logger';
import { ProductStatus } from '../models/product';

const logger = createChildLogger('repositories');

// ─── products table helpers ───────────────────────────────────────────

export async function discoverProduct(
  id1688: string,
  url: string,
  titleZh: string,
  category: string,
  thumbnailUrl: string,
): Promise<number | null> {
  const p = await getPool();

  // Check duplicate
  const [existing] = await p.execute<RowDataPacket[]>(
    'SELECT id FROM products WHERE id_1688 = ?', [id1688]
  );
  if (existing.length > 0) return null;

  const [result] = await p.execute<ResultSetHeader>(
    `INSERT INTO products (id_1688, url, title_zh, category, thumbnail_url, status, raw_data)
     VALUES (?, ?, ?, ?, ?, 'discovered', '{}')`,
    [id1688, url, titleZh, category, thumbnailUrl]
  );

  logger.info('Product discovered', { id1688, id: result.insertId });
  return result.insertId;
}

export async function getProductsByStatusWithLimit(
  status: ProductStatus,
  limit: number
): Promise<Array<{ id: number; id1688: string; url: string; titleZh: string; category: string }>> {
  const p = await getPool();
  const safeLimit = Math.max(1, Math.floor(limit));
  const [rows] = await p.query<RowDataPacket[]>(
    `SELECT id, id_1688 AS id1688, url, title_zh AS titleZh, category
     FROM products WHERE status = ? ORDER BY id ASC LIMIT ${safeLimit}`,
    [status]
  );
  return rows as any[];
}

export async function updateStatus(productId: number, status: ProductStatus, skipReason?: string): Promise<void> {
  const p = await getPool();
  await p.execute(
    'UPDATE products SET status = ?, skip_reason = ? WHERE id = ?',
    [status, skipReason || null, productId]
  );
}

// ─── products_raw ─────────────────────────────────────────────────────

export interface RawProductData {
  productId: number;
  titleZh: string;
  descriptionZh: string;
  specificationsZh: Array<{ name: string; value: string }>;
  priceCny: number;
  minOrderQty: number;
  sellerName: string;
  sellerRating: number;
}

export async function insertProductRaw(data: RawProductData): Promise<number> {
  const p = await getPool();
  const [result] = await p.execute<ResultSetHeader>(
    `INSERT INTO products_raw (product_id, title_zh, description_zh, specifications_zh, price_cny, min_order_qty, seller_name, seller_rating)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE title_zh=VALUES(title_zh), description_zh=VALUES(description_zh),
       specifications_zh=VALUES(specifications_zh), price_cny=VALUES(price_cny),
       min_order_qty=VALUES(min_order_qty), seller_name=VALUES(seller_name),
       seller_rating=VALUES(seller_rating), scraped_at=CURRENT_TIMESTAMP`,
    [
      data.productId, data.titleZh, data.descriptionZh,
      JSON.stringify(data.specificationsZh), data.priceCny,
      data.minOrderQty, data.sellerName, data.sellerRating,
    ]
  );
  return result.insertId;
}

export async function getProductRaw(productId: number): Promise<RawProductData | null> {
  const p = await getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT product_id AS productId, title_zh AS titleZh, description_zh AS descriptionZh,
            specifications_zh AS specificationsZh, price_cny AS priceCny,
            min_order_qty AS minOrderQty, seller_name AS sellerName,
            seller_rating AS sellerRating
     FROM products_raw WHERE product_id = ?`,
    [productId]
  );
  if (rows.length === 0) return null;
  const row = rows[0] as any;
  row.specificationsZh = typeof row.specificationsZh === 'string'
    ? JSON.parse(row.specificationsZh) : row.specificationsZh;
  return row;
}

// ─── products_images_raw ──────────────────────────────────────────────

export interface RawImage {
  id?: number;
  productId: number;
  imageUrl: string;
  imageType: 'gallery' | 'description' | 'variant';
  sortOrder: number;
  variantValue?: string;
}

export async function insertImagesRaw(images: RawImage[]): Promise<void> {
  if (images.length === 0) return;
  const p = await getPool();
  const values = images.map(img => [
    img.productId, img.imageUrl, img.imageType, img.sortOrder, img.variantValue || null
  ]);
  // Build multi-row insert
  const placeholders = values.map(() => '(?, ?, ?, ?, ?)').join(', ');
  const flat = values.flat();
  await p.execute(
    `INSERT INTO products_images_raw (product_id, image_url, image_type, sort_order, variant_value)
     VALUES ${placeholders}`,
    flat
  );
}

export async function getImagesRaw(productId: number): Promise<(RawImage & { id: number })[]> {
  const p = await getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT id, product_id AS productId, image_url AS imageUrl,
            image_type AS imageType, sort_order AS sortOrder,
            variant_value AS variantValue
     FROM products_images_raw WHERE product_id = ? ORDER BY sort_order`,
    [productId]
  );
  return rows as any[];
}

export async function deleteImagesRaw(productId: number): Promise<void> {
  const p = await getPool();
  await p.execute('DELETE FROM products_images_raw WHERE product_id = ?', [productId]);
}

// ─── products_variants_raw ────────────────────────────────────────────

export interface RawVariant {
  id?: number;
  productId: number;
  optionName: string;
  optionValue: string;
  priceCny: number;
  stock: number;
  imageUrl?: string;
  available: boolean;
  sortOrder: number;
}

export async function insertVariantsRaw(variants: RawVariant[]): Promise<void> {
  if (variants.length === 0) return;
  const p = await getPool();
  const values = variants.map(v => [
    v.productId, v.optionName, v.optionValue, v.priceCny,
    v.stock, v.imageUrl || null, v.available ? 1 : 0, v.sortOrder,
  ]);
  const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
  await p.execute(
    `INSERT INTO products_variants_raw (product_id, option_name, option_value, price_cny, stock, image_url, available, sort_order)
     VALUES ${placeholders}`,
    values.flat()
  );
}

export async function getVariantsRaw(productId: number): Promise<(RawVariant & { id: number })[]> {
  const p = await getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT id, product_id AS productId, option_name AS optionName,
            option_value AS optionValue, price_cny AS priceCny,
            stock, image_url AS imageUrl, available, sort_order AS sortOrder
     FROM products_variants_raw WHERE product_id = ? ORDER BY sort_order`,
    [productId]
  );
  return rows as any[];
}

export async function deleteVariantsRaw(productId: number): Promise<void> {
  const p = await getPool();
  await p.execute('DELETE FROM products_variants_raw WHERE product_id = ?', [productId]);
}

// ─── products_images_ok ───────────────────────────────────────────────

export interface ImageOk {
  id?: number;
  productId: number;
  rawImageId: number;
  imageUrl: string;
  imageType: 'gallery' | 'description' | 'variant';
  sortOrder: number;
  variantValue?: string;
  hasChineseText: boolean;
  hasWatermark: boolean;
  passed: boolean;
}

export async function insertImageOk(img: ImageOk): Promise<number> {
  const p = await getPool();
  const [result] = await p.execute<ResultSetHeader>(
    `INSERT INTO products_images_ok
       (product_id, raw_image_id, image_url, image_type, sort_order, variant_value, has_chinese_text, has_watermark, passed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      img.productId, img.rawImageId, img.imageUrl, img.imageType,
      img.sortOrder, img.variantValue || null,
      img.hasChineseText ? 1 : 0, img.hasWatermark ? 1 : 0, img.passed ? 1 : 0,
    ]
  );
  return result.insertId;
}

export async function getImagesOk(productId: number, passedOnly: boolean = false): Promise<ImageOk[]> {
  const p = await getPool();
  let query = `SELECT id, product_id AS productId, raw_image_id AS rawImageId,
                      image_url AS imageUrl, image_type AS imageType,
                      sort_order AS sortOrder, variant_value AS variantValue,
                      has_chinese_text AS hasChineseText, has_watermark AS hasWatermark, passed
               FROM products_images_ok WHERE product_id = ?`;
  if (passedOnly) query += ' AND passed = 1';
  query += ' ORDER BY sort_order';
  const [rows] = await p.execute<RowDataPacket[]>(query, [productId]);
  return rows as any[];
}

export async function countPassedGalleryImages(productId: number): Promise<number> {
  const p = await getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS cnt FROM products_images_ok
     WHERE product_id = ? AND passed = 1 AND image_type = 'gallery'`,
    [productId]
  );
  return rows[0].cnt;
}

// ─── products_en ──────────────────────────────────────────────────────

export interface ProductEN {
  productId: number;
  titleEn: string;
  descriptionEn: string;
  specificationsEn: Array<{ name: string; value: string }>;
  priceUsd: number;
  category: string;
}

export async function insertProductEN(data: ProductEN): Promise<number> {
  const p = await getPool();
  const [result] = await p.execute<ResultSetHeader>(
    `INSERT INTO products_en (product_id, title_en, description_en, specifications_en, price_usd, category)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE title_en=VALUES(title_en), description_en=VALUES(description_en),
       specifications_en=VALUES(specifications_en), price_usd=VALUES(price_usd),
       category=VALUES(category), translated_at=CURRENT_TIMESTAMP`,
    [
      data.productId, data.titleEn, data.descriptionEn,
      JSON.stringify(data.specificationsEn), data.priceUsd, data.category,
    ]
  );
  return result.insertId;
}

export async function getProductEN(productId: number): Promise<ProductEN | null> {
  const p = await getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT product_id AS productId, title_en AS titleEn, description_en AS descriptionEn,
            specifications_en AS specificationsEn, price_usd AS priceUsd,
            category
     FROM products_en WHERE product_id = ?`,
    [productId]
  );
  if (rows.length === 0) return null;
  const row = rows[0] as any;
  row.specificationsEn = typeof row.specificationsEn === 'string'
    ? JSON.parse(row.specificationsEn) : row.specificationsEn;
  return row;
}

// ─── products_variants_en ─────────────────────────────────────────────

export interface VariantEN {
  id?: number;
  productId: number;
  rawVariantId?: number;
  optionNameEn: string;
  optionValueEn: string;
  optionValueZh: string;
  priceUsd: number;
  colorFamily: string;
  sortOrder: number;
}

export async function insertVariantsEN(variants: VariantEN[]): Promise<void> {
  if (variants.length === 0) return;
  const p = await getPool();

  // Delete existing first
  await p.execute('DELETE FROM products_variants_en WHERE product_id = ?', [variants[0].productId]);

  const values = variants.map(v => [
    v.productId, v.rawVariantId || null, v.optionNameEn, v.optionValueEn,
    v.optionValueZh, v.priceUsd, v.colorFamily, v.sortOrder,
  ]);
  const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
  await p.execute(
    `INSERT INTO products_variants_en
       (product_id, raw_variant_id, option_name_en, option_value_en, option_value_zh, price_usd, color_family, sort_order)
     VALUES ${placeholders}`,
    values.flat()
  );
}

export async function getVariantsEN(productId: number): Promise<VariantEN[]> {
  const p = await getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT id, product_id AS productId, raw_variant_id AS rawVariantId,
            option_name_en AS optionNameEn, option_value_en AS optionValueEn,
            option_value_zh AS optionValueZh, price_usd AS priceUsd,
            color_family AS colorFamily, sort_order AS sortOrder
     FROM products_variants_en WHERE product_id = ? ORDER BY sort_order`,
    [productId]
  );
  return rows as any[];
}
