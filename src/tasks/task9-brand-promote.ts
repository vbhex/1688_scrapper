/**
 * Task 9: Brand Verification Status Promotion
 *
 * Promotes products from 'ae_enriched' → 'brand_verified' if they have a row
 * in the authorized_products table (confirmed safe to list).
 *
 * This is the gateway between sourcing (Tasks 1-8) and listing (Excel export).
 * Products must pass brand verification before they can be exported.
 *
 * Usage:
 *   node dist/tasks/task9-brand-promote.js [--limit 100]
 *
 * Runs on: Either machine (no browser needed)
 */

import {
  closeDatabase,
  getPool,
} from '../database/db';
import { createChildLogger } from '../utils/logger';
import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';

const logger = createChildLogger('task9-brand-promote');

async function main(): Promise<void> {
  const limitArg = process.argv.find((a, i) => (a === '--limit' || a === '-l') && process.argv[i + 1]);
  const limit = limitArg ? parseInt(process.argv[process.argv.indexOf(limitArg) + 1]) : 0;

  logger.info('Task 9: Brand Verification Promotion', { limit: limit || 'unlimited' });

  const pool = await getPool();

  // Find ae_enriched products that ARE in authorized_products
  const limitClause = limit ? `LIMIT ${limit}` : '';
  const [authorized] = await pool.execute<RowDataPacket[]>(
    `SELECT p.id, p.id_1688, ap.authorization_type
     FROM products p
     INNER JOIN authorized_products ap ON ap.product_id = p.id AND ap.active = TRUE
     WHERE p.status = 'ae_enriched'
     ORDER BY p.created_at ASC
     ${limitClause}`
  );

  if (authorized.length === 0) {
    logger.info('No ae_enriched products with brand authorization found');

    // Show stats for context
    const [pendingCount] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) as count FROM products WHERE status = 'ae_enriched'`
    );
    const [authCount] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) as count FROM authorized_products WHERE active = TRUE`
    );
    logger.info(`Stats: ${pendingCount[0].count} ae_enriched products, ${authCount[0].count} authorized products total`);
    closeDatabase();
    return;
  }

  logger.info(`Found ${authorized.length} authorized products to promote`);

  let promoted = 0;
  for (const row of authorized) {
    try {
      await pool.execute(
        `UPDATE products SET status = 'brand_verified', updated_at = NOW() WHERE id = ?`,
        [row.id]
      );
      promoted++;
      logger.info(`Promoted ${row.id_1688} (${row.authorization_type}) → brand_verified`);
    } catch (err: any) {
      logger.error(`Failed to promote ${row.id_1688}`, { error: err.message });
    }
  }

  // Summary stats
  const [statsRows] = await pool.execute<RowDataPacket[]>(
    `SELECT
       SUM(CASE WHEN p.status = 'ae_enriched' AND ap.id IS NULL THEN 1 ELSE 0 END) as pending_verification,
       SUM(CASE WHEN p.status = 'ae_enriched' AND ap.id IS NOT NULL THEN 1 ELSE 0 END) as ready_to_promote,
       SUM(CASE WHEN p.status = 'brand_verified' THEN 1 ELSE 0 END) as brand_verified
     FROM products p
     LEFT JOIN authorized_products ap ON ap.product_id = p.id AND ap.active = TRUE
     WHERE p.status IN ('ae_enriched', 'brand_verified')`
  );
  const stats = statsRows[0];

  closeDatabase();

  logger.info('══════════════════════════════════════════');
  logger.info('Task 9: Brand Promotion Complete');
  logger.info(`  Promoted this run    : ${promoted}`);
  logger.info(`  Pending verification : ${stats.pending_verification} (need Task 8 or auto-authorize)`);
  logger.info(`  Total brand_verified : ${stats.brand_verified}`);
  logger.info('══════════════════════════════════════════');
}

main().catch(err => {
  logger.error('Unhandled error', { error: err.message });
  closeDatabase();
  process.exit(1);
});
