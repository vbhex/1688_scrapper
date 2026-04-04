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
  return `太好了，感谢配合！下面是我们公司信息，麻烦授权书按这个填写~

被授权方（英文）: ${HK_COMPANY_INFO.nameEn}
被授权方（中文）: ${HK_COMPANY_INFO.nameZh}
商业登记号: ${HK_COMPANY_INFO.brNumber}
DUNS编号: ${HK_COMPANY_INFO.duns}
注册日期: ${HK_COMPANY_INFO.registrationDate}
公司地址: ${HK_COMPANY_INFO.address}
联系人: ${HK_COMPANY_INFO.directorName}
授权平台: 亚马逊全球站（Amazon）

授权书内容只需写明授权 ${HK_COMPANY_INFO.nameEn} 在亚马逊平台销售贵司品牌产品即可，不需要太复杂。你们有现成模板直接用就行，如果没有我们可以提供模板，非常方便的。再次感谢，期待合作！`;
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

  // Build THREE lookups: by seller_id, by numeric-only ID, and by seller NAME.
  // The seller_id in our DB (e.g. "741584806m402") is the 1688 member ID,
  // but Wangwang conversation IDs use a DIFFERENT numeric UID format (e.g. "938596378").
  // Name-based matching is the most reliable cross-reference.
  const sellerById: Record<string, RowDataPacket> = {};
  const sellerByName: Record<string, RowDataPacket> = {};
  for (const row of rows) {
    const sid = String(row.seller_id);
    sellerById[sid] = row;
    const numeric = sid.replace(/[^0-9]/g, '');
    if (numeric && numeric !== sid) sellerById[numeric] = row;
    // Index by seller name (trimmed, for fuzzy match below)
    const name = (row.seller_name || '').trim();
    if (name) sellerByName[name] = row;
  }

  // Use first seller's shop URL as seed to open Wangwang inbox
  const seedUrl = rows[0].shop_url || `https://shop${rows[0].seller_id}.1688.com/`;

  const scraper = await create1688Scraper(headless);
  let repliedCount = 0;

  try {
    logger.info('Opening Wangwang inbox for bulk scan...');
    const inbox = await scraper.scanWangwangInbox(seedUrl);
    const unread = inbox.conversations.filter(c => c.hasUnread);

    logger.info(`Inbox: ${inbox.conversations.length} conversations visible, ${unread.length} unread`);

    // Check ALL conversations (not just unread) — replies may already be read
    for (const conv of inbox.conversations) {
      // Try matching by ID first (for rare cases where formats align)
      const idMatch = (conv.id || '').match(/\.1-([^.]+)\.1#/);
      let row: RowDataPacket | undefined;
      let matchMethod = '';

      if (idMatch) {
        const convSellerId = idMatch[1];
        const convSellerNumeric = convSellerId.replace(/[^0-9]/g, '');
        row = sellerById[convSellerId] || (convSellerNumeric ? sellerById[convSellerNumeric] : undefined);
        if (row) matchMethod = 'id';
      }

      // Fall back to NAME matching — most reliable since Wangwang UIDs differ from 1688 member IDs
      if (!row && conv.name) {
        const convName = conv.name.trim();
        // Exact match first
        row = sellerByName[convName];
        if (row) {
          matchMethod = 'name-exact';
        } else {
          // Substring match: check if conv.name is contained in any seller_name or vice versa
          for (const [dbName, dbRow] of Object.entries(sellerByName)) {
            if (dbName.includes(convName) || convName.includes(dbName)) {
              row = dbRow;
              matchMethod = 'name-substring';
              break;
            }
          }
        }
      }

      if (!row) continue;

      // Skip if the last message is OUR outreach message (no reply yet)
      const lastMsg = conv.lastMsg || '';
      const isOurMessage = lastMsg.includes('亚马逊') && (lastMsg.includes('方便回复') || lastMsg.includes('有空的话回复') || lastMsg.includes('麻烦回复'));
      if (isOurMessage) {
        logger.debug(`  Matched ${conv.name} (via ${matchMethod}) but last msg is our outreach — no reply yet`);
        continue;
      }

      // Skip system messages (评价邀请, 询价, card messages that are system-generated)
      const isSystemMsg = lastMsg.includes('客服评价邀请') || lastMsg === '批量询价';
      if (isSystemMsg) {
        logger.debug(`  Matched ${conv.name} (via ${matchMethod}) but last msg is system notification — skipping`);
        continue;
      }

      // This seller replied!
      await updateContactStatus(
        String(row.seller_id),
        'replied',
        `Wangwang reply detected (${matchMethod}${conv.hasUnread ? ', unread' : ', read'}): ${lastMsg.substring(0, 200)}`
      );
      repliedCount++;
      logger.info(`  ✓ REPLIED: ${conv.name} (${row.seller_id}, match=${matchMethod}): ${lastMsg.substring(0, 100)}`);
    }

    // Report unmatched conversations for debugging
    const unmatchedCount = inbox.conversations.length - repliedCount;
    logger.info(`\nCheck-replies summary: ${inbox.conversations.length} inbox items scanned, ${repliedCount} matched our sellers (via ID + name matching)`);
    if (repliedCount > 0) {
      logger.info(`Run --action list to see replied sellers, then --action share-company-info --seller-id XXX for each.`);
    } else {
      logger.info(`No replies detected from ${rows.length} contacted sellers in top ${inbox.conversations.length} inbox items.`);
      logger.info(`Note: Wangwang virtual scroll shows limited items. Sellers who reply bubble to top.`);
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

  // Follow-up messages take a completely different angle from the first outreach.
  // Don't reference "上次发消息" (sounds needy). Instead, come in fresh with a
  // concrete price/sample request — gives them a new reason to reply.
  const followupMessages = [
    `你好，想问一下你们这边最小起订量是多少？我们亚马逊美国站在评估几款产品，需要先了解一下价格区间。麻烦回复一下，谢谢！`,
    `你好，请问能提供一下报价单吗？我们是亚马逊欧美卖家，最近在做选品，你家产品在考虑范围内。谢谢！`,
    `你好，请问你们有没有现货可以寄样品？我们亚马逊美国站在测品，想先评估一下实物品质，运费我们承担。麻烦告知，谢谢！`,
    `你好，想了解一下你们做不做私标/贴牌？我们在亚马逊欧美有稳定的销量，如果合适的话希望能长期合作。有空的话回复一下，谢谢！`,
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
