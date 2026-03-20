# Plan: Add Multi-Platform Targeting to 1688 Scrapper

## Problem

The 1688_scrapper currently has no concept of platform destinations. All 24 categories flow through the same pipeline, and downstream stores have no way to know which products belong to them.

Per the Multi-Platform Category Strategy:
- **AliExpress**: all 24 categories
- **Amazon**: 21 of 24 (skip: translator, gps tracker, sim router)
- **Etsy**: 12 of 24 (earphones, smart watches, speakers, wireless charger, gaming mouse, mechanical keyboard, power bank, lavalier microphone, webcam, smart ring, gimbal stabilizer, phone cooler)
- **eBay**: TBD (manual investigation, excluded from this change)

## Approach

**Minimal changes** — don't break the existing pipeline or AliExpress flow. Add platform awareness as a new layer on top.

### 1. Add `PLATFORM_CATEGORIES` mapping to `src/config.ts`

New exported constant mapping each platform to its category list:

```typescript
export const PLATFORM_CATEGORIES: Record<string, string[]> = {
  aliexpress: [
    'earphones', 'smart watches', 'speakers', 'action cameras',
    'wireless charger', 'gaming mouse', 'mechanical keyboard', 'power bank',
    'ip camera', 'portable projector', 'translator', 'lavalier microphone',
    'usb hub', 'webcam', 'solar panel', 'smart ring', 'gps tracker',
    'soundbar', 'vr glasses', 'gimbal stabilizer', 'power station',
    'smart doorbell', 'phone cooler', 'sim router',
  ],
  amazon: [
    'earphones', 'smart watches', 'speakers', 'action cameras',
    'wireless charger', 'gaming mouse', 'mechanical keyboard', 'power bank',
    'ip camera', 'portable projector', 'lavalier microphone',
    'usb hub', 'webcam', 'solar panel', 'smart ring',
    'soundbar', 'vr glasses', 'gimbal stabilizer', 'power station',
    'smart doorbell', 'phone cooler',
  ],
  etsy: [
    'earphones', 'smart watches', 'speakers',
    'wireless charger', 'gaming mouse', 'mechanical keyboard', 'power bank',
    'lavalier microphone', 'webcam', 'smart ring',
    'gimbal stabilizer', 'phone cooler',
  ],
};
```

Add a helper function:

```typescript
export function getPlatformsForCategory(category: string): string[] {
  return Object.entries(PLATFORM_CATEGORIES)
    .filter(([_, cats]) => cats.includes(category))
    .map(([platform]) => platform);
}
```

### 2. Add `target_platforms` column to `products` table in `src/database/db.ts`

```sql
ALTER TABLE products ADD COLUMN target_platforms VARCHAR(200) DEFAULT '' AFTER category;
```

Add this as an `ALTER TABLE` in the schema init (safe — runs only if column doesn't exist).

Value format: comma-separated, e.g. `"aliexpress,amazon,etsy"` — simple, queryable with `LIKE` or `FIND_IN_SET()`.

### 3. Populate `target_platforms` in `discoverProduct()` in `src/database/repositories.ts`

When inserting a new product, compute and store the target platforms based on its category:

```typescript
import { getPlatformsForCategory } from '../config';

// In discoverProduct():
const targetPlatforms = getPlatformsForCategory(category).join(',');
// Add to INSERT
```

### 4. Backfill existing products

One-time SQL to populate `target_platforms` for products already in the DB:

```sql
-- Run after schema migration
UPDATE products SET target_platforms = 'aliexpress,amazon,etsy'
  WHERE category IN ('earphones','smart watches','speakers','wireless charger',
    'gaming mouse','mechanical keyboard','power bank','lavalier microphone',
    'webcam','smart ring','gimbal stabilizer','phone cooler');
UPDATE products SET target_platforms = 'aliexpress,amazon'
  WHERE category IN ('action cameras','ip camera','portable projector',
    'usb hub','solar panel','soundbar','vr glasses','power station','smart doorbell');
UPDATE products SET target_platforms = 'aliexpress'
  WHERE category IN ('translator','gps tracker','sim router');
```

### 5. Update CLAUDE.md docs

- Update `1688_scrapper/CLAUDE.md` to document `target_platforms` column and `PLATFORM_CATEGORIES`
- Already done: root `CLAUDE.md` and `documents/MULTI_PLATFORM_CATEGORY_STRATEGY.md`

## Files Modified

| File | Action |
|------|--------|
| `src/config.ts` | Add `PLATFORM_CATEGORIES` + `getPlatformsForCategory()` |
| `src/database/db.ts` | Add `target_platforms` column to products table |
| `src/database/repositories.ts` | Populate `target_platforms` in `discoverProduct()` |
| `CLAUDE.md` | Document new column and platform config |

## What Does NOT Change

- Tasks 1-5 processing logic (they process all products regardless of platform)
- Status flow: discovered → detail_scraped → images_checked → translated → ae_enriched
- AliExpress downstream project (reads from 1688_source, can now filter by platform)
- No new tables, no new tasks

## Verification

1. Build: `./node_modules/.bin/tsc` — no errors
2. Run backfill SQL on China MacBook
3. Verify: `SELECT target_platforms, COUNT(*) FROM products GROUP BY target_platforms`
4. Run Task 1 with a new category → verify `target_platforms` is populated
