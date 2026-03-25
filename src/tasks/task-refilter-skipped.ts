/**
 * task-refilter-skipped.ts — Re-evaluate products skipped by brand checks.
 *
 * After fixing isBannedBrand() to use letter-continuation lookaheads for
 * 4+ char ASCII keywords, some products were incorrectly blocked.
 * Confirmed false-positive brands: Marvel→marvelous, Canon→canonical,
 * Coach→coaching, Omega→omega-3, Fossil→fossil [stone], Honor→honor [word].
 *
 * This script:
 *   1. Finds products skipped with brand-related reasons
 *   2. Re-evaluates each skipped field (title, specs, variants) with updated logic
 *   3. Products that now pass → reset to 'discovered' for re-processing
 *   4. Products still failing → remain 'skipped' (skip_reason updated if changed)
 *
 * Usage:
 *   node dist/tasks/task-refilter-skipped.js [--dry-run] [--limit N]
 */

import { getPool } from '../database/db';
import { initBrandCache, isBannedBrand, getBannedBrandMatch } from '../utils/helpers';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('task-refilter-skipped');

const BRAND_SKIP_REASONS = [
  'Banned brand in specifications',
  'Banned brand in details',
  'Banned brand in title/description',
  'Banned brand in seller name',
];

const BRAND_SKIP_REASON_PREFIX = [
  'Banned brand in variant:',
];

interface SkippedProduct {
  id: number;
  id_1688: string;
  title_zh: string | null;
  skip_reason: string;
}

interface ProductRaw {
  title_zh: string | null;
  description_zh: string | null;
  seller_name: string | null;
  specifications_zh: Array<{ name: string; value: string }> | null;
}

interface VariantOption {
  name: string;
  values: string[];
}

interface VariantSku {
  optionValues: Record<string, string>;
}

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    limit: (() => {
      const i = args.indexOf('--limit');
      return i >= 0 ? parseInt(args[i + 1]) || 500 : 500;
    })(),
  };
}

async function getSkippedProducts(limit: number): Promise<SkippedProduct[]> {
  const pool = await getPool();
  // LIKE requires the wildcard in the param value — CONCAT(?, '%') doesn't work
  // with mysql2 prepared statements.
  const brandVariantCondition = BRAND_SKIP_REASON_PREFIX
    .map(() => `skip_reason LIKE ?`)
    .join(' OR ');

  // pool.execute() (prepared statements) can choke on LIMIT ? in some mysql2 versions.
  // Use pool.query() instead — same placeholder support, no prepared-statement caching issues.
  const [rows]: any = await pool.query(
    `SELECT id, id_1688, title_zh, skip_reason
     FROM products
     WHERE status = 'skipped'
       AND (
         skip_reason IN (${BRAND_SKIP_REASONS.map(() => '?').join(',')})
         OR ${brandVariantCondition}
       )
     ORDER BY id
     LIMIT ${Math.max(1, Math.floor(limit))}`,
    [
      ...BRAND_SKIP_REASONS,
      ...BRAND_SKIP_REASON_PREFIX.map(p => `${p}%`),
    ]
  );
  return rows;
}

async function getProductRaw(productId: number): Promise<ProductRaw | null> {
  const pool = await getPool();
  const [rows]: any = await pool.execute(
    `SELECT title_zh, description_zh, seller_name, specifications_zh
     FROM products_raw WHERE product_id = ?`,
    [productId]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  let specs: Array<{ name: string; value: string }> | null = null;
  try {
    specs = typeof row.specifications_zh === 'string'
      ? JSON.parse(row.specifications_zh)
      : row.specifications_zh;
  } catch { /* ignore */ }
  return { ...row, specifications_zh: specs };
}

async function getProductVariants(productId: number): Promise<{
  options: VariantOption[];
  skus: VariantSku[];
} | null> {
  const pool = await getPool();
  const [optRows]: any = await pool.execute(
    `SELECT option_name, option_value FROM products_variants_raw
     WHERE product_id = ? ORDER BY sort_order`,
    [productId]
  );
  if (optRows.length === 0) return null;

  // Group into options
  const optMap = new Map<string, string[]>();
  for (const row of optRows) {
    if (!optMap.has(row.option_name)) optMap.set(row.option_name, []);
    optMap.get(row.option_name)!.push(row.option_value);
  }
  const options: VariantOption[] = Array.from(optMap.entries()).map(([name, values]) => ({
    name,
    values: [...new Set(values)],
  }));

  // Build SKU option values from raw variant rows (each row is one dimension value)
  const skus: VariantSku[] = optRows.map((r: any) => ({
    optionValues: { [r.option_name]: r.option_value },
  }));

  return { options, skus };
}

const BRAND_SPEC_KEYS = ['品牌', '商标', 'brand', 'trademark'];

async function reEvaluateProduct(prod: SkippedProduct): Promise<{
  action: 'restore' | 'keep' | 'update';
  newReason?: string;
  triggeredBy?: string;
}> {
  // ── Step 1: Re-check title (fast, no DB join needed) ──────────────────────
  const titleCheck = prod.title_zh ? getBannedBrandMatch(prod.title_zh) : { matched: false };
  if (titleCheck.matched) {
    return {
      action: 'keep',
      triggeredBy: `title: ${titleCheck.brandName}`,
    };
  }

  // ── Step 2: Re-check raw detail data ──────────────────────────────────────
  const raw = await getProductRaw(prod.id);
  if (raw) {
    const descCheck = raw.description_zh ? getBannedBrandMatch(raw.description_zh) : { matched: false };
    if (descCheck.matched) {
      return { action: 'keep', triggeredBy: `description: ${descCheck.brandName}` };
    }

    const sellerCheck = raw.seller_name ? getBannedBrandMatch(raw.seller_name) : { matched: false };
    if (sellerCheck.matched) {
      return { action: 'keep', triggeredBy: `seller: ${sellerCheck.brandName}` };
    }

    // Spec check — only brand-declaration keys trigger value check
    if (raw.specifications_zh) {
      for (const spec of raw.specifications_zh) {
        if (isBannedBrand(spec.name)) {
          return { action: 'keep', triggeredBy: `spec key: ${spec.name}` };
        }
        const isBrandField = BRAND_SPEC_KEYS.some(k =>
          spec.name.toLowerCase().includes(k)
        );
        if (isBrandField) {
          const specValCheck = getBannedBrandMatch(spec.value);
          if (specValCheck.matched) {
            return { action: 'keep', triggeredBy: `spec value (${spec.name}): ${specValCheck.brandName}` };
          }
        }
      }
    }
  }

  // ── Step 3: Re-check variant data ─────────────────────────────────────────
  const variants = await getProductVariants(prod.id);
  if (variants) {
    for (const sku of variants.skus) {
      for (const [key, val] of Object.entries(sku.optionValues)) {
        const kCheck = getBannedBrandMatch(key);
        if (kCheck.matched) return { action: 'keep', triggeredBy: `variant key: ${kCheck.brandName}` };
        const vCheck = getBannedBrandMatch(val);
        if (vCheck.matched) return { action: 'keep', triggeredBy: `variant val: ${vCheck.brandName}` };
      }
    }
    for (const opt of variants.options) {
      if (isBannedBrand(opt.name)) return { action: 'keep', triggeredBy: `option name: ${opt.name}` };
      for (const v of opt.values) {
        const vCheck = getBannedBrandMatch(v);
        if (vCheck.matched) return { action: 'keep', triggeredBy: `option value: ${vCheck.brandName}` };
      }
    }
  }

  // ── Passed all checks — false positive confirmed ───────────────────────────
  // If products_raw has NO data (was never saved before the skip), we can still
  // restore to 'discovered' — Task 2 will re-scrape and re-check with new logic.
  return { action: 'restore' };
}

async function main() {
  const { dryRun, limit } = parseArgs();
  const pool = await getPool(); // initialises DB schema on first call

  await initBrandCache();

  logger.info('Task: Re-filter brand-skipped products', {
    dryRun,
    limit,
    mode: dryRun ? 'DRY RUN — no DB writes' : 'LIVE',
  });

  const products = await getSkippedProducts(limit);
  logger.info(`Found ${products.length} brand-skipped products to re-evaluate`);

  let restored = 0;
  let kept = 0;
  let errors = 0;

  for (const prod of products) {
    try {
      const result = await reEvaluateProduct(prod);

      if (result.action === 'restore') {
        logger.info('FALSE POSITIVE confirmed — restoring to discovered', {
          id: prod.id,
          id_1688: prod.id_1688,
          title: prod.title_zh?.substring(0, 60),
          wasReason: prod.skip_reason,
        });
        if (!dryRun) {
          await (await getPool()).execute(
            `UPDATE products SET status = 'discovered', skip_reason = NULL WHERE id = ?`,
            [prod.id]
          );
        }
        restored++;
      } else {
        logger.debug('Still blocked — keeping skipped', {
          id: prod.id,
          triggeredBy: result.triggeredBy,
        });
        kept++;
      }
    } catch (err) {
      logger.warn('Error re-evaluating product', {
        id: prod.id,
        error: (err as Error).message,
      });
      errors++;
    }
  }

  logger.info('Re-filter complete', {
    total: products.length,
    restored,
    kept,
    errors,
    dryRun,
  });

  if (dryRun && restored > 0) {
    logger.info(`DRY RUN: would restore ${restored} products. Re-run without --dry-run to apply.`);
  }

  pool.end();
}

main().catch(err => {
  logger.error('Fatal error', { error: err.message });
  process.exit(1);
});
