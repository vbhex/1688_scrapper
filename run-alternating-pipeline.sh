#!/bin/bash
# Alternating pipeline: Task 1 (batch) → Task 2 → Task 3 → repeat
# This keeps products flowing to Task 8 continuously instead of waiting
# for all 437 categories to be discovered first.
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
