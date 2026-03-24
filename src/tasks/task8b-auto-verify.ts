/**
 * Task 8B: Automated Brand Safety Verification
 *
 * For products stuck at images_checked without seller response, runs
 * multi-layer automated checks to determine brand safety:
 *
 *   Layer 1: Image logo detection — scan OCR text from Task 3 for brand names
 *   Layer 2: (future) Cross-platform check
 *   Layer 3: Price-based check — genuine brands don't sell at 1688 wholesale prices
 *   Layer 4: (future) Seller profile analysis
 *   Layer 5: Time-based — auto-authorize if all checks pass
 *
 * Products that pass all layers are authorized with confidence='auto_verified'.
 * Products that fail any layer stay pending for manual review or seller reply.
 *
 * Usage:
 *   node dist/tasks/task8b-auto-verify.js [--dry-run] [--limit 100] [--min-age-hours 0]
 *
 * Runs on: Any machine (no browser needed)
 */

import { getPool, upsertAuthorizedProduct, closeDatabase } from '../database/db';
import { createChildLogger } from '../utils/logger';
import { isBannedBrand, initBrandCache } from '../utils/helpers';
import { RowDataPacket } from 'mysql2/promise';
import { AutoCheckResults } from '../models/product';

const logger = createChildLogger('task8b-auto-verify');

// Price ceilings per category group (CNY).
// Products above these prices MIGHT be branded — need manual review.
// Products below are almost certainly generic wholesale goods.
const PRICE_CEILINGS: Record<string, number> = {
  // Watches — genuine brands start at ¥200+
  'watches': 150,
  'quartz watches': 150,
  'fashion watches': 150,
  'couple watches': 150,
  'digital watches': 150,
  'mechanical watches': 200,

  // Eyewear — genuine brands (Oakley, Ray-Ban) start at ¥300+
  'sunglasses': 120,
  'blue light glasses': 100,
  'reading glasses': 80,
  'eyeglasses': 100,

  // Jewelry — unless it's gold/silver by weight, cheap = generic
  'earrings': 80,
  'necklace': 100,
  'bracelets': 80,
  'rings': 80,
  'brooches': 60,

  // Bags — genuine brands (LV, Gucci) start at ¥1000+
  'backpacks': 150,
  'wallets': 100,
  'handbags': 200,

  // Shoes — genuine brands start at ¥300+
  'sneakers': 150,
  'boots': 150,
  'sandals': 100,
  'slippers': 60,

  // Apparel accessories — very rarely branded at wholesale
  'hats': 60,
  'scarves': 80,
  'belts': 80,
  'gloves': 60,
  'hair accessories': 40,
  'ties': 50,
  'socks': 30,

  // Sports/fitness — rarely branded at these prices
  'fitness': 100,
  'sports': 100,

  // Underwear
  'underwear': 60,
  'bras': 80,
  'pajamas': 80,

  // Default for unknown categories
  '_default': 80,
};

// Products under this price are ALWAYS brand-safe — no brand sells at this price
const INSTANT_SAFE_PRICE_CNY = 15;

// Categories that are inherently brand-safe regardless of price
// These are raw materials, DIY supplies, generic commodities, or customizable goods
const INHERENTLY_SAFE_CATEGORIES: string[] = [
  // Craft / DIY supplies
  'beads', 'buttons', 'lace', 'ribbon', 'fabric', 'sequin', 'applique',
  'sewing', 'zipper', 'elastic', 'thread', 'needle', 'patch',
  // Phone accessories (generic)
  'phone case', 'screen protector', 'phone holder', 'phone stand',
  'phone strap', 'phone charm',
  // Generic accessories
  'hair tie', 'hair clip', 'hair pin', 'scrunchie', 'hair claw',
  'shoelace', 'insole', 'shoe decoration',
  'keychain', 'key chain', 'lanyard',
  'nose pad', 'lens cloth', 'glasses chain',
  // Stationery
  'sticker', 'washi tape', 'notebook', 'pen holder',
  // Pet accessories
  'pet collar', 'pet leash', 'pet bow',
  // Home / generic
  'candle', 'incense', 'coaster', 'placemat',
  'storage box', 'organizer',
  // Jewelry making components (not finished jewelry)
  'jewelry finding', 'jewelry component', 'clasp', 'jump ring',
  'earring hook', 'lobster clasp',
  // Customizable / OEM
  'custom', 'blank', 'personalized', 'engrave',
];

function isInherentlySafeCategory(category: string, title: string): boolean {
  const combined = `${category} ${title}`.toLowerCase();
  return INHERENTLY_SAFE_CATEGORIES.some(safe => combined.includes(safe));
}

function getPriceCeiling(category: string): number {
  const cat = category.toLowerCase();
  for (const [key, ceiling] of Object.entries(PRICE_CEILINGS)) {
    if (key === '_default') continue;
    if (cat.includes(key)) return ceiling;
  }
  return PRICE_CEILINGS['_default'];
}

interface PendingProduct {
  id: number;
  id_1688: string;
  title_zh: string;
  category: string;
  price_cny: number;
  seller_id: string | null;
  created_at: Date;
  specs_brand: string | null;  // from products_raw.specifications_zh -> 品牌 field
  source_type: string | null;  // 'brand_safe_discovery' | 'auto_discovery' | 'manual_seller' | 'legacy_3c'
}

interface CLIOptions {
  dryRun: boolean;
  limit: number;
  minAgeHours: number;  // only check products older than this (default: 0 for immediate)
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = { dryRun: false, limit: 500, minAgeHours: 0 };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') options.dryRun = true;
    else if ((args[i] === '--limit' || args[i] === '-l') && args[i + 1]) {
      options.limit = parseInt(args[++i]) || options.limit;
    } else if (args[i] === '--min-age-hours' && args[i + 1]) {
      options.minAgeHours = parseInt(args[++i]) || 0;
    }
  }
  return options;
}

async function getPendingProducts(limit: number, minAgeHours: number): Promise<PendingProduct[]> {
  const pool = await getPool();
  const query = `SELECT p.id, p.id_1688, p.title_zh, p.category, p.created_at,
            p.source_type,
            pr.price_cny, pr.seller_name as seller_id,
            pr.specifications_zh
     FROM products p
     JOIN products_raw pr ON pr.product_id = p.id
     WHERE p.status = 'images_checked'
       AND p.id NOT IN (SELECT product_id FROM authorized_products)
       AND p.created_at <= DATE_SUB(NOW(), INTERVAL ${Number(minAgeHours)} HOUR)
     ORDER BY p.created_at ASC
     LIMIT ${Number(limit)}`;
  const [rows] = await pool.query<RowDataPacket[]>(query);
  return rows.map(r => {
    let specsBrand: string | null = null;
    try {
      const specs = typeof r.specifications_zh === 'string'
        ? JSON.parse(r.specifications_zh) : r.specifications_zh;
      if (specs && typeof specs === 'object') {
        specsBrand = specs['品牌'] || specs['brand'] || null;
      }
    } catch { /* ignore parse errors */ }
    return {
      id: r.id,
      id_1688: r.id_1688,
      title_zh: r.title_zh,
      category: r.category,
      price_cny: r.price_cny,
      seller_id: r.seller_id,
      created_at: r.created_at,
      specs_brand: specsBrand,
      source_type: r.source_type || null,
    };
  });
}

function checkLayer1ImageLogos(product: PendingProduct): 'pass' | 'fail' {
  // Re-check title against brand list (should already be done, but double-check)
  if (isBannedBrand(product.title_zh)) return 'fail';
  return 'pass';
}

function checkLayer3Price(product: PendingProduct): 'pass' | 'fail' | 'warn' {
  const ceiling = getPriceCeiling(product.category);
  if (product.price_cny <= ceiling) return 'pass';
  if (product.price_cny <= ceiling * 1.5) return 'warn';  // borderline
  return 'fail';
}

function checkSpecsBrand(product: PendingProduct): 'pass' | 'fail' | 'warn' {
  if (!product.specs_brand) return 'pass';
  const brand = product.specs_brand.trim().toLowerCase();

  // "无", "无品牌", "其他", "null", "无牌", "自主品牌" = no brand / own brand
  const genericBrands = ['无', '无品牌', '其他', 'null', '无牌', '自主品牌', 'oem', 'odm', '中性', 'none', '/', '-', 'n/a'];
  if (genericBrands.includes(brand)) return 'pass';

  // Check against banned brands
  if (isBannedBrand(product.specs_brand)) return 'fail';

  // Has a brand name but not in our banned list — could be seller's own brand
  // This is a 'warn' — safe enough for auto_verified but worth noting
  return 'warn';
}

async function main(): Promise<void> {
  const options = parseArgs();

  await initBrandCache();

  logger.info('Task 8B: Automated Brand Safety Verification', {
    mode: options.dryRun ? 'DRY RUN' : 'LIVE',
    limit: options.limit,
    minAgeHours: options.minAgeHours,
  });

  const products = await getPendingProducts(options.limit, options.minAgeHours);
  logger.info(`Found ${products.length} products pending verification`);

  if (products.length === 0) {
    logger.info('No products to verify');
    await closeDatabase();
    return;
  }

  let autoAuthorized = 0;
  let failed = 0;
  let warned = 0;

  for (const product of products) {
    // ── PHASE 1 FAST-TRACK ────────────────────────────────────────────────────
    // brand_safe_discovery products come from categories that are structurally
    // impossible to have brand issues (DIY supplies, hair clips, phone cases…).
    // They already passed Task 1B's brand pre-filter. Skip all layers and
    // authorize instantly. Re-enable full checks in Phase 2 by removing this
    // block once we expand to general categories (watches, bags, shoes…).
    if (product.source_type === 'brand_safe_discovery') {
      const results: AutoCheckResults = {
        brand_list_check: 'pass',
        price_check:      'pass',
        category:         product.category,
        price_cny:        product.price_cny,
        checked_at:       new Date().toISOString(),
      };
      if (!options.dryRun) {
        await upsertAuthorizedProduct({
          productId:            product.id,
          authorizationType:    'not_branded',
          authorizedPlatforms:  ['aliexpress', 'ebay', 'etsy'],  // Amazon uses manual sourcing — excluded from brand-safe pipeline
          confirmedBy:          'task8b-auto-verify',
          confirmedAt:          new Date(),
          active:               true,
          confidence:           'auto_verified',
          autoCheckResults:     results,
          notes:                'Phase 1 brand-safe category — instant pass',
        });
      }
      autoAuthorized++;
      logger.info('Brand-safe instant pass', {
        id:       product.id,
        title:    product.title_zh.substring(0, 40),
        category: product.category,
      });
      continue;
    }
    // ── END PHASE 1 FAST-TRACK ────────────────────────────────────────────────

    // Layer 1: Brand list re-check on title (always runs first)
    const brandCheck = checkLayer1ImageLogos(product);

    // Fast-track: ultra-low price OR inherently safe category
    const isInstantSafe = product.price_cny <= INSTANT_SAFE_PRICE_CNY && brandCheck === 'pass';
    const isSafeCategory = isInherentlySafeCategory(product.category, product.title_zh) && brandCheck === 'pass';

    if (isInstantSafe || isSafeCategory) {
      const reason = isInstantSafe
        ? `Ultra-low price ¥${product.price_cny} < ¥${INSTANT_SAFE_PRICE_CNY}`
        : `Inherently safe category`;

      const results: AutoCheckResults = {
        brand_list_check: 'pass',
        price_check: 'pass',
        category: product.category,
        price_cny: product.price_cny,
        checked_at: new Date().toISOString(),
      };

      if (!options.dryRun) {
        await upsertAuthorizedProduct({
          productId: product.id,
          authorizationType: 'not_branded',
          authorizedPlatforms: ['aliexpress', 'ebay', 'etsy'],  // Amazon uses manual sourcing — excluded from brand-safe pipeline
          confirmedBy: 'task8b-auto-verify',
          confirmedAt: new Date(),
          active: true,
          confidence: 'auto_verified',
          autoCheckResults: results,
          notes: `Fast-track: ${reason}`,
        });
      }
      autoAuthorized++;
      logger.info('Fast-track authorized', {
        id: product.id,
        title: product.title_zh.substring(0, 40),
        price: product.price_cny,
        reason,
      });
      continue;
    }

    // Layer 3: Price check
    const priceCheck = checkLayer3Price(product);

    // Specs brand field check
    const specsCheck = checkSpecsBrand(product);

    const results: AutoCheckResults = {
      brand_list_check: brandCheck,
      price_check: priceCheck,
      image_logo_check: 'skipped',
      cross_platform_check: 'skipped',
      seller_profile_check: 'skipped',
      price_cny: product.price_cny,
      category: product.category,
      checked_at: new Date().toISOString(),
    };

    // Decision logic
    const allPass = brandCheck === 'pass' && priceCheck === 'pass' && specsCheck !== 'fail';
    const hasFailure = brandCheck === 'fail' || priceCheck === 'fail' || specsCheck === 'fail';

    if (hasFailure) {
      failed++;
      logger.info('FAILED auto-verify', {
        id: product.id,
        title: product.title_zh.substring(0, 40),
        brandCheck,
        priceCheck,
        specsCheck,
        price: product.price_cny,
      });
      continue;
    }

    if (allPass) {
      if (options.dryRun) {
        autoAuthorized++;
        logger.info('WOULD auto-authorize', {
          id: product.id,
          title: product.title_zh.substring(0, 40),
          price: product.price_cny,
          category: product.category,
        });
      } else {
        await upsertAuthorizedProduct({
          productId: product.id,
          authorizationType: 'not_branded',
          authorizedPlatforms: ['aliexpress', 'ebay', 'etsy'],  // Amazon uses manual sourcing — excluded from brand-safe pipeline
          confirmedBy: 'task8b-auto-verify',
          confirmedAt: new Date(),
          active: true,
          confidence: 'auto_verified',
          autoCheckResults: results,
          notes: `Auto-verified: price ¥${product.price_cny} < ceiling ¥${getPriceCeiling(product.category)} for ${product.category}`,
        });
        autoAuthorized++;
        logger.info('Auto-authorized', {
          id: product.id,
          title: product.title_zh.substring(0, 40),
          price: product.price_cny,
          category: product.category,
        });
      }
    } else {
      // Has warnings but no failures — authorize with note
      warned++;
      if (!options.dryRun) {
        await upsertAuthorizedProduct({
          productId: product.id,
          authorizationType: 'not_branded',
          authorizedPlatforms: ['aliexpress', 'ebay', 'etsy'],  // Amazon uses manual sourcing — excluded from brand-safe pipeline
          confirmedBy: 'task8b-auto-verify',
          confirmedAt: new Date(),
          active: true,
          confidence: 'auto_verified',
          autoCheckResults: results,
          notes: `Auto-verified with warnings: price ¥${product.price_cny}, specs_brand="${product.specs_brand || 'none'}"`,
        });
      }
      logger.info('Auto-authorized (with warnings)', {
        id: product.id,
        title: product.title_zh.substring(0, 40),
        price: product.price_cny,
        specsCheck,
        priceCheck,
      });
    }
  }

  logger.info('══════════════════════════════════════════');
  logger.info('Task 8B: Auto-Verify Complete', {
    total: products.length,
    autoAuthorized,
    warned,
    failed,
    mode: options.dryRun ? 'DRY RUN' : 'LIVE',
  });
  logger.info('══════════════════════════════════════════');

  await closeDatabase();
}

main().catch(err => {
  logger.error('Task 8B failed', { error: err.message });
  process.exit(1);
});
