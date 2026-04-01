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
/**
 * Category-specific talking points.
 * Each entry has:
 *   label: Chinese product name
 *   hook:  A concrete technical question that shows knowledge and triggers a reply.
 *          Hooks are rotated to avoid spam detection.
 */
const CATEGORY_HOOKS: Record<string, { label: string; hooks: string[] }> = {
  'smart watches': {
    label: '智能手表',
    hooks: [
      '想问一下你们的手表支持心率/血氧监测吗？亚马逊美国站这两个功能现在很抢手。',
      '你们的智能手表有没有通过CE/FCC认证？我们亚马逊欧美站上架需要这个。',
      '请问表带是可拆换的吗？我们在亚马逊美国站卖，客户很在意个性化定制。',
    ],
  },
  'action cameras': {
    label: '运动相机',
    hooks: [
      '你们的运动相机最高支持几K录制？亚马逊美国站4K以上卖得比较好。',
      '请问相机的防水等级是多少米？我们在亚马逊欧美卖，这个参数买家很看重。',
      '有没有带防抖功能的款式？亚马逊美国站这个配置走量不错。',
    ],
  },
  'portable projector': {
    label: '便携投影仪',
    hooks: [
      '你们的投影仪支持Android系统吗？亚马逊美国站内置安卓的款式转化率高很多。',
      '请问最高亮度是多少流明？我们在亚马逊欧美卖，买家很在意室内使用效果。',
      '有没有带自动梯形校正的款？亚马逊美国站这个功能的差评少很多。',
    ],
  },
  'vr glasses': {
    label: 'VR眼镜',
    hooks: [
      '请问你们的VR眼镜适配哪些手机尺寸？亚马逊美国站对兼容性描述要求比较严。',
      '你们有没有一体机款式（不需要手机的那种）？亚马逊美国站独立VR卖得好一些。',
      '镜片是否支持近视调节？我们亚马逊欧美站的买家这个问题问得比较多。',
    ],
  },
  'ip camera': {
    label: '监控摄像头',
    hooks: [
      '你们的摄像头支持P2P远程查看吗？亚马逊美国站买家基本都要求这个功能。',
      '请问有没有支持Alexa语音控制的款式？亚马逊美国站这个兼容性很加分。',
      '2K/4K分辨率有货吗？我们在亚马逊欧美卖，清晰度是买家选购的首要因素。',
    ],
  },
  'smart doorbell': {
    label: '智能门铃',
    hooks: [
      '你们的门铃支持2K以上分辨率吗？亚马逊美国站买家对画质要求越来越高。',
      '请问有没有支持Alexa或Google Home联动的款式？这个在亚马逊美国站很加分。',
      '门铃有没有免打孔/免布线的款？我们亚马逊欧美买家有这个需求。',
    ],
  },
  'soundbar': {
    label: '蓝牙音响',
    hooks: [
      '你们的蓝牙音响支持5.0及以上协议吗？亚马逊美国站买家对连接稳定性很敏感。',
      '请问有没有带低音炮的款式？亚马逊美国站带低音炮的套装走量比较好。',
      '防水等级方面怎么样？我们在亚马逊欧美卖户外音响，IPX5以上比较好卖。',
    ],
  },
  'solar panel': {
    label: '太阳能充电板',
    hooks: [
      '你们的太阳能板转换效率大概是多少？亚马逊美国站买家比较看重这个参数。',
      '请问有没有折叠款（便携型的）？我们在亚马逊欧美卖，户外折叠款需求挺大。',
      '有没有通过ETL或UL认证？亚马逊美国站上架户外用电产品有时候会查这个。',
    ],
  },
  'gimbal stabilizer': {
    label: '手持稳定器',
    hooks: [
      '你们的稳定器支持手机还是相机，还是两用？亚马逊美国站两用款卖得比较好。',
      '请问有没有支持竖拍自动切换的款式？亚马逊美国站Vlog用户这个需求很大。',
      '最大负载多少克？我们亚马逊欧美买家用的手机有些比较重，这个参数很关键。',
    ],
  },
  'lavalier microphone': {
    label: '无线领夹麦克风',
    hooks: [
      '你们的领夹麦有没有降噪功能？亚马逊美国站评价里这个是买家最看重的点之一。',
      '请问接收器支持直插手机（Type-C/Lightning）吗？亚马逊美国站这个设计走量好。',
      '有没有适配相机的款（3.5mm接口）？我们在亚马逊欧美有这个细分需求。',
    ],
  },
  'smart ring': {
    label: '智能戒指',
    hooks: [
      '你们的智能戒指支持心率和睡眠监测吗？亚马逊美国站这两个是买家核心需求。',
      '请问配套APP支持iOS和Android双平台吗？亚马逊美国站这个是必问的。',
      '戒指防水等级是多少？我们亚马逊欧美买家大多希望日常佩戴不用摘。',
    ],
  },
  // Legacy/banned categories — kept for message fallback but pipeline filters them out
  'earphones': {
    label: '无线耳机',
    hooks: [
      '你们的TWS耳机延迟大概多少ms？亚马逊美国站游戏用户对延迟比较敏感。',
    ],
  },
  'power station': {
    label: '户外储能电源',
    hooks: [
      '请问你们的储能电源支持太阳能充电输入吗？亚马逊欧美这个组合需求挺大的。',
    ],
  },
};

function buildOutreachMessage(storeName: string, categories: string[]): string {
  // Pick the first recognised category (usually one per supplier)
  const cat = categories.find(c => CATEGORY_HOOKS[c]) || categories[0] || '';
  const info = CATEGORY_HOOKS[cat];
  const label = info?.label || cat || '智能硬件产品';

  // Pick a hook for this category (rotate via random to avoid spam flags)
  const hooks = info?.hooks || [];
  const hook = hooks.length > 0
    ? hooks[Math.floor(Math.random() * hooks.length)]
    : `你们做过出口/OEM吗？方便的话聊聊合作。`;

  // Three message frames — different openers, same hook embedded in each.
  // No 亲 opener (too spammy). No multiple questions. One clear ask.
  // Goal: sound like a real sourcing buyer, not a mass blast.
  const frames = [
    // Frame 1: Direct buyer framing with specific question
    `你好，看了你家的${label}，我们是亚马逊美国/欧洲站的卖家，最近在选新品。${hook} 方便回复一下吗，谢谢！`,

    // Frame 2: Volume signal + specific question
    `你好！我们是做亚马逊欧美的，${label}每月采购量比较稳定，现在在对比几家供应商。${hook} 有空的话回复一下，谢谢！`,

    // Frame 3: Urgency signal + specific question
    `你好，我们亚马逊美国站Q2有个${label}的新品计划，正在找合适的厂家。${hook} 麻烦回复一下，感谢！`,
  ];

  const frame = frames[Math.floor(Math.random() * frames.length)];
  return frame;
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
