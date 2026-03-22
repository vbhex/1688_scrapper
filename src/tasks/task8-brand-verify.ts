/**
 * Task 8: Brand Verification Outreach
 *
 * For products that passed automated brand check (isBannedBrand) but are NOT
 * yet in authorized_products, contacts the 1688 seller via Wangwang to ask:
 *   1. Is this product a branded product?
 *   2. If you own the brand, can you provide authorization?
 *   3. If it's not branded / generic, please confirm.
 *
 * Products from providers with trust_level='preferred' are auto-authorized.
 * Products from providers with trust_level='blacklisted' are auto-skipped.
 *
 * Usage:
 *   node dist/tasks/task8-brand-verify.js [--dry-run] [--limit 10] [--headless]
 *
 * Runs on: China MacBook (logged-in 1688 session required)
 */

import { create1688Scraper } from '../scrapers/1688Scraper';
import {
  getProductsPendingBrandVerification,
  getProviderByPlatformId,
  upsertProvider,
  upsertAuthorizedProduct,
  saveSellerContact,
  updateContactStatus,
  closeDatabase,
  getPool,
} from '../database/db';
import { createChildLogger } from '../utils/logger';
import { randomDelay } from '../utils/helpers';
import { RowDataPacket } from 'mysql2/promise';

const logger = createChildLogger('task8-brand-verify');

interface CLIOptions {
  dryRun: boolean;
  limit: number;
  headless: boolean;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = { dryRun: false, limit: 0, headless: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') options.dryRun = true;
    else if ((args[i] === '--limit' || args[i] === '-l') && args[i + 1]) {
      options.limit = parseInt(args[++i]) || 0;
    } else if (args[i] === '--headless') {
      options.headless = true;
    }
  }
  return options;
}

/**
 * Build the combined Chinese message for:
 *   (1) Brand verification — is this product branded?
 *   (2) Compliance certs — testing report, REACH/OEKO-TEX, and platform-specific certs
 *
 * One conversation instead of two separate outreaches. More professional and efficient.
 * Lists 1688 product IDs so the seller knows exactly which products we're asking about.
 */
async function buildBrandVerifyMessage(productIds: number[]): Promise<string> {
  const p = await getPool();
  const placeholders = productIds.map(() => '?').join(',');
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT id_1688, url FROM products WHERE id IN (${placeholders})`,
    productIds
  );
  const productLines = rows.map((r: any) => `  • ${r.id_1688} — ${r.url}`).join('\n');

  return `老板你好，我做跨境的，在速卖通上卖货。看了你家这几个产品，想拿来上架：
${productLines}
想确认下：这几款是有品牌的吗？还是无牌通用款？如果是你们自己的牌子，能给个授权吗？平台查得严，没授权不敢上。
另外如果有质检报告、REACH或者OEKO-TEX之类的认证，也麻烦发一下，上架审核用得到。没有的话也没事，我们再聊。谢谢！`;
}

async function main(): Promise<void> {
  const options = parseArgs();
  logger.info('Task 8: Brand Verification Outreach', options);

  // Get products needing brand verification
  const products = await getProductsPendingBrandVerification(options.limit || undefined);
  if (products.length === 0) {
    logger.info('No products pending brand verification');
    closeDatabase();
    return;
  }

  logger.info(`Found ${products.length} products pending brand verification`);

  // Group products by seller for batch messaging
  const sellerGroups = new Map<string, {
    sellerName: string;
    wangwangId: string;
    shopUrl: string;
    productUrl: string;  // 1688 product page URL — more reliable for finding Wangwang button
    productIds: number[];
    productId1688s: string[];
  }>();

  let autoAuthorized = 0;
  let autoSkipped = 0;

  for (const prod of products) {
    const sellerId = prod.sellerId;
    if (!sellerId) {
      logger.warn(`Product ${prod.id1688} has no seller_id — needs Task 6 first`);
      continue;
    }

    // Check provider trust level
    const provider = await getProviderByPlatformId('1688', sellerId);

    // Auto-authorize products from preferred providers
    if (provider && provider.trustLevel === 'preferred') {
      try {
        await upsertAuthorizedProduct({
          productId: prod.id,
          authorizationType: 'not_branded',
          authorizedPlatforms: ['aliexpress', 'amazon'],
          providerId: provider.id,
          confirmedBy: 'auto',
          confirmedAt: new Date(),
          active: true,
          notes: `Auto-authorized: provider "${provider.providerName}" is preferred (trust_level=preferred)`,
        });
        autoAuthorized++;
        logger.info(`Auto-authorized from preferred provider`, { id: prod.id1688, provider: provider.providerName });
      } catch (err: any) {
        logger.warn('Failed to auto-authorize', { id: prod.id1688, error: err.message });
      }
      continue;
    }

    // Skip products from blacklisted providers
    if (provider && provider.trustLevel === 'blacklisted') {
      autoSkipped++;
      logger.info(`Skipping blacklisted provider`, { id: prod.id1688, provider: provider.providerName });
      continue;
    }

    // Group by seller for batch messaging
    if (!sellerGroups.has(sellerId)) {
      // Build shop URL: prefer DB value, fallback to 1688 convention
      const shopUrl = prod.sellerShopUrl
        || `https://shop${sellerId}.1688.com/`
        || '';

      sellerGroups.set(sellerId, {
        sellerName: prod.sellerName || 'Unknown',
        wangwangId: prod.sellerWangwangId || '',
        shopUrl,
        productUrl: prod.url || '',  // 1688 product detail page — has reliable Wangwang button
        productIds: [],
        productId1688s: [],
      });
    }
    sellerGroups.get(sellerId)!.productIds.push(prod.id);
    sellerGroups.get(sellerId)!.productId1688s.push(prod.id1688);
  }

  logger.info(`Auto-authorized: ${autoAuthorized}, Auto-skipped (blacklisted): ${autoSkipped}`);
  logger.info(`Sellers to contact: ${sellerGroups.size}`);

  if (sellerGroups.size === 0) {
    logger.info('No sellers to contact — all handled automatically');
    closeDatabase();
    return;
  }

  // Send Wangwang messages (or dry-run)
  let contacted = 0;
  let messageFailed = 0;

  if (!options.dryRun) {
    const scraper = await create1688Scraper(options.headless);
    try {
      const loggedIn = await scraper.login();
      if (!loggedIn) {
        logger.error('Failed to login to 1688.com — aborting');
        return;
      }

      for (const [sellerId, info] of sellerGroups.entries()) {
        logger.info(`Contacting seller: ${info.sellerName} (${sellerId})`, {
          products: info.productId1688s.length,
          wangwangId: info.wangwangId || 'unknown',
        });

        try {
          if (!info.shopUrl) {
            logger.warn(`  Skipping seller ${sellerId} — no shop URL available`);
            messageFailed++;
            continue;
          }

          const message = await buildBrandVerifyMessage(info.productIds);

          // Ensure seller exists in compliance_contacts
          await saveSellerContact(
            sellerId, info.sellerName, info.wangwangId, info.shopUrl, info.productIds
          );

          // Send via Wangwang — pass seller login ID directly
          // The scraper builds the direct Wangwang web IM URL from the seller ID
          const sent = await scraper.sendWangwangMessage(sellerId, message);
          if (sent) {
            await updateContactStatus(sellerId, 'contacted', 'Brand verification + cert request sent (Task 8)');
            contacted++;
            logger.info(`  ✓ Message sent to ${info.sellerName}`);
          } else {
            logger.warn(`  ✗ sendWangwangMessage returned false for ${info.sellerName}`);
            messageFailed++;
          }

        } catch (err: any) {
          logger.error(`  ✗ Failed to contact seller ${sellerId}`, { error: err.message });
          messageFailed++;
        }

        // Human-paced delay between sellers
        await randomDelay(5000, 10000);
      }

      await scraper.close();
    } catch (err) {
      logger.error('Browser error', { error: (err as Error).message });
    }
  } else {
    // Dry run: just print messages
    for (const [sellerId, info] of sellerGroups.entries()) {
      const message = await buildBrandVerifyMessage(info.productIds);
      logger.info(`[DRY RUN] Would send to ${info.sellerName} (${sellerId}):`, {
        wangwangId: info.wangwangId,
        productCount: info.productIds.length,
      });
      console.log('─'.repeat(60));
      console.log(message);
      console.log('─'.repeat(60));
      contacted++;
    }
  }

  closeDatabase();

  // Summary
  logger.info('══════════════════════════════════════════');
  logger.info('Task 8: Brand Verification Complete');
  logger.info(`  Products pending    : ${products.length}`);
  logger.info(`  Auto-authorized     : ${autoAuthorized} (preferred providers)`);
  logger.info(`  Auto-skipped        : ${autoSkipped} (blacklisted providers)`);
  logger.info(`  Sellers contacted   : ${contacted}`);
  logger.info(`  Contact failures    : ${messageFailed}`);
  logger.info('══════════════════════════════════════════');
  if (options.dryRun) {
    logger.info('This was a dry run — no messages were actually sent');
    logger.info('Run without --dry-run to send messages');
  }
}

main().catch(err => {
  logger.error('Unhandled error', { error: err.message });
  closeDatabase();
  process.exit(1);
});
