#!/bin/bash
# Run the full discovery + scrape + image check + translate pipeline for Amazon categories.
# Amazon uses 21 of 24 categories (excludes: translator, gps tracker, sim router).
# Execute on China MacBook: cd ~/projects/autostore/1688_scrapper && bash run-amazon-pipeline.sh

set -e

echo "============================================"
echo "  1688 SCRAPPER PIPELINE (AMAZON)"
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

# Reset products that were discovered but not yet scraped
echo ""
echo "=== RESET: Removing un-scraped discovered products ==="
mysql -u root -p***REMOVED*** 1688_source -e "
  DELETE FROM products WHERE status = 'discovered';
" 2>/dev/null
echo "  -> Cleared previously discovered products."

echo ""
echo "=== STEP 1: DISCOVER products across 21 Amazon categories ==="

run_task() {
  echo ""
  echo "------------------------------------------"
  echo "  $1"
  echo "------------------------------------------"
  eval "$2"
  echo "  -> Done."
}

# Amazon's 21 categories (~345 products total)
# High volume (20 each)
run_task "Discover: 耳机 / earphones (20)" \
  "node dist/tasks/task1-discover.js --category 'earphones' --limit 20"

run_task "Discover: 蓝牙音箱 / speakers (20)" \
  "node dist/tasks/task1-discover.js --category 'speakers' --limit 20"

run_task "Discover: 智能手表 / smart watches (20)" \
  "node dist/tasks/task1-discover.js --category 'smart watches' --limit 20"

run_task "Discover: 游戏鼠标 / gaming mouse (20)" \
  "node dist/tasks/task1-discover.js --category 'gaming mouse' --limit 20"

run_task "Discover: 机械键盘 / mechanical keyboard (20)" \
  "node dist/tasks/task1-discover.js --category 'mechanical keyboard' --limit 20"

run_task "Discover: 无线充电器 / wireless charger (20)" \
  "node dist/tasks/task1-discover.js --category 'wireless charger' --limit 20"

run_task "Discover: 充电宝 / power bank (20)" \
  "node dist/tasks/task1-discover.js --category 'power bank' --limit 20"

run_task "Discover: 监控摄像头 / ip camera (20)" \
  "node dist/tasks/task1-discover.js --category 'ip camera' --limit 20"

run_task "Discover: 领夹麦克风 / lavalier microphone (20)" \
  "node dist/tasks/task1-discover.js --category 'lavalier microphone' --limit 20"

# Medium volume (15 each)
run_task "Discover: 回音壁音响 / soundbar (15)" \
  "node dist/tasks/task1-discover.js --category 'soundbar' --limit 15"

run_task "Discover: 运动相机 / action cameras (15)" \
  "node dist/tasks/task1-discover.js --category 'action cameras' --limit 15"

run_task "Discover: 储能电源 / power station (15)" \
  "node dist/tasks/task1-discover.js --category 'power station' --limit 15"

run_task "Discover: 电脑摄像头 / webcam (15)" \
  "node dist/tasks/task1-discover.js --category 'webcam' --limit 15"

run_task "Discover: USB扩展坞 / usb hub (15)" \
  "node dist/tasks/task1-discover.js --category 'usb hub' --limit 15"

run_task "Discover: 智能门铃 / smart doorbell (15)" \
  "node dist/tasks/task1-discover.js --category 'smart doorbell' --limit 15"

run_task "Discover: 智能戒指 / smart ring (15)" \
  "node dist/tasks/task1-discover.js --category 'smart ring' --limit 15"

run_task "Discover: 太阳能充电板 / solar panel (15)" \
  "node dist/tasks/task1-discover.js --category 'solar panel' --limit 15"

# Lower volume (10 each)
run_task "Discover: 便携投影仪 / portable projector (10)" \
  "node dist/tasks/task1-discover.js --category 'portable projector' --limit 10"

run_task "Discover: VR眼镜 / vr glasses (10)" \
  "node dist/tasks/task1-discover.js --category 'vr glasses' --limit 10"

run_task "Discover: 手机散热器 / phone cooler (10)" \
  "node dist/tasks/task1-discover.js --category 'phone cooler' --limit 10"

run_task "Discover: 手持云台稳定器 / gimbal stabilizer (10)" \
  "node dist/tasks/task1-discover.js --category 'gimbal stabilizer' --limit 10"

echo ""
echo "=== STEP 2: SCRAPE product details ==="
run_task "Scrape details (limit 500)" \
  "node dist/tasks/task2-scrape-details.js --limit 500"

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
mysql -u root -p***REMOVED*** 1688_source -e "
  SELECT status, category, COUNT(*) as cnt
  FROM products
  GROUP BY status, category
  ORDER BY status, cnt DESC;
" 2>/dev/null

echo ""
echo "============================================"
echo "  AMAZON PIPELINE COMPLETE! $(date)"
echo "  Data is ready in 1688_source database."
echo "  Next: Run Amazon Excel generation"
echo "============================================"
