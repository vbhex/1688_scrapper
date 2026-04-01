/**
 * Task 12: 3C Supplier Follow-up — Share Company Info & Track Authorization
 *
 * Semi-manual task for handling seller responses to Task 11 outreach.
 * Actions:
 *   --action list              Show all contacted 3C suppliers and their status
 *   --action scan-inbox        Open Wangwang inbox and scan for ANY unread conversations (fast overview)
 *   --action debug-reply --seller-id XXXXX   Dump DOM of one seller's chat to diagnose reply detection
 *   --action check-replies     Open each seller's Wangwang chat and detect replies (auto-updates DB)
 *   --action followup-nonresponders   Send a 7-day follow-up nudge to sellers who haven't replied
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
 *   node dist/tasks/task12-3c-supplier-followup.js --action scan-inbox
 *   node dist/tasks/task12-3c-supplier-followup.js --action debug-reply --seller-id 4597814480s45
 *   node dist/tasks/task12-3c-supplier-followup.js --action check-replies [--limit 50]
 *   node dist/tasks/task12-3c-supplier-followup.js --action share-company-info --seller-id 12345
 *   node dist/tasks/task12-3c-supplier-followup.js --action mark-authorized --seller-id 12345 --doc-url https://...
 *
 * Runs on: China MacBook (Wangwang required for share-company-info and check-replies actions)
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
import { randomDelay } from '../utils/helpers';
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
  limit: number;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = { action: 'list', sellerId: null, docUrl: null, headless: false, limit: 50 };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--action' && args[i + 1]) options.action = args[++i];
    else if (args[i] === '--seller-id' && args[i + 1]) options.sellerId = args[++i];
    else if (args[i] === '--doc-url' && args[i + 1]) options.docUrl = args[++i];
    else if (args[i] === '--headless') options.headless = true;
    else if ((args[i] === '--limit' || args[i] === '-l') && args[i + 1]) options.limit = parseInt(args[++i]) || 50;
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

/**
 * Open Wangwang inbox and scan for unread/replied conversations.
 * Much faster than checking 275 individual chats — gives a quick overview.
 */
async function actionScanInbox(headless: boolean): Promise<void> {
  logger.info('Opening Wangwang inbox to scan for replies...');

  // Get any seller from contacts to use as seed URL (needed to open Wangwang)
  const pool = await getPool();
  const [seedRows] = await pool.execute<RowDataPacket[]>(
    `SELECT COALESCE(p.shop_url, CONCAT('https://shop', cc.seller_id, '.1688.com/')) as shop_url
     FROM compliance_contacts cc
     LEFT JOIN providers p ON p.platform_id = cc.seller_id AND p.platform = '1688'
     WHERE cc.outreach_type = '3c_amazon_outreach' LIMIT 1`
  );
  const seedUrl = seedRows.length > 0 ? seedRows[0].shop_url : undefined;

  const scraper = await create1688Scraper(headless);
  try {
    const result = await scraper.scanWangwangInbox(seedUrl);
    const unread = result.conversations.filter(c => c.hasUnread);

    logger.info(`\n${'='.repeat(60)}`);
    logger.info(`Wangwang Inbox: ${result.conversations.length} conversations found`);
    logger.info(`Unread/new messages: ${unread.length}`);
    logger.info('='.repeat(60));

    if (unread.length > 0) {
      logger.info('\n  CONVERSATIONS WITH NEW MESSAGES:');
      for (const c of unread) {
        // Extract seller ID from conversation ID: "BUYER.1-SELLER_ID.1#..."
        const idMatch = (c.id || '').match(/\d+\.1-([^.#]+)\./);
        const sellerId = idMatch ? idMatch[1] : '?';
        logger.info(`  [UNREAD] ${c.name} (seller: ${sellerId})`);
        logger.info(`    Last: ${c.lastMsg}`);
      }
    } else {
      logger.info('  No unread conversations detected.');
    }

    if (result.conversations.length > 0) {
      logger.info('\n  ALL RECENT CONVERSATIONS (first 10):');
      for (const c of result.conversations.slice(0, 10)) {
        logger.info(`  ${c.hasUnread ? '[UNREAD]' : '[READ]  '} ${c.name}: ${c.lastMsg.substring(0, 60)}`);
      }
    }

    // Save DOM sample for debugging
    if (result.domSample) {
      const fs = require('fs');
      fs.writeFileSync('/tmp/wangwang-inbox-dom.txt', result.domSample);
      logger.info('\n  DOM sample saved to /tmp/wangwang-inbox-dom.txt for selector debugging');
    }
  } finally {
    await scraper.close();
  }
}

/**
 * Open ONE seller's chat in debug mode and dump the DOM to identify correct selectors.
 * Use this when check-replies returns 0 but you suspect replies exist.
 */
async function actionDebugReply(sellerId: string, headless: boolean): Promise<void> {
  logger.info(`Debug mode: checking chat with seller ${sellerId}`);
  const shopUrl = `https://shop${sellerId}.1688.com/`;
  const scraper = await create1688Scraper(headless);
  try {
    const result = await (scraper as any).checkWangwangReply(shopUrl, true);
    logger.info(`hasReply: ${result.hasReply}`);
    if (result.replyText) logger.info(`replyText: ${result.replyText}`);

    if (result.domSample) {
      const fs = require('fs');
      fs.writeFileSync('/tmp/wangwang-chat-dom.txt', result.domSample);
      logger.info('DOM saved to /tmp/wangwang-chat-dom.txt — inspect to find correct message selectors');
    }
  } finally {
    await scraper.close();
  }
}

async function actionCheckReplies(headless: boolean, limit: number): Promise<void> {
  const pool = await getPool();

  // Get all sellers with 'contacted' status (contacted > 1 hour ago)
  const safeLimit = Math.min(Math.max(1, Math.floor(Number(limit))), 500);
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT cc.seller_id,
            COALESCE(p.provider_name, cc.seller_name, cc.seller_id) as provider_name,
            COALESCE(p.shop_url, cc.seller_url, CONCAT('https://shop', cc.seller_id, '.1688.com/')) as shop_url,
            cc.message_sent_at as contacted_at
     FROM compliance_contacts cc
     LEFT JOIN providers p ON p.platform_id = cc.seller_id AND p.platform = '1688'
     WHERE cc.outreach_type = '3c_amazon_outreach'
       AND cc.contact_status = 'contacted'
       AND cc.message_sent_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)
     ORDER BY cc.message_sent_at ASC
     LIMIT ${safeLimit}`
  );

  if (rows.length === 0) {
    logger.info('No sellers to check (none contacted > 1 hour ago, or all already replied).');
    return;
  }

  logger.info(`Checking inbox for replies from ${rows.length} contacted sellers...`);

  // Build lookup: seller_id (and numeric variant) → row
  const sellerById: Record<string, RowDataPacket> = {};
  for (const row of rows) {
    const sid = String(row.seller_id);
    sellerById[sid] = row;
    // Also index by numeric-only ID for matching alphanumeric seller IDs like "4597814480s45"
    const numeric = sid.replace(/[^0-9]/g, '');
    if (numeric && numeric !== sid) sellerById[numeric] = row;
  }

  // Use first seller's shop URL as seed to open Wangwang inbox
  const seedUrl = rows[0].shop_url || `https://shop${rows[0].seller_id}.1688.com/`;

  const scraper = await create1688Scraper(headless);
  let repliedCount = 0;

  try {
    // Single bulk scan — far more reliable than 275 individual checkWangwangReply calls.
    // When a seller replies, their conversation bubbles to the top of the inbox list.
    // scanWangwangInbox reads up to ~20 visible conversations in the virtual scroll list.
    logger.info('Opening Wangwang inbox for bulk scan...');
    const inbox = await scraper.scanWangwangInbox(seedUrl);
    const unread = inbox.conversations.filter(c => c.hasUnread);

    logger.info(`Inbox: ${inbox.conversations.length} conversations visible, ${unread.length} unread`);

    for (const conv of inbox.conversations) {
      if (!conv.hasUnread) continue;

      // Extract seller ID from conversation ID: "BUYER.1-SELLER_ID.1#CHANNEL@cntaobao"
      const idMatch = (conv.id || '').match(/\.1-([^.]+)\.1#/);
      if (!idMatch) {
        logger.debug(`Could not extract seller ID from conv id: ${conv.id}`);
        continue;
      }
      const convSellerId = idMatch[1];
      const convSellerNumeric = convSellerId.replace(/[^0-9]/g, '');

      // Cross-reference against our contacted sellers
      const row = sellerById[convSellerId] || (convSellerNumeric ? sellerById[convSellerNumeric] : undefined);
      if (!row) {
        logger.debug(`Unread from non-outreach seller: ${conv.name} (${convSellerId})`);
        continue;
      }

      // This is one of our 3C outreach sellers — they replied!
      await updateContactStatus(
        String(row.seller_id),
        'replied',
        `Wangwang inbox reply detected: ${conv.lastMsg.substring(0, 200)}`
      );
      repliedCount++;
      logger.info(`  ✓ REPLIED: ${conv.name} (${row.seller_id}): ${conv.lastMsg.substring(0, 100)}`);
    }

    // Report any unread conversations that didn't match our seller list (for info)
    const otherUnread = unread.filter(conv => {
      const idMatch = (conv.id || '').match(/\.1-([^.]+)\.1#/);
      if (!idMatch) return true;
      const sid = idMatch[1];
      return !sellerById[sid] && !sellerById[sid.replace(/[^0-9]/g, '')];
    });
    if (otherUnread.length > 0) {
      logger.info(`  (${otherUnread.length} unread from non-outreach sellers — check Wangwang manually)`);
      for (const c of otherUnread) {
        logger.info(`    [OTHER UNREAD] ${c.name}: ${c.lastMsg.substring(0, 60)}`);
      }
    }

    logger.info(`\nCheck-replies summary: ${inbox.conversations.length} inbox items scanned, ${repliedCount} matched our sellers`);
    if (repliedCount > 0) {
      logger.info(`Run --action list to see replied sellers, then --action share-company-info --seller-id XXX for each.`);
    } else {
      logger.info(`No replies yet from ${rows.length} contacted sellers (only top ~${inbox.conversations.length} inbox items are visible).`);
      logger.info(`Note: Sellers who reply bubble to the top of the inbox — run --action scan-inbox for a detailed view.`);
    }
  } finally {
    await scraper.close();
  }
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

/**
 * Send a brief follow-up message to sellers contacted 7+ days ago with no reply.
 * A second touch on 1688 typically lifts response rate by 20-30%.
 */
async function actionFollowupNonresponders(headless: boolean, limit: number): Promise<void> {
  const pool = await getPool();

  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT cc.seller_id,
            COALESCE(p.provider_name, cc.seller_name, cc.seller_id) as provider_name,
            COALESCE(p.shop_url, cc.seller_url, CONCAT('https://shop', cc.seller_id, '.1688.com/')) as shop_url,
            p.main_categories,
            cc.message_sent_at
     FROM compliance_contacts cc
     LEFT JOIN providers p ON p.platform_id = cc.seller_id AND p.platform = '1688'
     WHERE cc.outreach_type = '3c_amazon_outreach'
       AND cc.contact_status = 'contacted'
       AND cc.message_sent_at < DATE_SUB(NOW(), INTERVAL 7 DAY)
       AND (cc.notes IS NULL OR cc.notes NOT LIKE '%followup_sent%')
     ORDER BY cc.message_sent_at ASC
     LIMIT ${Math.min(Math.max(1, Math.floor(Number(limit))), 500)}`,
    []
  );

  if (rows.length === 0) {
    logger.info('No sellers need a 7-day follow-up (none contacted > 7 days ago without a reply).');
    return;
  }

  logger.info(`Sending 7-day follow-up to ${rows.length} non-responsive sellers...`);

  const followupMessages = [
    `亲，好！上次发消息不知道有没有看到？我们还在找这类产品的供应商，有兴趣的话方便回复一下吗？不打扰了，谢谢 :)`,
    `亲，之前聊过采购的事，想再跟进一下。我们现在还在筛选供应商，你家产品挺对口的。方便的话回个消息？谢谢～`,
    `亲好！忘了之前发过消息，我们还有采购需求，有空聊聊吗 :)`,
  ];

  const scraper = await create1688Scraper(headless);
  let sent = 0;
  let failed = 0;

  try {
    for (const row of rows) {
      const msg = followupMessages[Math.floor(Math.random() * followupMessages.length)];
      logger.info(`Follow-up → ${row.provider_name} (${row.seller_id})`);

      const success = await scraper.sendWangwangMessage(row.shop_url, msg);
      if (success) {
        // Append followup note, keep original status
        await pool.execute(
          `UPDATE compliance_contacts SET notes = CONCAT(IFNULL(notes,''), ' | followup_sent:', NOW()) WHERE seller_id = ?`,
          [String(row.seller_id)]
        );
        sent++;
        logger.info(`  ✓ Follow-up sent`);
      } else {
        failed++;
        logger.warn(`  ✗ Failed`);
      }

      await randomDelay(5000, 10000);
    }
  } finally {
    await scraper.close();
  }

  logger.info(`Follow-up summary: ${sent} sent, ${failed} failed out of ${rows.length} sellers`);
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

      case 'scan-inbox':
        await actionScanInbox(options.headless);
        break;

      case 'debug-reply':
        if (!options.sellerId) {
          logger.error('--seller-id is required for debug-reply action');
          process.exit(1);
        }
        await actionDebugReply(options.sellerId, options.headless);
        break;

      case 'check-replies':
        await actionCheckReplies(options.headless, options.limit);
        break;

      case 'followup-nonresponders':
        await actionFollowupNonresponders(options.headless, options.limit);
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
        logger.info('Available actions: list, scan-inbox, debug-reply, check-replies, followup-nonresponders, share-company-info, mark-authorized, mark-no-response, stats');
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
