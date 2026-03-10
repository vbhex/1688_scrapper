#!/bin/bash
# Run the full clothing pipeline: discover → scrape → image check → translate → AE enrich
# Execute on China MacBook: cd ~/projects/autostore/1688_scrapper && bash run-pipeline.sh
#
# STRATEGY (2026-03-10): Niche-specific search terms to avoid AliExpress "Duplicate Laying".
# Generic terms (女士T恤, 男士T恤) yield commodity items that fail AE duplicate check.
# Full search term mapping: src/scrapers/1688Scraper.ts → categoryKeywords

set -e

echo "============================================"
echo "  1688 SCRAPPER PIPELINE — Clothing & Apparel"
echo "  $(date)"
echo "============================================"

# Ensure we're in the right directory
cd "$(dirname "$0")"
export PATH=/opt/homebrew/bin:$PATH

# Build TypeScript first
echo ""
echo "=== BUILD: Compiling TypeScript ==="
./node_modules/.bin/tsc
echo "  -> Build complete."

# Reset products that were discovered but not yet scraped (clean slate each run)
echo ""
echo "=== RESET: Removing un-scraped discovered products ==="
mysql -u root -p***REMOVED*** 1688_source -e "
  DELETE FROM products WHERE status = 'discovered';
" 2>/dev/null
echo "  -> Cleared previously discovered products."

echo ""
echo "=== STEP 1: DISCOVER products — Clothing & Apparel (niche search terms) ==="

run_task() {
  echo ""
  echo "------------------------------------------"
  echo "  $1"
  echo "------------------------------------------"
  eval "$2"
  echo "  -> Done."
}

# ── Women's — Broad (outerwear, pants, dresses vary enough naturally) ─────────
run_task "Discover: 连衣裙 / womens dresses (25)" \
  "node dist/tasks/task1-discover.js --category 'womens dresses' --limit 25"

run_task "Discover: 女士外套 / womens jackets (20)" \
  "node dist/tasks/task1-discover.js --category 'womens jackets' --limit 20"

run_task "Discover: 女士休闲裤 / womens pants (20)" \
  "node dist/tasks/task1-discover.js --category 'womens pants' --limit 20"

# ── Women's — Niched (plain tees/hoodies failed as Duplicate Laying) ──────────
run_task "Discover: 波西米亚连衣裙 / womens boho dresses (20)" \
  "node dist/tasks/task1-discover.js --category 'womens boho' --limit 20"

run_task "Discover: 碎花裙 / womens floral (20)" \
  "node dist/tasks/task1-discover.js --category 'womens floral' --limit 20"

run_task "Discover: 女士印花T恤 / womens printed tops (20)" \
  "node dist/tasks/task1-discover.js --category 'womens tops' --limit 20"

run_task "Discover: 女士oversize卫衣 / womens oversized hoodies (20)" \
  "node dist/tasks/task1-discover.js --category 'womens hoodies' --limit 20"

run_task "Discover: 女士运动套装 / womens athletic sets (20)" \
  "node dist/tasks/task1-discover.js --category 'womens sets' --limit 20"

run_task "Discover: 女士针织开衫 / womens cardigans (15)" \
  "node dist/tasks/task1-discover.js --category 'womens cardigan' --limit 15"

run_task "Discover: 女士毛衣 / womens sweaters (15)" \
  "node dist/tasks/task1-discover.js --category 'womens sweater' --limit 15"

# ── Men's ─────────────────────────────────────────────────────────────────────
run_task "Discover: 男士印花T恤 / mens graphic tees (20)" \
  "node dist/tasks/task1-discover.js --category 'mens graphic' --limit 20"

run_task "Discover: 男士连帽卫衣印花 / mens printed hoodies (20)" \
  "node dist/tasks/task1-discover.js --category 'mens hoodies' --limit 20"

run_task "Discover: 男士花衬衫 / mens patterned shirts (20)" \
  "node dist/tasks/task1-discover.js --category 'mens shirts' --limit 20"

run_task "Discover: 男士休闲裤 / mens casual pants (20)" \
  "node dist/tasks/task1-discover.js --category 'mens pants' --limit 20"

run_task "Discover: 男士工装裤 / mens cargo pants (15)" \
  "node dist/tasks/task1-discover.js --category 'mens cargo' --limit 15"

# ── Unisex / Streetwear ───────────────────────────────────────────────────────
run_task "Discover: Y2K潮流服装 / Y2K streetwear (20)" \
  "node dist/tasks/task1-discover.js --category 'streetwear' --limit 20"

run_task "Discover: 情侣潮牌T恤 / unisex graphic tees (15)" \
  "node dist/tasks/task1-discover.js --category 'unisex graphic' --limit 15"

echo ""
echo "=== STEP 2: SCRAPE product details ==="
run_task "Scrape details (limit 400)" \
  "node dist/tasks/task2-scrape-details.js --limit 400"

echo ""
echo "=== STEP 3: IMAGE CHECK ==="
run_task "Image check (limit 400)" \
  "node dist/tasks/task3-image-check.js --limit 400"

echo ""
echo "=== STEP 4: TRANSLATE ==="
run_task "Translate (limit 400)" \
  "node dist/tasks/task4-translate.js --limit 400"

echo ""
echo "=== STEP 5: AE ENRICHMENT ==="
echo "  (Replaces Chinese-text images with AliExpress images, skips products with no match)"
run_task "AE Enrich (limit 400)" \
  "node dist/tasks/task5-ae-enrich.js --limit 400"

echo ""
echo "=== FINAL STATUS ==="
mysql -u root -p***REMOVED*** 1688_source -e "
  SELECT status, category, COUNT(*) as cnt
  FROM products
  GROUP BY status, category
  ORDER BY status, cnt DESC;
" 2>/dev/null

echo ""
echo "============================================"
echo "  PIPELINE COMPLETE! $(date)"
echo "  Data is ready in 1688_source database."
echo "  Next: run import-from-1688source.js on aliexpress project,"
echo "        then task5-excel-gen, then upload to AliExpress."
echo "============================================"
