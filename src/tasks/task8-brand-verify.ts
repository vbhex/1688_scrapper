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

  return `您好！我们在AliExpress和Amazon等海外平台上长期销售产品。为确保合规，想跟您确认以下产品的相关信息：

${productLines}

═══ 一、品牌确认 ═══
1. 以上产品是否为品牌产品？如果是，品牌名称是什么？
2. 如果是贵公司自有品牌，能否提供品牌授权书，让我们合法在海外平台销售？
3. 如果是非品牌/通用产品（OEM/ODM），请确认即可。
⚠️ 这非常重要——海外平台销售未授权品牌产品，店铺会被严重处罚甚至关闭。

═══ 二、合规认证文件 ═══
海外各市场对产品合规有严格要求，如有以下文件请一并发给我们：

📋 通用（所有平台需要）：
  • 产品检测报告（Testing Report，如SGS、TUV、Intertek等）
  • REACH检测报告 或 OEKO-TEX Standard 100 认证

🇪🇺 欧盟市场（CE认证）：
  • CE认证证书（如适用）

🇬🇧 英国市场：
  • UKCA认证（如适用）

🇺🇸 美国市场：
  • FCC ID（电子类产品）
  • CPSIA认证（儿童类产品）
  • RoHS报告（如有）

如暂时没有上述文件，也请告知，我们可以进一步讨论解决方案。
有任何文件可直接通过旺旺发送，或发到邮箱也可以。

感谢您的合作！期待您的回复 🙏`;
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

          // Send via Wangwang — pass shop URL (scraper navigates to shop, clicks Wangwang chat)
          const sent = await scraper.sendWangwangMessage(info.shopUrl, message);
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
