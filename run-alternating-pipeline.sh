#!/bin/bash
# Alternating pipeline: Task 1 (batch) → Task 1B → Task 2 → Task 3 → Task 8B → Task 4 → Task 5 → repeat
# This keeps products flowing continuously instead of waiting for all categories to finish first.
#
# PLATFORM SCOPE: AliExpress (2087779) + eBay + Etsy + Amazon — ALL active platforms.
#   AliExpress / eBay / Etsy: automated brand-safe discovery (Task 1 → pipeline).
#   Amazon: manually vetted sellers in providers table (trust_level='verified').
#     → Products enter with source_type='manual_seller' and provider_id set.
#     → Task 8B reads providers.target_platforms to authorize for the right platforms.
#     → New verified providers are added via the 3c-outreach skill workflow.
#
# PHASE: 1 (brand-safe categories only — 108 of 335 blue-ocean categories).
#   Task 8B fast-tracks brand_safe_discovery products instantly.
#   Phase 2 (general categories) requires explicit user approval — see CLAUDE.md.
#
# Usage: bash run-alternating-pipeline.sh [batch_size] [limit_per_category]
#   batch_size: categories per Task 1 batch (default: 5)
#   limit_per_category: products per category (default: 25)

BATCH_SIZE=${1:-5}
LIMIT=${2:-25}
ROUND=0

echo "========================================"
echo "Alternating Pipeline — batch=$BATCH_SIZE, limit=$LIMIT"
echo "========================================"

while true; do
  ROUND=$((ROUND + 1))
  echo ""
  echo "════════ Round $ROUND ════════"
  echo "[$(date +%H:%M:%S)] Task 1: Discovering $BATCH_SIZE categories (--resume skips completed)..."

  node dist/tasks/task1-discover.js --all-blue-ocean --limit "$LIMIT" --batch "$BATCH_SIZE" --resume 2>&1
  TASK1_EXIT=$?

  if [ $TASK1_EXIT -ne 0 ]; then
    echo "[$(date +%H:%M:%S)] Task 1 failed (exit $TASK1_EXIT), waiting 30s before retry..."
    sleep 30
    continue
  fi

  # Check if there are any categories left
  REMAINING=$(node -e "
    const fs = require('fs');
    const path = require('path');
    const terms = JSON.parse(fs.readFileSync(path.join(__dirname, 'dist/data/blue-ocean-search-terms.json'), 'utf8'));
    const enabled = Object.entries(terms).filter(([k,v]) => k !== '_meta' && v.enabled).length;
    console.log(enabled);
  " 2>/dev/null || echo "0")

  echo "[$(date +%H:%M:%S)] Task 1B: Brand pre-filter..."
  node dist/tasks/task1b-brand-prefilter.js --limit 500 2>&1 | tail -3

  echo "[$(date +%H:%M:%S)] Task 2: Scraping details for discovered products..."
  node dist/tasks/task2-scrape-details.js --limit 200 --headless 2>&1 | tail -5
  TASK2_EXIT=$?

  if [ $TASK2_EXIT -ne 0 ]; then
    echo "[$(date +%H:%M:%S)] Task 2 failed (exit $TASK2_EXIT), continuing to Task 3..."
  fi

  echo "[$(date +%H:%M:%S)] Task 3: Image checking..."
  node dist/tasks/task3-image-check.js --limit 500 2>&1 | tail -3

  echo "[$(date +%H:%M:%S)] Task 8B: Auto-verify (price + brand layers)..."
  node dist/tasks/task8b-auto-verify.js --limit 500 2>&1 | tail -5

  echo "[$(date +%H:%M:%S)] Task 4: Translating authorized products..."
  node dist/tasks/task4-translate.js --limit 100 2>&1 | tail -3

  echo "[$(date +%H:%M:%S)] Task 5: Enriching translated products..."
  node dist/tasks/task5-ae-enrich.js --limit 100 2>&1 | tail -3

  # Show pipeline status
  echo "[$(date +%H:%M:%S)] Pipeline status after round $ROUND:"
  mysql -u root -p***REMOVED*** 1688_source -e "
    SELECT status, COUNT(*) cnt FROM products
    WHERE status IN ('discovered','detail_scraped','images_checked','translated','ae_enriched')
    GROUP BY status ORDER BY FIELD(status,'discovered','detail_scraped','images_checked','translated','ae_enriched');
  " 2>/dev/null

  echo "[$(date +%H:%M:%S)] Round $ROUND complete. Starting next round..."
  sleep 5
done
