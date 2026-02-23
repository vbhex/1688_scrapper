import mysql, { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { ProductRecord, ProductStatus } from '../models/product';
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
        scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

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
