/**
 * Task 12: 3C Supplier Follow-up — Share Company Info & Track Authorization
 *
 * Semi-manual task for handling seller responses to Task 11 outreach.
 * Actions:
 *   --action list              Show all contacted 3C suppliers and their status
 *   --action share-company-info --seller-id XXXXX   Send HK company info to a seller who agreed
 *   --action mark-authorized --seller-id XXXXX [--doc-url URL]   Mark seller as authorized (with optional doc)
 *   --action mark-no-response --seller-id XXXXX     Mark seller as non-responsive
 *   --action stats             Show 3C outreach pipeline stats
 *
 * The HK company info (***REMOVED***) is sent
 * ONLY after a seller verbally agrees to provide brand authorization.
 *
 * Usage:
 *   node dist/tasks/task12-3c-supplier-followup.js --action list
 *   node dist/tasks/task12-3c-supplier-followup.js --action share-company-info --seller-id 12345
 *   node dist/tasks/task12-3c-supplier-followup.js --action mark-authorized --seller-id 12345 --doc-url https://...
 *
 * Runs on: China MacBook (Wangwang required for share-company-info action)
 */

import { create1688Scraper } from '../scrapers/1688Scraper';
import {
  getProvidersPendingFollowup,
  markProviderAuthorized,
  updateContactStatus,
  get3COutreachStats,
  getProviderByPlatformId,
  updateProviderTrustLevel,
  closeDatabase,
  getPool,
} from '../database/db';
import { createChildLogger } from '../utils/logger';
import { RowDataPacket } from 'mysql2/promise';

const logger = createChildLogger('task12-3c-followup');

// HK company info for brand authorization (from documents/company/hk.txt)
const HK_COMPANY_INFO = {
  nameEn: '***REMOVED***',
  nameZh: '***REMOVED***',
  brNumber: '***REMOVED***',
  duns: '***REMOVED***',
  registrationDate: '2025-04-10',
  phone: '***REMOVED***',
  address: '***REMOVED***, TUNG CHAU ST TAI KOK, Yau Tsim Mong Distri, Hong Kong',
  directorName: '***REMOVED***',
  email: '***REMOVED***',
};

interface CLIOptions {
  action: string;
  sellerId: string | null;
  docUrl: string | null;
  headless: boolean;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = { action: 'list', sellerId: null, docUrl: null, headless: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--action' && args[i + 1]) options.action = args[++i];
    else if (args[i] === '--seller-id' && args[i + 1]) options.sellerId = args[++i];
    else if (args[i] === '--doc-url' && args[i + 1]) options.docUrl = args[++i];
    else if (args[i] === '--headless') options.headless = true;
  }
  return options;
}

/**
 * Build the Wangwang message to share HK company info with a seller.
 * Sent AFTER seller has verbally agreed to provide brand authorization.
 */
function buildCompanyInfoMessage(): string {
  return `亲，太感谢啦！以下是我们公司信息，麻烦出授权书的时候用这个~

公司名称（英文）: ${HK_COMPANY_INFO.nameEn}
公司名称（中文）: ${HK_COMPANY_INFO.nameZh}
商业登记号码: ${HK_COMPANY_INFO.brNumber}
DUNS编号: ${HK_COMPANY_INFO.duns}
注册日期: ${HK_COMPANY_INFO.registrationDate}
地址: ${HK_COMPANY_INFO.address}
联系人: ${HK_COMPANY_INFO.directorName}
目标平台: 亚马逊 (Amazon)

授权书上写明授权 ${HK_COMPANY_INFO.nameEn} 在亚马逊平台销售就好。你们有现成模板更好，没有的话我们也可以提供，不麻烦哈，谢谢亲！`;
}

async function actionList(): Promise<void> {
  const pending = await getProvidersPendingFollowup();

  if (pending.length === 0) {
    logger.info('No suppliers awaiting follow-up. Run Task 11 to contact suppliers first.');
    return;
  }

  logger.info(`\n${'='.repeat(80)}`);
  logger.info(`3C Suppliers Awaiting Follow-up: ${pending.length}`);
  logger.info('='.repeat(80));

  for (const s of pending) {
    const daysSinceContact = s.messageSentAt
      ? Math.floor((Date.now() - new Date(s.messageSentAt).getTime()) / (1000 * 60 * 60 * 24))
      : '?';
    logger.info(`  [${s.contactStatus.toUpperCase()}] ${s.providerName}`);
    logger.info(`    Seller ID: ${s.sellerId} | Shop: ${s.shopUrl}`);
    logger.info(`    Categories: ${s.categories.join(', ') || 'N/A'}`);
    logger.info(`    Contacted: ${daysSinceContact} days ago`);
    logger.info('');
  }
}

async function actionShareCompanyInfo(sellerId: string, headless: boolean): Promise<void> {
  logger.info(`Sharing HK company info with seller: ${sellerId}`);

  const provider = await getProviderByPlatformId('1688', sellerId);
  if (!provider) {
    logger.error(`Provider not found for seller ID: ${sellerId}`);
    return;
  }

  const message = buildCompanyInfoMessage();
  logger.info(`Message (${message.length} chars):`);
  logger.info(message);

  // Send via Wangwang
  const scraper = await create1688Scraper(headless);
  try {
    const targetUrl = provider.shopUrl || `https://shop${sellerId}.1688.com/`;
    const success = await scraper.sendWangwangMessage(targetUrl, message);

    if (success) {
      // Mark as responded (seller agreed verbally, company info shared)
      await updateContactStatus(sellerId, 'responded', 'Company info shared — awaiting 品牌授权书');
      logger.info(`✓ Company info sent to ${provider.providerName}. Awaiting authorization doc.`);
    } else {
      logger.error(`✗ Failed to send company info to ${provider.providerName}`);
    }
  } finally {
    await scraper.close();
  }
}

async function actionMarkAuthorized(sellerId: string, docUrl?: string | null): Promise<void> {
  logger.info(`Marking seller ${sellerId} as authorized`);

  const provider = await getProviderByPlatformId('1688', sellerId);
  if (!provider) {
    logger.error(`Provider not found for seller ID: ${sellerId}`);
    return;
  }

  await markProviderAuthorized(
    sellerId,
    docUrl || undefined,
    docUrl
      ? `Brand authorization doc received — seller: ${provider.providerName}`
      : `Verbal authorization confirmed — seller: ${provider.providerName}. Follow up for formal doc.`
  );

  logger.info(`✓ Seller ${provider.providerName} marked as authorized`);
  logger.info(`  Trust level: verified`);
  logger.info(`  Store URL: ${provider.shopUrl}`);
  if (docUrl) {
    logger.info(`  Authorization doc: ${docUrl}`);
  } else {
    logger.info(`  Note: Follow up later for formal 品牌授权书`);
  }
  logger.info(`\nThis seller's store can now be scraped for Amazon products.`);
}

async function actionMarkNoResponse(sellerId: string): Promise<void> {
  const provider = await getProviderByPlatformId('1688', sellerId);
  if (!provider) {
    logger.error(`Provider not found for seller ID: ${sellerId}`);
    return;
  }

  await updateContactStatus(sellerId, 'no_certs', 'No response to 3C outreach');
  logger.info(`Marked ${provider.providerName} as no-response`);
}

async function actionStats(): Promise<void> {
  const stats = await get3COutreachStats();

  logger.info('\n' + '='.repeat(60));
  logger.info('3C Supplier Outreach Pipeline Stats');
  logger.info('='.repeat(60));
  logger.info(`  Total discovered: ${stats.totalDiscovered}`);
  logger.info(`  Contacted:        ${stats.contacted}`);
  logger.info(`  Responded:        ${stats.responded}`);
  logger.info(`  Authorized:       ${stats.authorized}`);
  logger.info(`  Pending outreach: ${stats.pending}`);
  logger.info('='.repeat(60));
}

async function main(): Promise<void> {
  const options = parseArgs();
  logger.info('Task 12: 3C Supplier Follow-up', { action: options.action });

  try {
    switch (options.action) {
      case 'list':
        await actionList();
        break;

      case 'share-company-info':
        if (!options.sellerId) {
          logger.error('--seller-id is required for share-company-info action');
          process.exit(1);
        }
        await actionShareCompanyInfo(options.sellerId, options.headless);
        break;

      case 'mark-authorized':
        if (!options.sellerId) {
          logger.error('--seller-id is required for mark-authorized action');
          process.exit(1);
        }
        await actionMarkAuthorized(options.sellerId, options.docUrl);
        break;

      case 'mark-no-response':
        if (!options.sellerId) {
          logger.error('--seller-id is required for mark-no-response action');
          process.exit(1);
        }
        await actionMarkNoResponse(options.sellerId);
        break;

      case 'stats':
        await actionStats();
        break;

      default:
        logger.error(`Unknown action: ${options.action}`);
        logger.info('Available actions: list, share-company-info, mark-authorized, mark-no-response, stats');
        process.exit(1);
    }
  } finally {
    closeDatabase();
  }
}

main().catch((err) => {
  logger.error('Task 12 failed', { error: err.message, stack: err.stack });
  closeDatabase();
  process.exit(1);
});
