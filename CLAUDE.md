# 1688 Scrapper — Project Rules & Context

## CRITICAL RULES — HIGHEST PRIORITY

**3C AMAZON STRATEGY (2026-04-07): Use the normal pipeline (Task 1→2→3→8→4→5).**
- 12 Amazon 3C categories are now enabled in `src/data/blue-ocean-search-terms.json` (`l1: "Amazon 3C"`, `enabled: true`, `target_platform: "amazon"`).
- Banned: **Earphones** (52 violations history — see root CLAUDE.md).
- Discovery flow: Task 1 finds 3C products → Task 2 scrapes details (extracts seller info from product pages) → Task 8 brand_verify outreach uses real wangwang nicks from `products_raw.seller_wangwang_id`.
- **DEPRECATED: Task 10 + Task 11** (`task10-3c-supplier-discover.ts`, `task11-3c-supplier-outreach.ts`) — these search 1688's company directory for factories and try to outreach by `platform_id`. The platform_id routes to Taobao accounts which bounce server-side. **Do not run these tasks**. Full postmortem: `documents/3C_OUTREACH_LESSONS_LEARNED.md`.
- The OLD `compliance_contacts.outreach_type='3c_amazon_outreach'` rows (469 sellers, mostly `pending`) are stale and unreachable via that path. They should be left alone — when their products get discovered via Task 1's normal flow, they'll automatically be re-contacted via Task 8 with correct routing.

**BRAND SAFETY — 548+ brands in `1688_source.brand_list` DB.**
- `isBannedBrand()` in `src/utils/helpers.ts` checks against the DB (with JSON fallback).
- Checked at Task 1 (title) and Task 2 (title, description, specs, variants, seller name).
- Substring matching must ALWAYS be aggressive (`exactMatch = false` for all brands). Safety over false positives.
- Do NOT auto-authorize products based on spec "品牌: 无" — sellers lie. All products must go through Task 8 seller verification.
- When seller claims a brand not in banned list (likely their own), Task 8 asks for authorization docs. Company info is in `1688_source.company_info` table — only shared after seller agrees.
- Brand import CLI: `node dist/tasks/task-brand-import.js --source violation --brand "X" --category Y`
- Full strategy: `documents/aliexpress-store/BRAND_SAFETY_STRATEGY.md`

---

## What This Project Does

Standalone pipeline that scrapes products from 1688.com (Chinese wholesale marketplace):
1. **Task 1**: Discovers products by category search
2. **Task 2**: Scrapes full product details (images, variants, specs, prices)
3. **Task 3**: Validates images (rejects Chinese text / watermarks via OCR)
4. **Task 4**: Populates `_en` fields + converts CNY→USD prices (see **1688 English Mode** below)

Output is stored in the `1688_source` MySQL database, ready for consumption by any downstream store (eBay, Etsy, Amazon, etc.).

---

## Architecture

### Two-Machine Setup

| Machine | IP | Role | Tasks |
|---------|-----|------|-------|
| **China MacBook** | `config/china-macbook.env` | Inside China firewall, primary scraping | Tasks 1-4 (using Baidu/Tesseract) |
| **Main Computer** | localhost | Outside China firewall | Tasks 3-4 (using Google APIs) |

**1688 English Mode (2026-03-25) — IMPORTANT:**
The Puppeteer browser is launched with `--lang=en-US` (already in the `1688Scraper.ts` launch args). 1688.com respects this flag and serves all content in English — titles, descriptions, specs, variant names. This means:
- Task 1 scrapes English product titles directly into `title_zh` (field name is misleading — content IS English)
- Task 2 scrapes English titles, descriptions, specs, and variant names into all `_zh` fields
- **Task 4 detects this** via `isAlreadyEnglish()` (< 10% CJK characters = English) and **skips the translation API entirely** — it just copies `_zh` → `_en` and converts CNY→USD
- Translation API (Baidu/Google) is **only called as fallback** if content is genuinely Chinese
- This eliminates translation API costs for all normally-scraped products
- The `_zh` field names are kept as-is in the DB schema (no migration needed)
- **Full doc:** `documents/1688-source/ENGLISH_MODE.md`

- SSH: see root `config/china-macbook.env`
- SSH flags needed: `-o PreferredAuthentications=password -o PubkeyAuthentication=no`
- Remote commands need: `export PATH=/opt/homebrew/bin:$PATH && source ~/.nvm/nvm.sh`
- MySQL runs on China MacBook: root / `***REMOVED***`, database `1688_source`

### API Providers (auto-detected from .env)

| Service | China MacBook | Main Computer | Notes |
|---------|--------------|---------------|-------|
| **Translation** | Baidu Translate API | Google Translate | **Rarely called** — skipped when content is already English (see above) |
| **Image OCR** | Tesseract.js (local) | Google Vision | |

### Tech Stack

- **Runtime**: Node.js + TypeScript (ES2020, commonjs)
- **Browser Automation**: Puppeteer + puppeteer-extra-plugin-stealth
- **Database**: MySQL 2 (mysql2/promise)
- **Translation**: Baidu or Google Translate API (auto-detected)
- **Image OCR**: Tesseract.js or Google Vision API (auto-detected)
- **Logging**: Winston (file + console)

### Build

```bash
./node_modules/.bin/tsc    # NOT `npx tsc` — installs wrong package
```

---

## Pipeline: 6 Tasks (Task 8 before Task 4)

Each task is a standalone CLI script. Run in this order:
**Task 1 → 1B (brand pre-filter) → 2 → 3 → 8 (brand verify) → 4 (translate) → 5 (AE enrich)**

Task 1B catches branded products BEFORE we waste time scraping them (Task 2).
Task 8 runs BEFORE Task 4 to save translation fees — only authorized products get translated.

### Task 1: Product Discovery (`src/tasks/task1-discover.ts`)
- **Input**: Category name + limit
- **Output**: Rows in `products` table with status `discovered`
- **What it does**: Searches 1688.com, filters by brand/price/MOQ, inserts basic info

```bash
node dist/tasks/task1-discover.js --category earphones --limit 20
```

### Task 1B: Brand Pre-Filter (`src/tasks/task1b-brand-prefilter.ts`)
- **Input**: Products with status `discovered`
- **Output**: Branded/suspicious products → `skipped`; clean products stay `discovered`
- **What it does**: Re-checks titles against latest brand_list, flags suspicious patterns (同款/原单/大牌), checks blacklisted provider URLs, checks prior violation records. No browser needed.

```bash
node dist/tasks/task1b-brand-prefilter.js --limit 100
```

### Task 2: Detail Scraping (`src/tasks/task2-scrape-details.ts`)
- **Input**: Products with status `discovered`
- **Output**: Populated `products_raw`, `products_images_raw`, `products_variants_raw` tables; status → `detail_scraped`

```bash
node dist/tasks/task2-scrape-details.js --limit 10
```

### Task 3: Image Checking (`src/tasks/task3-image-check.ts`)
- **Input**: Products with status `detail_scraped`
- **Output**: `products_images_ok` table; status → `images_checked` or `skipped`
- **What it does**: Analyzes each image via OCR for Chinese text/watermarks. Requires >= 3 passing gallery images.

```bash
node dist/tasks/task3-image-check.js --limit 10
```

### Task 4: Translation / Pass-through (`src/tasks/task4-translate.ts`)
- **Input**: Products with status `images_checked` AND `authorized_products.active = TRUE`
- **Output**: `products_en`, `products_variants_en` tables; status → `translated`
- **English fast-path (2026-03-25):** If `isAlreadyEnglish(title) && isAlreadyEnglish(description)` (< 10% CJK chars), skips translation API entirely — copies `_zh` fields directly to `_en` fields. CNY→USD price conversion always runs. Falls back to Baidu/Google API only if content is genuinely Chinese.

```bash
node dist/tasks/task4-translate.js --limit 10
```

### Task 5: AliExpress Enrichment (`src/tasks/task5-ae-enrich.ts`)
- **Input**: Products with status `translated`
- **Output**: `products_ae_match` table; status → `ae_enriched` or `skipped`
- **What it does**: Checks if product images contain Chinese text. If yes, searches AliExpress for the same product — uses AE images/English info if found, skips if not. Clean products advance directly.

```bash
node dist/tasks/task5-ae-enrich.js --limit 10
```

### npm shortcuts

```bash
npm run task:discover -- --category earphones --limit 20
npm run task:scrape -- --limit 10
npm run task:images -- --limit 10
npm run task:translate -- --limit 10
npm run task:ae-enrich -- --limit 10
```

### Full pipeline script

```bash
bash run-pipeline.sh    # Runs all 5 tasks across all categories
```

---

## Image Strategy — CRITICAL RULE

**Chinese text in product images CANNOT be reliably translated or removed.** Instead, follow this approach:

1. **No Chinese text in images** → Use the 1688 images directly. Product proceeds through pipeline normally.
2. **Chinese text detected in images** → Search AliExpress for the SAME product:
   - **Found on AliExpress** → Use AliExpress images + English title/description. Keep 1688 pricing (we source from 1688).
   - **NOT found on AliExpress** → **Skip the product entirely.** Do not list products with Chinese text images.

This rule is enforced by Task 5 (AE Enrichment). The old image translation approach (OCR + overlay/blur) has been retired because the quality is not good enough for production listings.

---

## Database Schema (`1688_source`)

### Multi-Store Architecture — `product_store_targets`

Every product is scraped for a specific platform store. The `product_store_targets` table maps products to their target stores and tracks per-store export status.

```sql
CREATE TABLE IF NOT EXISTS product_store_targets (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  product_id       INT NOT NULL,
  platform         VARCHAR(50) NOT NULL,     -- 'aliexpress' | 'amazon' | 'etsy' | 'ebay'
  store_id         VARCHAR(100) NOT NULL,    -- platform store ID (e.g., '2087779' for AliExpress)
  blue_ocean_category VARCHAR(200),          -- CLI category from the store's blue-ocean file
  status           VARCHAR(50) DEFAULT 'pending',  -- 'pending' | 'exported' | 'listed'
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_product_store (product_id, platform, store_id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);
```

**When to populate**: Task 1 (discover) should insert a row here for every discovered product, tagging it with `platform='aliexpress'`, `store_id='2087779'` (or the relevant store). Downstream listing tasks update `status` to `exported` / `listed`.

**Convenience columns on `products`**: For the common single-store case, `products` also has:
- `target_platform VARCHAR(50)` — primary target platform (default: `aliexpress`)
- `target_store_id VARCHAR(100)` — primary target store ID (default: `2087779`)

These are redundant with `product_store_targets` but simplify queries in single-store contexts.

**Migration** (run on China MacBook MySQL):
```sql
-- Add convenience columns to products table
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS target_platform VARCHAR(50) DEFAULT 'aliexpress',
  ADD COLUMN IF NOT EXISTS target_store_id  VARCHAR(100) DEFAULT '2087779';

-- Create store targets table
CREATE TABLE IF NOT EXISTS product_store_targets (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  product_id       INT NOT NULL,
  platform         VARCHAR(50) NOT NULL,
  store_id         VARCHAR(100) NOT NULL,
  blue_ocean_category VARCHAR(200),
  status           VARCHAR(50) DEFAULT 'pending',
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_product_store (product_id, platform, store_id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);
```

### Active Store IDs

| Platform | Store ID | Main Category |
|----------|----------|---------------|
| AliExpress | `2087779` | Clothing & Apparel + Accessories |
| Amazon | PENDING | 3C / Consumer Electronics |

Blue-ocean category files: `documents/{platform}-store/{platform}-{store-id}-blue-ocean-categories.md`

---

### `products` (main table, tracks status)
- `id`, `id_1688` (unique), `status`, `url`, `title_zh`, `category`, `thumbnail_url`
- `target_platform` (default: `aliexpress`), `target_store_id` (default: `2087779`) — primary target store
- `raw_data` (JSON, legacy — normalized tables are the source of truth)
- Status flow: `discovered` → `detail_scraped` → `images_checked` → `translated` → `ae_enriched`

### `products_raw` (Task 2 output)
- `product_id` (FK, unique), `title_zh`, `description_zh`, `specifications_zh` (JSON), `price_cny`, `min_order_qty`, `seller_name`, `seller_rating`

### `products_images_raw` (Task 2 output)
- `product_id` (FK), `image_url`, `image_type` (gallery/description/variant), `sort_order`, `variant_value`

### `products_variants_raw` (Task 2 output)
- `product_id` (FK), `option_name`, `option_value`, `price_cny`, `stock`, `image_url`, `available`, `sort_order`

### `products_images_ok` (Task 3 output)
- `product_id` (FK), `raw_image_id` (FK), `image_url`, `image_type`, `has_chinese_text`, `has_watermark`, `passed`

### `products_en` (Task 4 output)
- `product_id` (FK, unique), `title_en`, `description_en`, `specifications_en` (JSON), `price_usd`, `category`

### `products_variants_en` (Task 4 output)
- `product_id` (FK), `option_name_en`, `option_value_en`, `option_value_zh`, `price_usd`, `color_family`, `sort_order`

### `products_ae_match` (Task 5 output)
- `product_id` (FK, unique), `ae_product_id`, `ae_url`, `ae_title`, `ae_images` (JSON), `ae_description`, `match_score`, `has_chinese_images` (whether 1688 images had Chinese text)

---

## Key File Map

```
src/
  config.ts                         — Environment config (1688, filters, DB, paths)
  models/product.ts                 — All interfaces, ProductStatus, ProductRecord

  database/
    db.ts                           — MySQL pool, schema init (9 tables)
    repositories.ts                 — CRUD for all normalized tables

  scrapers/1688Scraper.ts           — Puppeteer scraper for 1688.com (~1600 lines)

  services/
    translator.ts                   — Baidu/Google Translate (auto-detected)
    imageAnalyzer.ts                — Google Vision / Tesseract.js (auto-detected)
    imageTranslator.ts              — Image text translation (DEPRECATED — retired)
    aeSearcher.ts                   — AliExpress product search + matching (NEW)
    priceConverter.ts               — CNY→USD conversion with caching

  tasks/
    task1-discover.ts               — Product discovery from 1688 search
    task2-scrape-details.ts         — Full detail scraping into normalized tables
    task3-image-check.ts            — Image OCR analysis
    task4-translate.ts              — Translation + price conversion
    task5-ae-enrich.ts              — AliExpress enrichment for products with Chinese images (NEW)

  utils/
    helpers.ts                      — isBannedBrand(), findClosestColorFamily(), etc.
    logger.ts                       — Winston logger setup
```

---

## Technical Gotchas

- **1688.com uses GBK encoding**, not UTF-8. Chinese chars in URLs get garbled. Always type into the search bar via Puppeteer, never construct URL params with Chinese.
- **MySQL JSON columns return parsed objects**, not strings. Always use: `typeof x === 'string' ? JSON.parse(x) : x`
- **Build**: Use `./node_modules/.bin/tsc` not `npx tsc` (npx installs wrong package on China MacBook)

---

## Sync Workflow

Both machines share the same git repo at `git@github.com:vbhex/1688_scrapper.git`:

```bash
# On China MacBook (after making changes):
git add -A && git commit -m "description" && git push

# On Main Computer (to get latest):
git pull origin main
```

**China MacBook project path**: `~/projects/autostore/1688_scrapper`
**Main Computer project path**: `/Library/WebServer/Documents/autostore/1688_scrapper`

---

## Downstream Consumers

This project produces data in `1688_source` database. Downstream projects read from it:

- **AliExpress** (`/Library/WebServer/Documents/autostore/aliexpress/`): Takes translated/enriched products → Excel generation → bulk upload → polish
- **Amazon** (`/Library/WebServer/Documents/autostore/amazon/`): Amazon store listing
- **eBay** (`/Library/WebServer/Documents/autostore/ebay/`): eBay store listing
- **Etsy** (`/Library/WebServer/Documents/autostore/etsy/`): Etsy store listing
