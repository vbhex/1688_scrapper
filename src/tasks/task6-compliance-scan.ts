/**
 * Task 6: Compliance Scan
 *
 * Visits each 1688 source product page (status = 'ae_enriched') and:
 * 1. Extracts extended seller info (Wangwang ID, shop URL, seller ID)
 * 2. Scans the product description for compliance certificates
 *    (OEKO-TEX, REACH, SGS, GOTS, ISO, CE, etc.)
 * 3. Saves results to:
 *    - products_raw (seller_id, seller_shop_url, seller_wangwang_id columns)
 *    - compliance_certs table (one row per cert per product)
 *    - compliance_contacts table (one row per unique seller — deduped)
 *
 * Sellers with no certs found are flagged for Wangwang outreach (task7).
 *
 * Usage: node dist/tasks/task6-compliance-scan.js [--limit 50] [--headless]
 * Runs on: China MacBook (inside China firewall, logged-in 1688 session)
 */

import { create1688Scraper } from '../scrapers/1688Scraper';
import {
  getProductsForComplianceScan,
  saveSellerInfoOnRaw,
  saveComplianceCert,
  saveSellerContact,
  closeDatabase,
} from '../database/db';
import { createChildLogger } from '../utils/logger';
import { sleep, randomDelay } from '../utils/helpers';

const logger = createChildLogger('task6-compliance-scan');

interface CLIOptions {
  limit: number;
  headless: boolean;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = { limit: 0, headless: false };

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--limit' || args[i] === '-l') && args[i + 1]) {
      options.limit = parseInt(args[++i]) || 0;
    } else if (args[i] === '--headless') {
      options.headless = true;
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs();
  logger.info('Task 6: Compliance Scan', options);

  // Fetch products not yet scanned
  const products = await getProductsForComplianceScan(options.limit || undefined);
  logger.info(`Found ${products.length} products to scan`);

  if (products.length === 0) {
    logger.info('Nothing to scan — all ae_enriched products already have seller info');
    closeDatabase();
    return;
  }

  const scraper = await create1688Scraper(options.headless);

  // Stats
  let scanned = 0;
  let certsFound = 0;
  let failed = 0;
  const certTypeSummary: Record<string, number> = {};
  // seller_id → productIds collected so far (for compliance_contacts dedup)
  const sellerProductMap = new Map<string, { name: string; wangwangId: string; shopUrl: string; productIds: number[] }>();

  try {
    const loggedIn = await scraper.login();
    if (!loggedIn) {
      logger.error('Failed to login to 1688.com — aborting');
      return;
    }

    for (const product of products) {
      logger.info(`Scanning ${scanned + 1}/${products.length}: ${product.id1688}`, { url: product.url });

      try {
        // Navigate to the 1688 product page
        await scraper['page'].goto(product.url, { waitUntil: 'networkidle2', timeout: 60000 });
        await randomDelay(2000, 4000);

        // 1. Extract seller info
        const seller = await scraper.getSellerInfo();
        logger.debug('Seller info', seller);

        // Save seller columns to products_raw
        await saveSellerInfoOnRaw(product.id, seller.sellerId, seller.shopUrl, seller.wangwangId);

        // 2. Scan for certs
        const certs = await scraper.scanProductCerts(product.url);
        logger.info(`  Certs found: ${certs.length}`, {
          types: certs.map(c => c.certType).join(', ') || 'none',
        });

        for (const cert of certs) {
          await saveComplianceCert(
            product.id,
            cert.certType,
            cert.certNumber,
            cert.imageUrl,
            cert.sourceUrl
          );
          certsFound++;
          certTypeSummary[cert.certType] = (certTypeSummary[cert.certType] || 0) + 1;
        }

        // 3. Group into compliance_contacts by seller
        if (seller.sellerId) {
          if (!sellerProductMap.has(seller.sellerId)) {
            sellerProductMap.set(seller.sellerId, {
              name: seller.name,
              wangwangId: seller.wangwangId || '',
              shopUrl: seller.shopUrl || '',
              productIds: [],
            });
          }
          sellerProductMap.get(seller.sellerId)!.productIds.push(product.id);
        }

        scanned++;
        logger.info(`  ✓ Scanned (${scanned}/${products.length})`);

      } catch (err) {
        logger.error(`Failed to scan product ${product.id1688}`, { error: (err as Error).message });
        failed++;
      }

      // Human-paced delay between products
      await randomDelay(3000, 7000);
    }

    // Persist compliance_contacts (one upsert per unique seller)
    logger.info(`Persisting ${sellerProductMap.size} seller contacts...`);
    for (const [sellerId, info] of sellerProductMap.entries()) {
      await saveSellerContact(sellerId, info.name, info.wangwangId, info.shopUrl, info.productIds);
    }

  } finally {
    await scraper.close();
    closeDatabase();
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  logger.info('══════════════════════════════════════════');
  logger.info(`Task 6 Complete`);
  logger.info(`  Products scanned : ${scanned}`);
  logger.info(`  Certs found      : ${certsFound}`);
  for (const [type, count] of Object.entries(certTypeSummary)) {
    logger.info(`    ${type}: ${count}`);
  }
  logger.info(`  Failed           : ${failed}`);
  logger.info(`  Unique sellers   : ${sellerProductMap.size}`);
  logger.info(`  Sellers pending Wangwang outreach: ${
    [...sellerProductMap.entries()].filter(
      ([, info]) => info.wangwangId
    ).length
  }`);
  logger.info('══════════════════════════════════════════');
  logger.info('Next step: node dist/tasks/task7-wangwang-outreach.js --dry-run');
}

main().catch(err => {
  logger.error('Unhandled error', { error: err.message });
  process.exit(1);
});
