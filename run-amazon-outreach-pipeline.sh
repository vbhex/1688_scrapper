#!/bin/bash
# ══════════════════════════════════════════════════════════════════
# Amazon Outreach Pipeline (Continuous)
# Profile: primary (old account with buying history)
#
# Flow:
#   Step 1: Task 10 — Discover new 3C suppliers (headless)
#   Step 2: Task 11 — Wangwang outreach to new suppliers (non-headless)
#   Step 3: Task 11 — Check Wangwang replies (non-headless)
#   Step 4: Scrape confirmed suppliers' stores (non-headless for CAPTCHAs)
#   Step 5: Product pipeline Tasks 2→3→8B→4→5 (non-headless for CAPTCHAs)
#
# Both pipelines can run visible Chrome simultaneously — they use
# different --user-data-dir profiles and no longer kill each other.
# ══════════════════════════════════════════════════════════════════

export PATH=/opt/homebrew/bin:$PATH
source ~/.nvm/nvm.sh 2>/dev/null
cd ~/projects/autostore/1688_scrapper

LOG=/tmp/amazon-outreach.log

log() { echo "[$(date '+%H:%M:%S')] $1" | tee -a $LOG; }

log "═══════════════════════════════════════════════════════════"
log "Amazon Outreach Pipeline started (profile: primary)"
log "═══════════════════════════════════════════════════════════"

ROUND=0
while true; do
  ROUND=$((ROUND + 1))
  log ""
  log "══════ Round $ROUND ══════"

  # ─── Step 1: Discover new 3C suppliers (headless) ───
  log "[Step 1] Discovering new 3C suppliers..."
  node dist/tasks/task10-3c-supplier-discover.js --limit 20 --headless >> /tmp/task10-discover.log 2>&1
  tail -5 /tmp/task10-discover.log | grep -E "New suppliers|Duplicates|Total found" | while read line; do log "  $line"; done

  # ─── Step 2: Wangwang outreach to new suppliers ───
  NEED_OUTREACH=$(mysql -u root -p***REMOVED*** 1688_source 2>/dev/null -e "
    SELECT COUNT(*) FROM providers p
    WHERE p.source = '3c_outreach' AND p.trust_level = 'new'
      AND p.id NOT IN (SELECT DISTINCT provider_id FROM compliance_contacts WHERE provider_id IS NOT NULL);" | tail -1)

  if [ "$NEED_OUTREACH" -gt 0 ]; then
    log "[Step 2] $NEED_OUTREACH suppliers need Wangwang outreach..."
    node dist/tasks/task11-wangwang-outreach.js --limit 10 >> /tmp/task11-outreach.log 2>&1
    log "  Task 11 outreach done."
  else
    log "[Step 2] No new suppliers need outreach."
  fi

  # ─── Step 3: Check Wangwang replies ───
  NEED_REPLY_CHECK=$(mysql -u root -p***REMOVED*** 1688_source 2>/dev/null -e "
    SELECT COUNT(*) FROM compliance_contacts
    WHERE contact_type = '3c_amazon_outreach'
      AND status IN ('contacted','message_sent');" | tail -1)

  if [ "$NEED_REPLY_CHECK" -gt 0 ]; then
    log "[Step 3] Checking $NEED_REPLY_CHECK pending replies..."
    node dist/tasks/task11-wangwang-outreach.js --check-replies --limit 20 >> /tmp/task11-replies.log 2>&1
    log "  Reply check done."
  else
    log "[Step 3] No pending replies to check."
  fi

  # ─── Step 4: Scrape stores of confirmed suppliers ───
  CONFIRMED=$(mysql -u root -p***REMOVED*** 1688_source 2>/dev/null -e "
    SELECT COUNT(*) FROM providers
    WHERE source = '3c_outreach'
      AND trust_level IN ('verified','certs_received')
      AND (last_scraped_at IS NULL OR last_scraped_at < DATE_SUB(NOW(), INTERVAL 30 DAY));" | tail -1)

  if [ "$CONFIRMED" -gt 0 ]; then
    log "[Step 4] $CONFIRMED confirmed suppliers need store scraping..."
    node dist/tasks/task1-discover.js --providers-only >> /tmp/task1-store-scrape.log 2>&1
    log "  Store scraping done."
  else
    log "[Step 4] No confirmed suppliers need store scraping."
  fi

  # ─── Step 5: Product pipeline ───
  PIPELINE_TODO=$(mysql -u root -p***REMOVED*** 1688_source 2>/dev/null -e "
    SELECT COUNT(*) FROM products
    WHERE provider_id IN (SELECT id FROM providers WHERE source = '3c_outreach')
      AND status IN ('discovered','detail_scraped','images_checked');" | tail -1)

  if [ "$PIPELINE_TODO" -gt 0 ]; then
    log "[Step 5] $PIPELINE_TODO products need processing..."

    DISC=$(mysql -u root -p***REMOVED*** 1688_source 2>/dev/null -e "
      SELECT COUNT(*) FROM products
      WHERE provider_id IN (SELECT id FROM providers WHERE source = '3c_outreach')
        AND status = 'discovered';" | tail -1)
    [ "$DISC" -gt 0 ] && {
      log "  Task 2: scraping $DISC products..."
      node dist/tasks/task2-scrape-details.js --limit 300 >> /tmp/task2-amazon-outreach.log 2>&1
    }

    SCRAPED=$(mysql -u root -p***REMOVED*** 1688_source 2>/dev/null -e "
      SELECT COUNT(*) FROM products
      WHERE provider_id IN (SELECT id FROM providers WHERE source = '3c_outreach')
        AND status = 'detail_scraped';" | tail -1)
    [ "$SCRAPED" -gt 0 ] && {
      log "  Task 3: image check for $SCRAPED products..."
      node dist/tasks/task3-image-check.js --limit 300 >> /tmp/task3-amazon-outreach.log 2>&1
    }

    mysql -u root -p***REMOVED*** 1688_source 2>/dev/null << 'SQL'
INSERT IGNORE INTO authorized_products (product_id, authorization_type, notes, active)
SELECT p.id, 'seller_confirmed',
  CONCAT('3c_outreach verified: ', pv.provider_name), TRUE
FROM products p
JOIN providers pv ON pv.id = p.provider_id
WHERE p.status = 'images_checked'
  AND pv.source = '3c_outreach'
  AND pv.trust_level IN ('verified','certs_received')
  AND p.id NOT IN (SELECT product_id FROM authorized_products WHERE active = TRUE);
SQL

    node dist/tasks/task8b-auto-verify.js --limit 300 >> /tmp/task8b-amazon-outreach.log 2>&1
    node dist/tasks/task4-translate.js --limit 300 >> /tmp/task4-amazon-outreach.log 2>&1
    node dist/tasks/task5-ae-enrich.js --limit 300 >> /tmp/task5-amazon-outreach.log 2>&1
    log "  Product pipeline done."
  else
    log "[Step 5] No products need processing."
  fi

  # ─── Status ───
  log ""
  mysql -u root -p***REMOVED*** 1688_source 2>/dev/null -e "
    SELECT trust_level, COUNT(*) cnt FROM providers WHERE source='3c_outreach' GROUP BY trust_level;" | tee -a $LOG

  log "Round $ROUND complete. Sleeping 15 min..."
  sleep 900
done
