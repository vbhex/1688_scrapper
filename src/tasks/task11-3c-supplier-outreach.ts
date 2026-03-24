/**
 * Task 11: 3C Supplier Outreach via Wangwang (Amazon Brand Authorization)
 *
 * Contacts 3C suppliers discovered by Task 10 via Wangwang IM.
 * Asks if they have their own brand and can provide brand authorization (品牌授权书)
 * for selling on Amazon.
 *
 * Does NOT share company info in initial message — that comes in Task 12
 * after the seller agrees to authorize.
 *
 * Usage:
 *   node dist/tasks/task11-3c-supplier-outreach.js [--limit 10] [--dry-run] [--headless]
 *
 * Runs on: China MacBook (logged-in 1688 session required for Wangwang)
 */

import { create1688Scraper } from '../scrapers/1688Scraper';
import {
  getProvidersForOutreach,
  saveSellerContact,
  updateContactStatus,
  closeDatabase,
  getPool,
} from '../database/db';
import { createChildLogger } from '../utils/logger';
import { randomDelay } from '../utils/helpers';
import { RowDataPacket } from 'mysql2/promise';

const logger = createChildLogger('task11-3c-outreach');

interface CLIOptions {
  limit: number;
  dryRun: boolean;
  headless: boolean;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = { limit: 10, dryRun: false, headless: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') options.dryRun = true;
    else if (args[i] === '--headless') options.headless = true;
    else if ((args[i] === '--limit' || args[i] === '-l') && args[i + 1]) {
      options.limit = parseInt(args[++i]) || 10;
    }
  }
  return options;
}

/**
 * Build the initial outreach message for Amazon brand authorization.
 * Does NOT include company info — that's shared only after seller agrees.
 *
 * ONE message per seller. Professional B2B Chinese tone.
 * NEVER mention email — off-platform communication violates 1688 rules.
 */
function buildOutreachMessage(storeName: string, categories: string[]): string {
  const categoryDesc = categories.length > 0
    ? categories.map(c => {
        const labels: Record<string, string> = {
          'earphones': '蓝牙耳机',
          'smart watches': '智能手表',
          'action cameras': '运动相机',
          'portable projector': '投影仪',
          'vr glasses': 'VR眼镜',
          'power station': '户外电源',
          'ip camera': '摄像头',
          'smart doorbell': '智能门铃',
          'soundbar': '音响',
          'solar panel': '太阳能板',
          'gimbal stabilizer': '稳定器',
          'lavalier microphone': '麦克风',
          'smart ring': '智能戒指',
        };
        return labels[c] || c;
      }).join('、')
    : '3C电子产品';

  return `亲，你好！我们是做亚马逊跨境的，最近在找${categoryDesc}的工厂合作。看了你家产品感觉挺合适的，想长期拿货。\n想问下你们有自己的品牌吗？有的话能给我们出个品牌授权书吗？亚马逊上架需要这个，没有的话没法卖。\n方便的话回复我一下，我们一起聊聊合作细节 :)`;
}

async function main(): Promise<void> {
  const options = parseArgs();
  logger.info('Task 11: 3C Supplier Outreach', options);

  // Get providers that need outreach
  const providers = await getProvidersForOutreach('3c_outreach', options.limit);
  if (providers.length === 0) {
    logger.info('No 3C suppliers pending outreach. Run Task 10 first to discover suppliers.');
    closeDatabase();
    return;
  }

  logger.info(`Found ${providers.length} suppliers to contact`);

  if (options.dryRun) {
    for (const provider of providers) {
      const categories = provider.notes
        ? (() => {
            try {
              const parsed = JSON.parse(provider.notes);
              return parsed.category ? [parsed.category] : [];
            } catch { return []; }
          })()
        : [];
      const message = buildOutreachMessage(provider.providerName, categories);
      logger.info(`[DRY RUN] Would contact: ${provider.providerName}`);
      logger.info(`  Shop: ${provider.shopUrl}`);
      logger.info(`  Seller ID: ${provider.platformId}`);
      logger.info(`  Message (${message.length} chars):`);
      logger.info(`  ${message.substring(0, 200)}...`);
    }
    closeDatabase();
    return;
  }

  // Initialize browser for Wangwang messaging
  const scraper = await create1688Scraper(options.headless);

  let sent = 0;
  let failed = 0;

  try {
    for (const provider of providers) {
      const sellerId = provider.platformId;
      if (!sellerId) {
        logger.warn(`Provider ${provider.providerName} has no platform_id — skipping`);
        continue;
      }

      // Parse categories from notes JSON
      let categories: string[] = [];
      if (provider.notes) {
        try {
          const parsed = JSON.parse(provider.notes);
          if (parsed.category) categories = [parsed.category];
        } catch { /* not JSON, ignore */ }
      }

      const message = buildOutreachMessage(provider.providerName, categories);

      logger.info(`Contacting: ${provider.providerName} (${sellerId})`);
      logger.info(`  Shop: ${provider.shopUrl}`);

      // Save seller contact record first (with outreach_type marker)
      await saveSellerContact(
        sellerId,
        provider.providerName,
        provider.wangwangId || '',
        provider.shopUrl || `https://shop${sellerId}.1688.com/`,
        [] // no product IDs — this is supplier-level outreach, not product-level
      );

      // Mark outreach type on compliance_contacts
      const p = await getPool();
      await p.execute(
        `UPDATE compliance_contacts SET outreach_type = '3c_amazon_outreach' WHERE seller_id = ?`,
        [sellerId]
      );

      // Send Wangwang message
      // Use shop URL or construct from seller ID
      const targetUrl = provider.shopUrl || `https://shop${sellerId}.1688.com/`;
      const success = await scraper.sendWangwangMessage(targetUrl, message);

      if (success) {
        await updateContactStatus(sellerId, 'contacted', `3C Amazon outreach — categories: ${categories.join(', ')}`);
        sent++;
        logger.info(`  ✓ Message sent to ${provider.providerName}`);
      } else {
        failed++;
        logger.warn(`  ✗ Failed to send message to ${provider.providerName}`);
      }

      // Delay between sellers (5-10 seconds to appear human-paced)
      await randomDelay(5000, 10000);
    }

    logger.info('\n' + '='.repeat(60));
    logger.info('Task 11 Summary:');
    logger.info(`  Total suppliers: ${providers.length}`);
    logger.info(`  Messages sent: ${sent}`);
    logger.info(`  Failed: ${failed}`);
    logger.info('='.repeat(60));

  } finally {
    await scraper.close();
    closeDatabase();
  }
}

main().catch((err) => {
  logger.error('Task 11 failed', { error: err.message, stack: err.stack });
  closeDatabase();
  process.exit(1);
});
