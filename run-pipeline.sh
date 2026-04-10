#!/bin/bash
# Run the full pipeline: discover → scrape → image check → translate → AE enrich
# Execute on local machine: cd ~/projects/autostore/1688_scrapper && bash run-pipeline.sh
#
# RED OCEAN RULE (2026-03-20): Women's Clothing + Men's Clothing L1 = permanently BANNED.
# Active targets: Watches, Apparel Accessories (Hats, Scarves, Hair, Eyewear, Belts, Gloves)
# Full strategy: documents/aliexpress-store/aliexpress-2087779-blue-ocean-categories.md

set -e

echo "============================================"
echo "  1688 SCRAPPER PIPELINE — Watches & Accessories"
echo "  $(date)"
echo "============================================"

# Ensure we're in the right directory
cd "$(dirname "$0")"
export PATH=/opt/homebrew/bin:$PATH

# Build TypeScript first
echo ""
echo "=== BUILD: Compiling TypeScript ==="
./node_modules/.bin/tsc 2>&1 | grep -v "task-backfill\|task8-wangwang" | tail -5
echo "  -> Build complete."

echo ""
echo "=== STEP 1: DISCOVER products — Watches & Apparel Accessories ==="

run_task() {
  echo ""
  echo "------------------------------------------"
  echo "  $1"
  echo "------------------------------------------"
  eval "$2"
  echo "  -> Done."
}

# ── Watches ───────────────────────────────────────────────────────────────────
run_task "Discover: 石英表 / quartz watches (30)" \
  "node dist/tasks/task1-discover.js --category 'quartz watches' --limit 30 --headless"

run_task "Discover: 时尚腕表 / fashion watches (30)" \
  "node dist/tasks/task1-discover.js --category 'fashion watches' --limit 30 --headless"

run_task "Discover: 情侣表 / couple watches (25)" \
  "node dist/tasks/task1-discover.js --category 'couple watches' --limit 25 --headless"

run_task "Discover: 数字运动手表 / digital watches (25)" \
  "node dist/tasks/task1-discover.js --category 'digital watches' --limit 25 --headless"

# ── Hats & Caps ───────────────────────────────────────────────────────────────
run_task "Discover: 渔夫帽 / bucket hats (30)" \
  "node dist/tasks/task1-discover.js --category 'bucket hats' --limit 30 --headless"

run_task "Discover: 棒球帽 / baseball caps (25)" \
  "node dist/tasks/task1-discover.js --category 'baseball caps' --limit 25 --headless"

run_task "Discover: 针织帽 / beanies (25)" \
  "node dist/tasks/task1-discover.js --category 'beanies' --limit 25 --headless"

run_task "Discover: 牛仔帽 / cowboy hats (20)" \
  "node dist/tasks/task1-discover.js --category 'cowboy hats' --limit 20 --headless"

# ── Scarves ───────────────────────────────────────────────────────────────────
run_task "Discover: 真丝丝巾 / silk scarves (25)" \
  "node dist/tasks/task1-discover.js --category 'silk scarves' --limit 25 --headless"

run_task "Discover: 针织围巾 / winter scarves (25)" \
  "node dist/tasks/task1-discover.js --category 'winter scarves' --limit 25 --headless"

run_task "Discover: 防晒丝巾 / sun scarves (20)" \
  "node dist/tasks/task1-discover.js --category 'sun scarves' --limit 20 --headless"

# ── Hair Accessories ──────────────────────────────────────────────────────────
run_task "Discover: 鲨鱼夹 / hair claws (30)" \
  "node dist/tasks/task1-discover.js --category 'hair claws' --limit 30 --headless"

run_task "Discover: 发夹发卡 / hair pins (25)" \
  "node dist/tasks/task1-discover.js --category 'hair pins' --limit 25 --headless"

run_task "Discover: 发饰套装 / hair accessories set (20)" \
  "node dist/tasks/task1-discover.js --category 'hair accessories set' --limit 20 --headless"

# ── Eyewear ───────────────────────────────────────────────────────────────────
run_task "Discover: 防蓝光眼镜 / blue light glasses (30)" \
  "node dist/tasks/task1-discover.js --category 'blue light glasses' --limit 30 --headless"

run_task "Discover: 老花眼镜 / reading glasses (25)" \
  "node dist/tasks/task1-discover.js --category 'reading glasses' --limit 25 --headless"

run_task "Discover: 偏光太阳镜 / polarized sunglasses (25)" \
  "node dist/tasks/task1-discover.js --category 'polarized sunglasses' --limit 25 --headless"

run_task "Discover: 运动太阳镜 / sports sunglasses (25)" \
  "node dist/tasks/task1-discover.js --category 'sports sunglasses' --limit 25 --headless"

# ── Belts & Gloves ────────────────────────────────────────────────────────────
run_task "Discover: 时尚皮带 / fashion belts (20)" \
  "node dist/tasks/task1-discover.js --category 'fashion belts' --limit 20 --headless"

run_task "Discover: 时尚手套 / fashion gloves (20)" \
  "node dist/tasks/task1-discover.js --category 'fashion gloves' --limit 20 --headless"

echo ""
echo "=== STEP 2: SCRAPE product details ==="
run_task "Scrape details (limit 500)" \
  "node dist/tasks/task2-scrape-details.js --limit 500 --headless"

echo ""
echo "=== STEP 3: IMAGE CHECK ==="
run_task "Image check (limit 500)" \
  "node dist/tasks/task3-image-check.js --limit 500"

echo ""
echo "=== STEP 4: TRANSLATE ==="
run_task "Translate (limit 500)" \
  "node dist/tasks/task4-translate.js --limit 500"

echo ""
echo "=== STEP 5: AE ENRICHMENT ==="
echo "  (Replaces Chinese-text images with AliExpress images, skips products with no match)"
run_task "AE Enrich (limit 500)" \
  "node dist/tasks/task5-ae-enrich.js --limit 500"

echo ""
echo "=== FINAL STATUS ==="
mysql -u root -p$MYSQL_PASSWORD 1688_source -e "
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
