# 1688 Scrapper — Project Rules & Context

## CRITICAL RULE — HIGHEST PRIORITY

**NEVER scrape products from major brands.** Downstream stores (AliExpress, etc.) WILL be punished.

Banned brands include: Apple (iphone, ipad, airpods, inpods, macbook), Huaqiangbei, Samsung (galaxy buds), Sony, Bose, JBL, Beats, Nike, Adidas, Google Pixel, Microsoft, Nintendo, Dyson, GoPro, DJI, Gucci, Louis Vuitton, Prada, Rolex, Sennheiser, Lenovo, Huawei, Xiaomi, Oppo, Vivo, OnePlus, Remax, LDNIO, Anker, Baseus, and more.

The full list is in `config.ts` → `excludeBrands`. Always check titles AND descriptions with `isBannedBrand()` from `src/utils/helpers.ts` before scraping. When in doubt, skip the product.

---

## What This Project Does

Standalone pipeline that scrapes products from 1688.com (Chinese wholesale marketplace):
1. **Task 1**: Discovers products by category search
2. **Task 2**: Scrapes full product details (images, variants, specs, prices)
3. **Task 3**: Validates images (rejects Chinese text / watermarks via OCR)
4. **Task 4**: Translates everything to English + converts CNY→USD prices

Output is stored in the `1688_source` MySQL database, ready for consumption by any downstream store (AliExpress, Shopify, etc.).

---

## Architecture

### Two-Machine Setup

| Machine | IP | Role | Tasks |
|---------|-----|------|-------|
| **China MacBook** | `192.168.1.5` (static) | Inside China firewall, primary scraping | Tasks 1-4 (using Baidu/Tesseract) |
| **Main Computer** | localhost | Outside China firewall | Tasks 3-4 (using Google APIs) |

- SSH: `blueidea@192.168.1.5`, password `112233`
- SSH flags needed: `-o PreferredAuthentications=password -o PubkeyAuthentication=no`
- Remote commands need: `export PATH=/opt/homebrew/bin:$PATH && source ~/.nvm/nvm.sh`
- MySQL runs on China MacBook: root / `***REMOVED***`, database `1688_source`

### API Providers (auto-detected from .env)

| Service | China MacBook | Main Computer |
|---------|--------------|---------------|
| **Translation** | Baidu Translate API | Google Translate |
| **Image OCR** | Tesseract.js (local) | Google Vision |

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

## Pipeline: 4 Tasks

Each task is a standalone CLI script. Run them in sequence.

### Task 1: Product Discovery (`src/tasks/task1-discover.ts`)
- **Input**: Category name + limit
- **Output**: Rows in `products` table with status `discovered`
- **What it does**: Searches 1688.com, filters by brand/price/MOQ, inserts basic info

```bash
node dist/tasks/task1-discover.js --category earphones --limit 20
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

### Task 4: Translation (`src/tasks/task4-translate.ts`)
- **Input**: Products with status `images_checked`
- **Output**: `products_en`, `products_variants_en` tables; status → `translated`

```bash
node dist/tasks/task4-translate.js --limit 10
```

### npm shortcuts

```bash
npm run task:discover -- --category earphones --limit 20
npm run task:scrape -- --limit 10
npm run task:images -- --limit 10
npm run task:translate -- --limit 10
```

### Full pipeline script

```bash
bash run-pipeline.sh    # Runs all 4 tasks across all categories
```

---

## Database Schema (`1688_source`)

### `products` (main table, tracks status)
- `id`, `id_1688` (unique), `status`, `url`, `title_zh`, `category`, `thumbnail_url`
- `raw_data` (JSON, legacy — normalized tables are the source of truth)
- Status flow: `discovered` → `detail_scraped` → `images_checked` → `translated`

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

---

## Key File Map

```
src/
  config.ts                         — Environment config (1688, filters, DB, paths)
  models/product.ts                 — All interfaces, ProductStatus, ProductRecord

  database/
    db.ts                           — MySQL pool, schema init (8 tables)
    repositories.ts                 — CRUD for all normalized tables

  scrapers/1688Scraper.ts           — Puppeteer scraper for 1688.com (~1600 lines)

  services/
    translator.ts                   — Baidu/Google Translate (auto-detected)
    imageAnalyzer.ts                — Google Vision / Tesseract.js (auto-detected)
    priceConverter.ts               — CNY→USD conversion with caching

  tasks/
    task1-discover.ts               — Product discovery from 1688 search
    task2-scrape-details.ts         — Full detail scraping into normalized tables
    task3-image-check.ts            — Image OCR analysis
    task4-translate.ts              — Translation + price conversion

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

- **AliExpress AutoStore** (`/Library/WebServer/Documents/autostore/aliexpress/`): Takes translated products and generates AliExpress bulk upload Excel files (Task 5+)
- Future: Shopify, eBay, or other marketplace integrations
