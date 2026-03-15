/**
 * Task 7: Wangwang Outreach
 *
 * For each seller in compliance_contacts with status='pending', navigates to
 * their 1688 shop, opens the Wangwang IM chat, and sends a templated message
 * requesting compliance documents (Testing Report + REACH / OEKO-TEX cert).
 *
 * Each seller is contacted once, listing all their product IDs that need certs.
 * Status is updated to 'contacted' after the message is sent.
 *
 * Options:
 *   --dry-run   Compose and print messages but do NOT send
 *   --limit N   Process at most N sellers (default: all pending)
 *   --headless  Run in headless mode (not recommended — Wangwang may block)
 *
 * Usage: node dist/tasks/task7-wangwang-outreach.js [--dry-run] [--limit 5]
 * Runs on: China MacBook (logged-in 1688 session required)
 */

import { create1688Scraper } from '../scrapers/1688Scraper';
import {
  getPendingContacts,
  updateContactStatus,
  closeDatabase,
  getPool,
} from '../database/db';
import { createChildLogger } from '../utils/logger';
import { randomDelay } from '../utils/helpers';
import { RowDataPacket } from 'mysql2/promise';

const logger = createChildLogger('task7-wangwang-outreach');

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
 * Build the Chinese message requesting compliance documents.
 * Lists the 1688 product IDs (id_1688) so the seller knows exactly which products.
 */
async function buildMessage(productIds: number[]): Promise<string> {
  // Resolve internal IDs → 1688 product IDs for the seller to identify
  const p = await getPool();
  const placeholders = productIds.map(() => '?').join(',');
  const [rows] = await p.execute<RowDataPacket[]>(
    `SELECT id_1688 FROM products WHERE id IN (${placeholders})`,
    productIds
  );
  const id1688List = rows.map((r: any) => r.id_1688).join('、');

  return `您好！我是您的客户，在AliExpress平台上销售您的产品。

目前欧盟（EU）市场要求所有服装类产品必须提供以下文件，否则产品将在欧盟国家下架：
1. 产品检测报告（Testing Report）
2. REACH检测报告，或 OEKO-TEX Standard 100 认证证书

涉及的产品编号如下：
${id1688List}

如果您已有上述认证文件（例如OEKO-TEX证书编号或SGS报告），烦请发给我，非常感谢！

如暂时没有，也请告知，我们可以进一步讨论解决方案。

谢谢您的合作！`;
}

async function main(): Promise<void> {
  const options = parseArgs();
  logger.info('Task 7: Wangwang Outreach', options);

  // Load pending contacts
  let contacts = await getPendingContacts();
  if (options.limit > 0) contacts = contacts.slice(0, options.limit);

  logger.info(`Pending sellers to contact: ${contacts.length}`);

  if (contacts.length === 0) {
    logger.info('No pending contacts — run task6 first');
    closeDatabase();
    return;
  }

  if (options.dryRun) {
    logger.info('═══ DRY RUN — messages will be printed but NOT sent ═══');
    for (const contact of contacts) {
      const msg = await buildMessage(contact.productIds);
      logger.info(`\n── Seller: ${contact.sellerName} (${contact.sellerId})`);
      logger.info(`   Shop: ${contact.sellerUrl || '(no URL)'}`);
      logger.info(`   Wangwang: ${contact.wangwangId || '(no Wangwang ID)'}`);
      logger.info(`   Products: ${contact.productIds.join(', ')}`);
      logger.info(`   Message:\n${msg}`);
      logger.info('─────────────────────────────────────────');
    }
    closeDatabase();
    return;
  }

  // Live send mode
  const scraper = await create1688Scraper(options.headless);
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  try {
    const loggedIn = await scraper.login();
    if (!loggedIn) {
      logger.error('Failed to login to 1688.com — aborting');
      return;
    }

    for (const contact of contacts) {
      logger.info(`Processing seller: ${contact.sellerName} (${contact.sellerId})`);

      // Skip if no shop URL to navigate to
      if (!contact.sellerUrl) {
        logger.warn('  No seller URL — skipping', { sellerId: contact.sellerId });
        await updateContactStatus(contact.sellerId, 'no_certs', 'No shop URL available');
        skipped++;
        continue;
      }

      const message = await buildMessage(contact.productIds);

      const ok = await scraper.sendWangwangMessage(contact.sellerUrl, message);

      if (ok) {
        await updateContactStatus(contact.sellerId, 'contacted', 'Message sent via Wangwang');
        logger.info(`  ✓ Message sent to ${contact.sellerName}`);
        sent++;
      } else {
        logger.warn(`  ✗ Failed to send to ${contact.sellerName}`);
        failed++;
        // Don't update status — will retry on next run
      }

      // Human-paced delay between sellers (10–30 seconds) to avoid rate-limiting
      await randomDelay(10000, 30000);
    }

  } finally {
    await scraper.close();
    closeDatabase();
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  logger.info('══════════════════════════════════════════');
  logger.info('Task 7 Complete');
  logger.info(`  Sent     : ${sent}`);
  logger.info(`  Failed   : ${failed}`);
  logger.info(`  Skipped  : ${skipped}`);
  logger.info('══════════════════════════════════════════');
  if (failed > 0) {
    logger.info('Re-run to retry failed sellers (status remains "pending")');
  }
  logger.info('After sellers respond with certs → upload via AliExpress Compliance Diagnostics:');
  logger.info('  https://csp.aliexpress.com/m_apps/qualif/diagnosis?channelId=2087779');
}

main().catch(err => {
  logger.error('Unhandled error', { error: err.message });
  process.exit(1);
});
