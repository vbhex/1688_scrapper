import mysql, { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { ProductRecord, ProductStatus, ComplianceCert, SellerContact } from '../models/product';
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
