/**
 * Task 2c: Backfill seller_wangwang_id / seller_id / seller_name.
 *
 * Why this exists: the old getSellerInfo() used DOM selectors that no longer
 * match 1688's current detail page layout, so all 883 products scraped via
 * Task 2 ended up with `products_raw.seller_wangwang_id = NULL`. This
 * blocks Task 8 Wangwang outreach.
 *
 * The fixed getSellerInfo() in 1688Scraper.ts now reads the seller info
 * from the React fiber's `dataJson.frontSellerMemberModel`. This task
 * re-visits each affected product, re-extracts seller info, and updates
 * products_raw — without re-scraping images, variants, specs, etc. (which
 * are expensive and unchanged).
 *
 * Usage:
 *   node dist/tasks/task2c-backfill-seller-info.js --limit 50
 *   node dist/tasks/task2c-backfill-seller-info.js              # all missing
 */
import { create1688Scraper } from '../scrapers/1688Scraper';
import { closeDatabase, getPool } from '../database/db';
import { createChildLogger } from '../utils/logger';
import { sleep } from '../utils/helpers';
import { RowDataPacket } from 'mysql2';

const logger = createChildLogger('task2c-backfill');

function parseArgs(): { limit: number; headless: boolean } {
  const args = process.argv.slice(2);
  let limit = 0;
  let headless = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) { limit = parseInt(args[++i], 10); }
    else if (args[i] === '--headless') { headless = true; }
  }
  return { limit, headless };
}

async function getMissingSellerProducts(limit: number) {
  const p = await getPool();
  const sql = `
    SELECT pr.product_id AS productId, p.id_1688 AS id1688, p.url
    FROM products_raw pr
    JOIN products p ON p.id = pr.product_id
    WHERE (pr.seller_wangwang_id IS NULL OR pr.seller_wangwang_id = '')
      AND p.url IS NOT NULL AND p.url <> ''
    ORDER BY pr.product_id
    ${limit > 0 ? `LIMIT ${limit}` : ''}
  `;
  const [rows] = await p.execute<RowDataPacket[]>(sql);
  return rows as Array<{ productId: number; id1688: string; url: string }>;
}

async function updateSellerInfo(
  productId: number,
  info: { name: string; sellerId: string; shopUrl: string; wangwangId: string },
) {
  const p = await getPool();
  await p.execute(
    `UPDATE products_raw SET
       seller_wangwang_id = COALESCE(NULLIF(?, ''), seller_wangwang_id),
       seller_id          = COALESCE(NULLIF(?, ''), seller_id),
       seller_shop_url    = COALESCE(NULLIF(?, ''), seller_shop_url),
       seller_name        = COALESCE(NULLIF(?, ''), seller_name)
     WHERE product_id = ?`,
    [info.wangwangId || '', info.sellerId || '', info.shopUrl || '', info.name || '', productId]
  );
}

async function main() {
  const { limit, headless } = parseArgs();
  logger.info('Task 2c starting', { limit: limit || 'unlimited', headless });

  const products = await getMissingSellerProducts(limit);
  logger.info(`Found ${products.length} products missing seller_wangwang_id`);
  if (products.length === 0) {
    await closeDatabase();
    return;
  }

  const scraper = create1688Scraper();
  await scraper.initialize(headless);

  let okCount = 0;
  let failCount = 0;
  try {
    for (let i = 0; i < products.length; i++) {
      const { productId, id1688, url } = products[i];
      logger.info(`[${i + 1}/${products.length}] Backfilling product ${productId} (${id1688})`);
      try {
        const page = (scraper as any).page;
        if (!page) throw new Error('scraper page not initialized');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        // Give React a moment to hydrate the shop-navigation module
        await sleep(2500);
        const info = await scraper.getSellerInfo();

        if (info.wangwangId || info.sellerId || info.shopUrl) {
          await updateSellerInfo(productId, info);
          logger.info('Updated', {
            productId,
            wangwangId: info.wangwangId?.substring(0, 40),
            sellerId: info.sellerId?.substring(0, 40),
            hasShopUrl: !!info.shopUrl,
          });
          okCount += 1;
        } else {
          logger.warn('No seller info extracted', { productId, id1688 });
          failCount += 1;
        }
      } catch (e) {
        logger.error('Backfill failed for product', { productId, error: (e as Error).message });
        failCount += 1;
      }
      // Light throttle so we don't hammer 1688
      await sleep(800);
    }
  } finally {
    await scraper.close();
    await closeDatabase();
  }

  logger.info(`Task 2c done. OK=${okCount} FAIL=${failCount} total=${products.length}`);
}

main().catch((e) => {
  logger.error('Fatal', { error: (e as Error).message });
  process.exit(1);
});
