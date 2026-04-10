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
  # Join via platform_id=seller_id (provider_id col is often NULL in compliance_contacts)
  NEED_OUTREACH=$(mysql -u root -p$MYSQL_PASSWORD 1688_source 2>/dev/null -e "
    SELECT COUNT(*) FROM providers p
    WHERE p.source = '3c_outreach' AND p.trust_level = 'new'
      AND p.platform_id NOT IN (
        SELECT DISTINCT cc.seller_id FROM compliance_contacts cc
        WHERE cc.outreach_type = '3c_amazon_outreach'
      );" | tail -1)
  NEED_OUTREACH=${NEED_OUTREACH:-0}

  if [ "$NEED_OUTREACH" -gt 0 ]; then
    log "[Step 2] $NEED_OUTREACH suppliers need Wangwang outreach..."
    node dist/tasks/task11-3c-supplier-outreach.js --limit 10 >> /tmp/task11-outreach.log 2>&1
    log "  Task 11 outreach done."
  else
    log "[Step 2] All discovered suppliers already contacted."
  fi

  # ─── Step 3: Check Wangwang replies (scroll inbox to find buried replies) ───
  NEED_REPLY_CHECK=$(mysql -u root -p$MYSQL_PASSWORD 1688_source 2>/dev/null -e "
    SELECT COUNT(*) FROM compliance_contacts
    WHERE outreach_type = '3c_amazon_outreach'
      AND contact_status IN ('contacted','pending');" | tail -1)
  NEED_REPLY_CHECK=${NEED_REPLY_CHECK:-0}

  if [ "$NEED_REPLY_CHECK" -gt 0 ]; then
    log "[Step 3] Checking inbox for replies from $NEED_REPLY_CHECK contacted sellers..."
    node dist/tasks/task12-3c-supplier-followup.js --action check-replies --limit 300 >> /tmp/task12-replies.log 2>&1
    tail -5 /tmp/task12-replies.log | grep -E "replied|summary|REPLIED" | while read line; do log "  $line"; done
  else
    log "[Step 3] No contacted sellers to check."
  fi

  # ─── Step 3.5: Follow-up to 7-day non-responders ───
  NEED_FOLLOWUP=$(mysql -u root -p$MYSQL_PASSWORD 1688_source 2>/dev/null -e "
    SELECT COUNT(*) FROM compliance_contacts
    WHERE outreach_type = '3c_amazon_outreach'
      AND contact_status = 'contacted'
      AND message_sent_at < DATE_SUB(NOW(), INTERVAL 7 DAY)
      AND (notes IS NULL OR notes NOT LIKE '%followup_sent%');" | tail -1)
  NEED_FOLLOWUP=${NEED_FOLLOWUP:-0}

  if [ "$NEED_FOLLOWUP" -gt 0 ]; then
    log "[Step 3.5] Sending 7-day follow-up to $NEED_FOLLOWUP non-responsive sellers..."
    node dist/tasks/task12-3c-supplier-followup.js --action followup-nonresponders --limit 15 >> /tmp/task12-followup.log 2>&1
    tail -3 /tmp/task12-followup.log | grep -E "sent|failed|summary" | while read line; do log "  $line"; done
  else
    log "[Step 3.5] No sellers need a 7-day follow-up yet."
  fi

  # ─── Step 4: Scrape stores of confirmed suppliers ───
  CONFIRMED=$(mysql -u root -p$MYSQL_PASSWORD 1688_source 2>/dev/null -e "
    SELECT COUNT(*) FROM providers
    WHERE source = '3c_outreach'
      AND trust_level IN ('verified','trusted','preferred')
      AND (last_scraped_at IS NULL OR last_scraped_at < DATE_SUB(NOW(), INTERVAL 30 DAY));" | tail -1)
  CONFIRMED=${CONFIRMED:-0}

  if [ "$CONFIRMED" -gt 0 ]; then
    log "[Step 4] $CONFIRMED confirmed suppliers need store scraping..."
    node dist/tasks/task1-discover.js --providers-only >> /tmp/task1-store-scrape.log 2>&1
    log "  Store scraping done."
  else
    log "[Step 4] No confirmed suppliers need store scraping."
  fi

  # ─── Step 5: Product pipeline ───
  PIPELINE_TODO=$(mysql -u root -p$MYSQL_PASSWORD 1688_source 2>/dev/null -e "
    SELECT COUNT(*) FROM products
    WHERE provider_id IN (SELECT id FROM providers WHERE source = '3c_outreach')
      AND status IN ('discovered','detail_scraped','images_checked');" | tail -1)
  PIPELINE_TODO=${PIPELINE_TODO:-0}

  if [ "$PIPELINE_TODO" -gt 0 ]; then
    log "[Step 5] $PIPELINE_TODO products need processing..."

    DISC=$(mysql -u root -p$MYSQL_PASSWORD 1688_source 2>/dev/null -e "
      SELECT COUNT(*) FROM products
      WHERE provider_id IN (SELECT id FROM providers WHERE source = '3c_outreach')
        AND status = 'discovered';" | tail -1)
    DISC=${DISC:-0}
    [ "$DISC" -gt 0 ] && {
      log "  Task 2: scraping $DISC products..."
      node dist/tasks/task2-scrape-details.js --limit 300 >> /tmp/task2-amazon-outreach.log 2>&1
    }

    SCRAPED=$(mysql -u root -p$MYSQL_PASSWORD 1688_source 2>/dev/null -e "
      SELECT COUNT(*) FROM products
      WHERE provider_id IN (SELECT id FROM providers WHERE source = '3c_outreach')
        AND status = 'detail_scraped';" | tail -1)
    SCRAPED=${SCRAPED:-0}
    [ "$SCRAPED" -gt 0 ] && {
      log "  Task 3: image check for $SCRAPED products..."
      node dist/tasks/task3-image-check.js --limit 300 >> /tmp/task3-amazon-outreach.log 2>&1
    }

    mysql -u root -p$MYSQL_PASSWORD 1688_source 2>/dev/null << 'SQL'
INSERT IGNORE INTO authorized_products (product_id, authorization_type, notes, active)
SELECT p.id, 'seller_confirmed',
  CONCAT('3c_outreach verified: ', pv.provider_name), TRUE
FROM products p
JOIN providers pv ON pv.id = p.provider_id
WHERE p.status = 'images_checked'
  AND pv.source = '3c_outreach'
  AND pv.trust_level IN ('verified','trusted','preferred')
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
  mysql -u root -p$MYSQL_PASSWORD 1688_source 2>/dev/null -e "
    SELECT trust_level, COUNT(*) cnt FROM providers WHERE source='3c_outreach' GROUP BY trust_level;" | tee -a $LOG

  log "Round $ROUND complete. Sleeping 15 min..."
  sleep 900
done
