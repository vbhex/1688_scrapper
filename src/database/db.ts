import mysql, { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import {
  ProductRecord, ProductStatus, ComplianceCert, SellerContact,
  BrandEntry, BrandRiskLevel, BrandSource, BrandMatch,
  AuthorizedProduct, AuthorizationType,
  Provider, ProviderPlatform, ProviderTrustLevel,
} from '../models/product';
import { createChildLogger } from '../utils/logger';
import { config } from '../config';

const logger = createChildLogger('database');

let pool: Pool | null = null;

export async function getPool(): Promise<Pool> {
  if (!pool) {
    pool = mysql.createPool({
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      database: config.mysql.database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });

    await initializeSchema();
  }
  return pool;
}

async function initializeSchema(): Promise<void> {
  const connection = await pool!.getConnection();

  try {
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_1688 VARCHAR(50) UNIQUE NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'discovered',
        skip_reason TEXT,
        raw_data JSON NOT NULL,
        url VARCHAR(500) DEFAULT '',
        title_zh VARCHAR(500) DEFAULT '',
        category VARCHAR(100) DEFAULT '',
        thumbnail_url VARCHAR(500) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_status (status),
        INDEX idx_id_1688 (id_1688)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS processing_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        action VARCHAR(100) NOT NULL,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id),
        INDEX idx_product_id (product_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS products_raw (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL UNIQUE,
        title_zh TEXT,
        description_zh LONGTEXT,
        specifications_zh JSON,
        price_cny DECIMAL(10,2),
        min_order_qty INT DEFAULT 1,
        seller_name VARCHAR(200),
        seller_rating DECIMAL(3,1),
        seller_id VARCHAR(200),
        seller_shop_url VARCHAR(500),
        seller_wangwang_id VARCHAR(200),
        scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Add new seller columns to existing products_raw tables (migration)
    for (const col of [
      { name: 'seller_id', def: 'VARCHAR(200)' },
      { name: 'seller_shop_url', def: 'VARCHAR(500)' },
      { name: 'seller_wangwang_id', def: 'VARCHAR(200)' },
    ]) {
      try {
        await connection.execute(`ALTER TABLE products_raw ADD COLUMN ${col.name} ${col.def}`);
      } catch (e: any) {
        if (!e.message?.includes('Duplicate column')) throw e;
      }
    }

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS products_images_raw (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        image_url VARCHAR(1000) NOT NULL,
        image_type ENUM('gallery', 'description', 'variant') DEFAULT 'gallery',
        sort_order INT DEFAULT 0,
        variant_value VARCHAR(100),
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        INDEX idx_product (product_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS products_variants_raw (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        option_name VARCHAR(50),
        option_value VARCHAR(200),
        price_cny DECIMAL(10,2),
        stock INT,
        image_url VARCHAR(1000),
        available BOOLEAN DEFAULT TRUE,
        sort_order INT DEFAULT 0,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        INDEX idx_product (product_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS products_images_ok (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        raw_image_id INT NOT NULL,
        image_url VARCHAR(1000) NOT NULL,
        image_type ENUM('gallery', 'description', 'variant') DEFAULT 'gallery',
        sort_order INT DEFAULT 0,
        variant_value VARCHAR(100),
        has_chinese_text BOOLEAN DEFAULT FALSE,
        has_watermark BOOLEAN DEFAULT FALSE,
        passed BOOLEAN DEFAULT TRUE,
        analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        FOREIGN KEY (raw_image_id) REFERENCES products_images_raw(id) ON DELETE CASCADE,
        INDEX idx_product_passed (product_id, passed)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS products_en (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL UNIQUE,
        title_en VARCHAR(500),
        description_en LONGTEXT,
        specifications_en JSON,
        price_usd DECIMAL(10,2),
        category VARCHAR(100),
        translated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS products_variants_en (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        raw_variant_id INT,
        option_name_en VARCHAR(50),
        option_value_en VARCHAR(200),
        option_value_zh VARCHAR(200),
        price_usd DECIMAL(10,2),
        color_family VARCHAR(50),
        sort_order INT DEFAULT 0,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        INDEX idx_product (product_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS products_images_translated (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        raw_image_id INT NOT NULL,
        original_image_url VARCHAR(1000) NOT NULL,
        translated_image_url VARCHAR(1000) NOT NULL,
        cos_key VARCHAR(500),
        text_regions_count INT DEFAULT 0,
        success BOOLEAN DEFAULT TRUE,
        translated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        FOREIGN KEY (raw_image_id) REFERENCES products_images_raw(id) ON DELETE CASCADE,
        UNIQUE KEY unique_raw_image (raw_image_id),
        INDEX idx_product_success (product_id, success)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // ──────────────────────────────────────────────────────────────────
    // AliExpress enrichment — stores AE match data for products
    // with Chinese text in images
    // ──────────────────────────────────────────────────────────────────
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS products_ae_match (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL UNIQUE,
        has_chinese_images BOOLEAN NOT NULL DEFAULT FALSE,
        ae_product_id VARCHAR(100),
        ae_url VARCHAR(1000),
        ae_title VARCHAR(500),
        ae_images JSON,
        ae_description LONGTEXT,
        match_score DECIMAL(5,2) DEFAULT 0,
        matched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        INDEX idx_product_id (product_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // ──────────────────────────────────────────────────────────────────
    // Normalized variant structure (multi-dimensional support)
    // ──────────────────────────────────────────────────────────────────
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS product_variants (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        variant_name_zh VARCHAR(100) NOT NULL,
        variant_name_en VARCHAR(100),
        sort_order INT DEFAULT 0,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        INDEX idx_product_id (product_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS variant_values (
        id INT AUTO_INCREMENT PRIMARY KEY,
        variant_id INT NOT NULL,
        value_name_zh VARCHAR(200) NOT NULL,
        value_name_en VARCHAR(200),
        image_url VARCHAR(1000),
        sort_order INT DEFAULT 0,
        FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE CASCADE,
        INDEX idx_variant_id (variant_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS variant_skus (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        sku_code VARCHAR(100),
        variant_values_json JSON NOT NULL,
        price_cny DECIMAL(10,2),
        stock INT DEFAULT 0,
        available BOOLEAN DEFAULT TRUE,
        image_url VARCHAR(1000),
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        INDEX idx_product_id (product_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // ──────────────────────────────────────────────────────────────────
    // Compliance certs — cert images/docs found on 1688 product pages
    // ──────────────────────────────────────────────────────────────────
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS compliance_certs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        cert_type VARCHAR(100) NOT NULL COMMENT 'oeko-tex | reach | sgs | gots | iso | ce | unknown',
        cert_number VARCHAR(200),
        image_url TEXT,
        source_url VARCHAR(500),
        found_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_product_cert (product_id, cert_type),
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // ──────────────────────────────────────────────────────────────────
    // Compliance contacts — Wangwang outreach tracking per seller
    // ──────────────────────────────────────────────────────────────────
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS compliance_contacts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        seller_id VARCHAR(200) NOT NULL UNIQUE,
        seller_name VARCHAR(500),
        wangwang_id VARCHAR(200),
        seller_url VARCHAR(500),
        product_ids JSON COMMENT 'Array of our internal products.id values from this seller',
        contact_status ENUM('pending','contacted','responded','certs_received','no_certs') DEFAULT 'pending',
        message_sent_at TIMESTAMP NULL,
        response_at TIMESTAMP NULL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // ──────────────────────────────────────────────────────────────────
    // Brand Safety System — 3 tables
    // ──────────────────────────────────────────────────────────────────

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS brand_list (
        id INT AUTO_INCREMENT PRIMARY KEY,
        brand_name_en VARCHAR(200) NOT NULL,
        brand_name_zh VARCHAR(200),
        category VARCHAR(100) NOT NULL,
        source VARCHAR(100) NOT NULL,
        risk_level ENUM('critical','high','medium','low') DEFAULT 'high',
        aliases JSON,
        exact_match BOOLEAN DEFAULT FALSE,
        active BOOLEAN DEFAULT TRUE,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_brand_en_cat (brand_name_en, category),
        INDEX idx_active (active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS providers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        provider_name VARCHAR(500) NOT NULL,
        platform ENUM('1688','taobao','wechat','direct','other') DEFAULT '1688',
        platform_id VARCHAR(200),
        wangwang_id VARCHAR(200),
        wechat_id VARCHAR(200),
        email VARCHAR(300),
        phone VARCHAR(50),
        shop_url VARCHAR(500),
        trust_level ENUM('new','verified','trusted','preferred','blacklisted') DEFAULT 'new',
        total_products INT DEFAULT 0,
        compliance_score DECIMAL(3,2),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_platform_seller (platform, platform_id),
        INDEX idx_trust_level (trust_level)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS authorized_products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        authorization_type ENUM('not_branded','authorized_reseller','own_brand','generic') NOT NULL,
        authorized_platforms JSON DEFAULT ('["aliexpress"]'),
        provider_id INT,
        seller_confirmation TEXT,
        authorization_doc_url VARCHAR(1000),
        confirmed_by VARCHAR(100),
        confirmed_at TIMESTAMP NULL,
        expires_at TIMESTAMP NULL,
        active BOOLEAN DEFAULT TRUE,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_product (product_id),
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE SET NULL,
        INDEX idx_authorization_type (authorization_type),
        INDEX idx_active (active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Add provider_id FK to compliance_contacts (migration-safe)
    try {
      await connection.execute(`ALTER TABLE compliance_contacts ADD COLUMN provider_id INT`);
    } catch (e: any) {
      if (!e.message?.includes('Duplicate column')) throw e;
    }

    // ──────────────────────────────────────────────────────────────────
    // Compliance Certificates — tracks docs received from sellers
    // ──────────────────────────────────────────────────────────────────

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS compliance_certs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        provider_id INT NOT NULL,
        product_id INT,
        cert_type ENUM('testing_report','reach','oeko_tex','fcc','ce','ukca','rohs','cpsia','brand_authorization','other') NOT NULL,
        cert_number VARCHAR(300),
        issuing_body VARCHAR(300) COMMENT 'e.g. SGS, TUV, Intertek, BV',
        doc_url VARCHAR(1000) COMMENT 'URL or local path to cert file',
        valid_from DATE,
        valid_until DATE,
        covers_platforms JSON DEFAULT ('["aliexpress","amazon"]') COMMENT 'Which platforms this cert enables',
        verified BOOLEAN DEFAULT FALSE COMMENT 'Have we manually verified this cert is legit',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
        INDEX idx_provider (provider_id),
        INDEX idx_cert_type (cert_type),
        INDEX idx_verified (verified)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    logger.info('Database schema initialized');
  } finally {
    connection.release();
  }
}

export function closeDatabase(): void {
  if (pool) {
    pool.end();
    pool = null;
    logger.info('Database connection closed');
  }
}

export async function productExists(id1688: string): Promise<boolean> {
  const p = await getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    'SELECT 1 FROM products WHERE id_1688 = ?',
    [id1688]
  );
  return rows.length > 0;
}

export async function addProcessingLog(
  productId: number,
  action: string,
  details?: string
): Promise<void> {
  const p = await getPool();

  await p.execute(
    `INSERT INTO processing_log (product_id, action, details) VALUES (?, ?, ?)`,
    [productId, action, details || null]
  );
}

export async function getProductStats(): Promise<{
  total: number;
  byStatus: Record<string, number>;
}> {
  const p = await getPool();

  const [totalRows] = await p.execute<RowDataPacket[]>('SELECT COUNT(*) as count FROM products');
  const total = totalRows[0].count;

  const [statusRows] = await p.execute<RowDataPacket[]>(
    `SELECT status, COUNT(*) as count FROM products GROUP BY status`
  );

  const byStatus: Record<string, number> = {};
  for (const row of statusRows) {
    byStatus[row.status] = row.count;
  }

  return { total, byStatus };
}

// ──────────────────────────────────────────────────────────────────────────────
// Compliance functions
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Save seller info (Wangwang ID, shop URL) back onto products_raw.
 */
export async function saveSellerInfoOnRaw(
  productId: number,
  sellerId: string,
  shopUrl: string,
  wangwangId: string
): Promise<void> {
  const p = await getPool();
  await p.execute(
    `UPDATE products_raw
     SET seller_id = ?, seller_shop_url = ?, seller_wangwang_id = ?
     WHERE product_id = ?`,
    [sellerId || null, shopUrl || null, wangwangId || null, productId]
  );
}

/**
 * Upsert a compliance cert found on a 1688 product page.
 */
export async function saveComplianceCert(
  productId: number,
  certType: string,
  certNumber?: string,
  imageUrl?: string,
  sourceUrl?: string
): Promise<void> {
  const p = await getPool();
  await p.execute(
    `INSERT INTO compliance_certs (product_id, cert_type, cert_number, image_url, source_url)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       cert_number = COALESCE(VALUES(cert_number), cert_number),
       image_url   = COALESCE(VALUES(image_url), image_url),
       source_url  = COALESCE(VALUES(source_url), source_url),
       found_at    = NOW()`,
    [productId, certType, certNumber || null, imageUrl || null, sourceUrl || null]
  );
}

/**
 * Upsert a compliance contact (one row per 1688 seller).
 * productIds is merged with any existing product_ids JSON array.
 */
export async function saveSellerContact(
  sellerId: string,
  sellerName: string,
  wangwangId: string,
  sellerUrl: string,
  newProductIds: number[]
): Promise<void> {
  const p = await getPool();

  // Fetch existing product_ids to merge
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT product_ids FROM compliance_contacts WHERE seller_id = ?`,
    [sellerId]
  );
  let merged: number[] = newProductIds;
  if (rows.length > 0 && rows[0].product_ids) {
    const existing: number[] = typeof rows[0].product_ids === 'string'
      ? JSON.parse(rows[0].product_ids)
      : rows[0].product_ids;
    merged = Array.from(new Set([...existing, ...newProductIds]));
  }

  await p.execute(
    `INSERT INTO compliance_contacts (seller_id, seller_name, wangwang_id, seller_url, product_ids)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       seller_name  = VALUES(seller_name),
       wangwang_id  = COALESCE(VALUES(wangwang_id), wangwang_id),
       seller_url   = COALESCE(VALUES(seller_url), seller_url),
       product_ids  = VALUES(product_ids),
       updated_at   = NOW()`,
    [sellerId, sellerName || null, wangwangId || null, sellerUrl || null, JSON.stringify(merged)]
  );
}

/**
 * Get all sellers that still need to be contacted.
 */
export async function getPendingContacts(): Promise<SellerContact[]> {
  const p = await getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT seller_id, seller_name, wangwang_id, seller_url, product_ids
     FROM compliance_contacts
     WHERE contact_status = 'pending'
     ORDER BY created_at ASC`
  );
  return rows.map(r => ({
    sellerId: r.seller_id,
    sellerName: r.seller_name || '',
    wangwangId: r.wangwang_id || undefined,
    sellerUrl: r.seller_url || undefined,
    productIds: typeof r.product_ids === 'string' ? JSON.parse(r.product_ids) : (r.product_ids || []),
  }));
}

/**
 * Update the status of a compliance contact after messaging.
 */
export async function updateContactStatus(
  sellerId: string,
  status: 'contacted' | 'responded' | 'certs_received' | 'no_certs',
  notes?: string
): Promise<void> {
  const p = await getPool();
  const messageSentAt = status === 'contacted' ? new Date() : null;
  await p.execute(
    `UPDATE compliance_contacts
     SET contact_status = ?,
         message_sent_at = COALESCE(?, message_sent_at),
         notes = COALESCE(?, notes),
         updated_at = NOW()
     WHERE seller_id = ?`,
    [status, messageSentAt, notes || null, sellerId]
  );
}

/**
 * Fetch products eligible for compliance scanning:
 * status IN ('ae_enriched', 'ae_exported', 'amazon_exported') AND no seller_id on products_raw yet.
 * Covers both newly enriched products AND already-exported/live products.
 */
export async function getProductsForComplianceScan(limit?: number): Promise<Array<{
  id: number;
  id1688: string;
  url: string;
}>> {
  const p = await getPool();
  const limitClause = limit ? `LIMIT ${limit}` : '';
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT p.id, p.id_1688 AS id1688, p.url
     FROM products p
     LEFT JOIN products_raw pr ON pr.product_id = p.id
     WHERE p.status IN ('ae_enriched', 'ae_exported', 'amazon_exported')
       AND (pr.seller_id IS NULL OR pr.seller_id = '')
       AND p.url IS NOT NULL
     ORDER BY p.status ASC, p.created_at ASC
     ${limitClause}`
  );
  return rows as Array<{ id: number; id1688: string; url: string }>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Brand List CRUD
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Get all active brands from DB for cache loading.
 * Returns flattened keyword list: [brandNameEn, brandNameZh, ...aliases] per brand.
 */
export async function getAllActiveBrands(): Promise<BrandEntry[]> {
  const p = await getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT id, brand_name_en, brand_name_zh, category, source,
            risk_level, aliases, exact_match, active, notes
     FROM brand_list
     WHERE active = TRUE`
  );
  return rows.map(r => ({
    id: r.id,
    brandNameEn: r.brand_name_en,
    brandNameZh: r.brand_name_zh || undefined,
    category: r.category,
    source: r.source,
    riskLevel: r.risk_level,
    aliases: r.aliases ? (typeof r.aliases === 'string' ? JSON.parse(r.aliases) : r.aliases) : undefined,
    exactMatch: !!r.exact_match,
    active: !!r.active,
    notes: r.notes || undefined,
  }));
}

/**
 * Insert or update a brand in the brand_list table.
 */
export async function upsertBrand(brand: BrandEntry): Promise<number> {
  const p = await getPool();
  const [result] = await p.execute<ResultSetHeader>(
    `INSERT INTO brand_list (brand_name_en, brand_name_zh, category, source, risk_level, aliases, exact_match, active, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       brand_name_zh = COALESCE(VALUES(brand_name_zh), brand_name_zh),
       source = VALUES(source),
       risk_level = VALUES(risk_level),
       aliases = VALUES(aliases),
       exact_match = VALUES(exact_match),
       active = VALUES(active),
       notes = COALESCE(VALUES(notes), notes),
       updated_at = NOW()`,
    [
      brand.brandNameEn,
      brand.brandNameZh || null,
      brand.category,
      brand.source,
      brand.riskLevel,
      brand.aliases ? JSON.stringify(brand.aliases) : null,
      brand.exactMatch ? 1 : 0,
      brand.active ? 1 : 0,
      brand.notes || null,
    ]
  );
  return result.insertId || 0;
}

/**
 * Look up a brand by English name and category.
 */
export async function getBrandByName(brandNameEn: string, category?: string): Promise<BrandEntry | null> {
  const p = await getPool();
  const query = category
    ? `SELECT * FROM brand_list WHERE brand_name_en = ? AND category = ? LIMIT 1`
    : `SELECT * FROM brand_list WHERE brand_name_en = ? LIMIT 1`;
  const params = category ? [brandNameEn, category] : [brandNameEn];
  const [rows] = await p.execute<RowDataPacket[]>(query, params);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    brandNameEn: r.brand_name_en,
    brandNameZh: r.brand_name_zh || undefined,
    category: r.category,
    source: r.source,
    riskLevel: r.risk_level,
    aliases: r.aliases ? (typeof r.aliases === 'string' ? JSON.parse(r.aliases) : r.aliases) : undefined,
    exactMatch: !!r.exact_match,
    active: !!r.active,
    notes: r.notes || undefined,
  };
}

/**
 * Get count of brands in brand_list.
 */
export async function getBrandCount(): Promise<number> {
  const p = await getPool();
  const [rows] = await p.execute<RowDataPacket[]>('SELECT COUNT(*) as count FROM brand_list WHERE active = TRUE');
  return rows[0].count;
}

// ──────────────────────────────────────────────────────────────────────────────
// Providers CRUD
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Upsert a provider (seller/supplier) from any sourcing platform.
 */
export async function upsertProvider(provider: Omit<Provider, 'id'>): Promise<number> {
  const p = await getPool();
  const [result] = await p.execute<ResultSetHeader>(
    `INSERT INTO providers (provider_name, platform, platform_id, wangwang_id, wechat_id, email, phone, shop_url, trust_level, total_products, compliance_score, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       provider_name = VALUES(provider_name),
       wangwang_id = COALESCE(VALUES(wangwang_id), wangwang_id),
       wechat_id = COALESCE(VALUES(wechat_id), wechat_id),
       email = COALESCE(VALUES(email), email),
       phone = COALESCE(VALUES(phone), phone),
       shop_url = COALESCE(VALUES(shop_url), shop_url),
       total_products = VALUES(total_products),
       compliance_score = COALESCE(VALUES(compliance_score), compliance_score),
       notes = COALESCE(VALUES(notes), notes),
       updated_at = NOW()`,
    [
      provider.providerName,
      provider.platform,
      provider.platformId || null,
      provider.wangwangId || null,
      provider.wechatId || null,
      provider.email || null,
      provider.phone || null,
      provider.shopUrl || null,
      provider.trustLevel,
      provider.totalProducts,
      provider.complianceScore ?? null,
      provider.notes || null,
    ]
  );
  return result.insertId || 0;
}

/**
 * Find a provider by platform + platform_id (e.g., 1688 seller ID).
 */
export async function getProviderByPlatformId(platform: ProviderPlatform, platformId: string): Promise<Provider | null> {
  const p = await getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT * FROM providers WHERE platform = ? AND platform_id = ? LIMIT 1`,
    [platform, platformId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    providerName: r.provider_name,
    platform: r.platform,
    platformId: r.platform_id || undefined,
    wangwangId: r.wangwang_id || undefined,
    wechatId: r.wechat_id || undefined,
    email: r.email || undefined,
    phone: r.phone || undefined,
    shopUrl: r.shop_url || undefined,
    trustLevel: r.trust_level,
    totalProducts: r.total_products,
    complianceScore: r.compliance_score ? parseFloat(r.compliance_score) : undefined,
    notes: r.notes || undefined,
  };
}

/**
 * Update a provider's trust level.
 */
export async function updateProviderTrustLevel(
  providerId: number,
  trustLevel: ProviderTrustLevel,
  notes?: string
): Promise<void> {
  const p = await getPool();
  await p.execute(
    `UPDATE providers SET trust_level = ?, notes = COALESCE(?, notes), updated_at = NOW() WHERE id = ?`,
    [trustLevel, notes || null, providerId]
  );
}

/**
 * Increment provider total_products count.
 */
export async function incrementProviderProductCount(providerId: number): Promise<void> {
  const p = await getPool();
  await p.execute(
    `UPDATE providers SET total_products = total_products + 1, updated_at = NOW() WHERE id = ?`,
    [providerId]
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Authorized Products CRUD
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Insert or update an authorized product.
 */
export async function upsertAuthorizedProduct(auth: Omit<AuthorizedProduct, 'id'>): Promise<number> {
  const p = await getPool();
  const [result] = await p.execute<ResultSetHeader>(
    `INSERT INTO authorized_products
       (product_id, authorization_type, authorized_platforms, provider_id,
        seller_confirmation, authorization_doc_url, confirmed_by, confirmed_at,
        expires_at, active, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       authorization_type = VALUES(authorization_type),
       authorized_platforms = VALUES(authorized_platforms),
       provider_id = COALESCE(VALUES(provider_id), provider_id),
       seller_confirmation = COALESCE(VALUES(seller_confirmation), seller_confirmation),
       authorization_doc_url = COALESCE(VALUES(authorization_doc_url), authorization_doc_url),
       confirmed_by = VALUES(confirmed_by),
       confirmed_at = VALUES(confirmed_at),
       expires_at = VALUES(expires_at),
       active = VALUES(active),
       notes = COALESCE(VALUES(notes), notes),
       updated_at = NOW()`,
    [
      auth.productId,
      auth.authorizationType,
      JSON.stringify(auth.authorizedPlatforms),
      auth.providerId || null,
      auth.sellerConfirmation || null,
      auth.authorizationDocUrl || null,
      auth.confirmedBy || null,
      auth.confirmedAt || null,
      auth.expiresAt || null,
      auth.active ? 1 : 0,
      auth.notes || null,
    ]
  );
  return result.insertId || 0;
}

/**
 * Check if a product is authorized.
 */
export async function isProductAuthorized(productId: number): Promise<boolean> {
  const p = await getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT 1 FROM authorized_products WHERE product_id = ? AND active = TRUE LIMIT 1`,
    [productId]
  );
  return rows.length > 0;
}

/**
 * Get authorized product record by product_id.
 */
export async function getAuthorizedProduct(productId: number): Promise<AuthorizedProduct | null> {
  const p = await getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT * FROM authorized_products WHERE product_id = ? LIMIT 1`,
    [productId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    productId: r.product_id,
    authorizationType: r.authorization_type,
    authorizedPlatforms: typeof r.authorized_platforms === 'string'
      ? JSON.parse(r.authorized_platforms)
      : (r.authorized_platforms || ['aliexpress']),
    providerId: r.provider_id || undefined,
    sellerConfirmation: r.seller_confirmation || undefined,
    authorizationDocUrl: r.authorization_doc_url || undefined,
    confirmedBy: r.confirmed_by || undefined,
    confirmedAt: r.confirmed_at || undefined,
    expiresAt: r.expires_at || undefined,
    active: !!r.active,
    notes: r.notes || undefined,
  };
}

/**
 * Get products pending brand verification (ae_enriched but not in authorized_products).
 */
export async function getProductsPendingBrandVerification(limit?: number): Promise<Array<{
  id: number;
  id1688: string;
  url: string;
  titleZh: string;
  sellerId?: string;
  sellerName?: string;
  sellerWangwangId?: string;
}>> {
  const p = await getPool();
  const limitClause = limit ? `LIMIT ${limit}` : '';
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT p.id, p.id_1688 AS id1688, p.url, p.title_zh AS titleZh,
            pr.seller_id AS sellerId, pr.seller_name AS sellerName,
            pr.seller_wangwang_id AS sellerWangwangId
     FROM products p
     LEFT JOIN products_raw pr ON pr.product_id = p.id
     LEFT JOIN authorized_products ap ON ap.product_id = p.id
     WHERE p.status = 'ae_enriched'
       AND ap.id IS NULL
     ORDER BY p.created_at ASC
     ${limitClause}`
  );
  return rows as any[];
}

/**
 * Get brand safety stats for reporting.
 */
export async function getBrandSafetyStats(): Promise<{
  totalBrands: number;
  authorizedProducts: number;
  pendingVerification: number;
  providersByTrust: Record<string, number>;
}> {
  const p = await getPool();

  const [brandRows] = await p.execute<RowDataPacket[]>(
    'SELECT COUNT(*) as count FROM brand_list WHERE active = TRUE'
  );
  const [authRows] = await p.execute<RowDataPacket[]>(
    'SELECT COUNT(*) as count FROM authorized_products WHERE active = TRUE'
  );
  const [pendingRows] = await p.execute<RowDataPacket[]>(
    `SELECT COUNT(*) as count FROM products p
     LEFT JOIN authorized_products ap ON ap.product_id = p.id
     WHERE p.status = 'ae_enriched' AND ap.id IS NULL`
  );
  const [trustRows] = await p.execute<RowDataPacket[]>(
    'SELECT trust_level, COUNT(*) as count FROM providers GROUP BY trust_level'
  );

  const providersByTrust: Record<string, number> = {};
  for (const row of trustRows) {
    providersByTrust[row.trust_level] = row.count;
  }

  return {
    totalBrands: brandRows[0].count,
    authorizedProducts: authRows[0].count,
    pendingVerification: pendingRows[0].count,
    providersByTrust,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Compliance Certs CRUD
// ──────────────────────────────────────────────────────────────────────────────

export type CertType = 'testing_report' | 'reach' | 'oeko_tex' | 'fcc' | 'ce' | 'ukca' | 'rohs' | 'cpsia' | 'brand_authorization' | 'other';

export interface ComplianceCert {
  id?: number;
  providerId: number;
  productId?: number;
  certType: CertType;
  certNumber?: string;
  issuingBody?: string;
  docUrl?: string;
  validFrom?: Date;
  validUntil?: Date;
  coversPlatforms: string[];
  verified: boolean;
  notes?: string;
}

/**
 * Insert a compliance cert record.
 */
export async function insertComplianceCert(cert: Omit<ComplianceCert, 'id'>): Promise<number> {
  const p = await getPool();
  const [result] = await p.execute<ResultSetHeader>(
    `INSERT INTO compliance_certs
       (provider_id, product_id, cert_type, cert_number, issuing_body, doc_url,
        valid_from, valid_until, covers_platforms, verified, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cert.providerId,
      cert.productId || null,
      cert.certType,
      cert.certNumber || null,
      cert.issuingBody || null,
      cert.docUrl || null,
      cert.validFrom || null,
      cert.validUntil || null,
      JSON.stringify(cert.coversPlatforms),
      cert.verified ? 1 : 0,
      cert.notes || null,
    ]
  );
  return result.insertId;
}

/**
 * Get all certs for a provider.
 */
export async function getCertsByProvider(providerId: number): Promise<ComplianceCert[]> {
  const p = await getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT * FROM compliance_certs WHERE provider_id = ? ORDER BY created_at DESC`,
    [providerId]
  );
  return rows.map((r: any) => ({
    id: r.id,
    providerId: r.provider_id,
    productId: r.product_id || undefined,
    certType: r.cert_type,
    certNumber: r.cert_number || undefined,
    issuingBody: r.issuing_body || undefined,
    docUrl: r.doc_url || undefined,
    validFrom: r.valid_from || undefined,
    validUntil: r.valid_until || undefined,
    coversPlatforms: typeof r.covers_platforms === 'string'
      ? JSON.parse(r.covers_platforms)
      : (r.covers_platforms || ['aliexpress', 'amazon']),
    verified: !!r.verified,
    notes: r.notes || undefined,
  }));
}

/**
 * Check if a provider has a specific cert type.
 */
export async function providerHasCert(providerId: number, certType: CertType): Promise<boolean> {
  const p = await getPool();
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT 1 FROM compliance_certs WHERE provider_id = ? AND cert_type = ? LIMIT 1`,
    [providerId, certType]
  );
  return rows.length > 0;
}
