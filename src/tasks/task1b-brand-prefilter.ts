/**
 * Task 1B: Brand Pre-Filter
 *
 * Lightweight brand check that runs AFTER Task 1 (discover) and BEFORE Task 2 (scrape).
 * Catches products that should be skipped before we spend time/resources scraping details.
 *
 * What it checks (no browser needed — pure DB work):
 *   1. Re-runs isBannedBrand() on title_zh — catches brands added to brand_list AFTER Task 1 ran
 *   2. Checks for suspicious title patterns that indicate branded/counterfeit goods
 *   3. Checks if the product's 1688 ID appears in any prior violation record
 *   4. Checks if any known blacklisted provider's shop name appears in the product URL
 *
 * Pipeline order: Task 1 → Task 1B → Task 2 → Task 3 → Task 8 → Task 4 → Task 5
 *
 * Usage:
 *   node dist/tasks/task1b-brand-prefilter.js [--limit 100] [--dry-run]
 */

import { getPool, closeDatabase } from '../database/db';
import { initBrandCache, isBannedBrand } from '../utils/helpers';
import { createChildLogger } from '../utils/logger';
import { RowDataPacket } from 'mysql2/promise';

const logger = createChildLogger('task1b-brand-prefilter');

// Suspicious title patterns that suggest branded/counterfeit products.
// These are Chinese phrases commonly used in knock-off listings.
const SUSPICIOUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  // "Same style as [brand]" — common knock-off indicator
  { pattern: /(?:同款|联名|合作款|授权|正品)/u, reason: 'Title contains brand-adjacent keywords (同款/联名/合作款/授权/正品)' },
  // Luxury/designer indicators
  { pattern: /(?:大牌|奢侈|高端仿|原单|外贸尾单|跟单|尾货)/u, reason: 'Title contains luxury/counterfeit keywords (大牌/原单/外贸尾单)' },
  // Specific brand abbreviations commonly used to evade filters
  { pattern: /\b(?:LV|GG|CC|TB|YSL|MK)\b/i, reason: 'Title contains brand abbreviation (LV/GG/CC/TB/YSL/MK)' },
  // "Celebrity same style" — signals branded/designer copy
  { pattern: /(?:明星同款|网红同款|ins风|韩版)/u, reason: 'Title contains celebrity/influencer copy keywords' },
];

interface CLIOptions {
  limit: number;
  dryRun: boolean;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = { limit: 0, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--limit' || args[i] === '-l') && args[i + 1]) {
      options.limit = parseInt(args[++i]) || 0;
    } else if (args[i] === '--dry-run') {
      options.dryRun = true;
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs();
  logger.info('Task 1B: Brand Pre-Filter', options);

  // Load latest brand cache from DB
  await initBrandCache();

  const pool = await getPool();

  // Get all discovered products (not yet scraped)
  const limitClause = options.limit > 0 ? `LIMIT ${options.limit}` : '';
  const [products] = await pool.execute<RowDataPacket[]>(
    `SELECT id, id_1688, title_zh, url, category
     FROM products
     WHERE status = 'discovered'
     ORDER BY id ASC ${limitClause}`
  );

  if (products.length === 0) {
    logger.info('No discovered products to pre-filter');
    closeDatabase();
    return;
  }

  logger.info(`Checking ${products.length} discovered products`);

  let brandBlocked = 0;
  let patternBlocked = 0;
  let violationBlocked = 0;
  let providerBlocked = 0;
  let passed = 0;

  // Load blacklisted provider shop IDs for URL matching
  const [blacklistedProviders] = await pool.execute<RowDataPacket[]>(
    `SELECT platform_id, provider_name FROM providers
     WHERE trust_level = 'blacklisted' AND platform = '1688'`
  );
  const blacklistedShopIds = new Set(
    blacklistedProviders.map((p: any) => p.platform_id)
  );
  logger.info(`Loaded ${blacklistedShopIds.size} blacklisted provider shop IDs`);

  // Load 1688 IDs from prior violations (products that caused AE violations)
  const [violationProducts] = await pool.execute<RowDataPacket[]>(
    `SELECT DISTINCT p.id_1688
     FROM products p
     WHERE p.id IN (
       SELECT product_id FROM product_store_targets WHERE status = 'violation'
     ) OR p.id_1688 IN (
       SELECT id_1688 FROM products WHERE status = 'skipped' AND skip_reason LIKE '%violation%'
     )`
  ).catch(() => [[] as RowDataPacket[]]);
  const violationIds = new Set(
    (violationProducts as any[]).map((r: any) => String(r.id_1688))
  );

  for (const prod of products) {
    const title = prod.title_zh || '';
    const id1688 = String(prod.id_1688);
    const url = prod.url || '';

    // Check 1: Re-run brand check against latest brand_list
    if (isBannedBrand(title)) {
      const reason = `Brand detected in title (re-check)`;
      if (!options.dryRun) {
        await pool.execute(
          `UPDATE products SET status = 'skipped', skip_reason = ? WHERE id = ?`,
          [reason, prod.id]
        );
      }
      logger.info(`[BRAND] ${id1688}: ${reason}`, { title: title.substring(0, 60) });
      brandBlocked++;
      continue;
    }

    // Check 2: Suspicious title patterns
    let patternHit = false;
    for (const { pattern, reason } of SUSPICIOUS_PATTERNS) {
      if (pattern.test(title)) {
        if (!options.dryRun) {
          await pool.execute(
            `UPDATE products SET status = 'skipped', skip_reason = ? WHERE id = ?`,
            [`Suspicious pattern: ${reason}`, prod.id]
          );
        }
        logger.info(`[PATTERN] ${id1688}: ${reason}`, { title: title.substring(0, 60) });
        patternBlocked++;
        patternHit = true;
        break;
      }
    }
    if (patternHit) continue;

    // Check 3: Product ID in prior violation records
    if (violationIds.has(id1688)) {
      const reason = 'Product 1688 ID found in prior violation records';
      if (!options.dryRun) {
        await pool.execute(
          `UPDATE products SET status = 'skipped', skip_reason = ? WHERE id = ?`,
          [reason, prod.id]
        );
      }
      logger.info(`[VIOLATION] ${id1688}: prior violation`, { title: title.substring(0, 60) });
      violationBlocked++;
      continue;
    }

    // Check 4: URL contains blacklisted provider shop ID
    let shopBlocked = false;
    for (const shopId of blacklistedShopIds) {
      if (url.includes(shopId)) {
        const reason = `Product URL matches blacklisted provider shop: ${shopId}`;
        if (!options.dryRun) {
          await pool.execute(
            `UPDATE products SET status = 'skipped', skip_reason = ? WHERE id = ?`,
            [reason, prod.id]
          );
        }
        logger.info(`[PROVIDER] ${id1688}: blacklisted shop ${shopId}`, { title: title.substring(0, 60) });
        providerBlocked++;
        shopBlocked = true;
        break;
      }
    }
    if (shopBlocked) continue;

    passed++;
  }

  closeDatabase();

  logger.info('══════════════════════════════════════════');
  logger.info('Task 1B: Brand Pre-Filter Complete');
  logger.info(`  Total checked       : ${products.length}`);
  logger.info(`  Brand blocked       : ${brandBlocked} (isBannedBrand)`);
  logger.info(`  Pattern blocked     : ${patternBlocked} (suspicious keywords)`);
  logger.info(`  Violation blocked   : ${violationBlocked} (prior violations)`);
  logger.info(`  Provider blocked    : ${providerBlocked} (blacklisted sellers)`);
  logger.info(`  Passed              : ${passed}`);
  logger.info('══════════════════════════════════════════');
  if (options.dryRun) {
    logger.info('This was a dry run — no products were actually skipped');
  }
}

main().catch(err => {
  logger.error('Unhandled error', { error: err.message });
  closeDatabase();
  process.exit(1);
});
