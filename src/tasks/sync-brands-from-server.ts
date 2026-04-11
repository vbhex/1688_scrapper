/**
 * Sync brands from remote AutoStore backend into local brand_list table.
 * Run: node dist/tasks/sync-brands-from-server.js
 *
 * Pulls the central brand list from the backend API (public endpoint,
 * no auth needed) and upserts into local 1688_source.brand_list.
 */

import { getPool, closeDatabase } from '../database/db';

const API_BASE = process.env.AUTOSTORE_API_URL || 'http://***REMOVED***/api';

interface RemoteBrand {
  brand_name_en: string;
  brand_name_zh: string | null;
  category: string;
  risk_level: string;
  aliases: string | null;
  active: boolean;
}

async function main() {
  console.log('Brand Sync: Fetching from', API_BASE);

  let brands: RemoteBrand[];
  try {
    const res = await fetch(`${API_BASE}/reference/brands`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    brands = await res.json() as any;
  } catch (err: any) {
    console.log(`Brand Sync: Could not reach server (${err.message}). Using local brands.`);
    closeDatabase();
    return;
  }

  console.log(`Brand Sync: Got ${brands.length} brands from server`);

  const pool = await getPool();

  let inserted = 0;
  let updated = 0;

  for (const brand of brands) {
    const [existing] = await pool.query(
      'SELECT id FROM brand_list WHERE brand_name_en = ? LIMIT 1',
      [brand.brand_name_en],
    ) as any;

    if (existing.length > 0) {
      await pool.query(
        'UPDATE brand_list SET brand_name_zh = ?, category = ?, risk_level = ?, aliases = ?, active = ? WHERE brand_name_en = ?',
        [brand.brand_name_zh, brand.category, brand.risk_level, brand.aliases, brand.active ? 1 : 0, brand.brand_name_en],
      );
      updated++;
    } else {
      await pool.query(
        'INSERT INTO brand_list (brand_name_en, brand_name_zh, category, risk_level, aliases, active) VALUES (?, ?, ?, ?, ?, ?)',
        [brand.brand_name_en, brand.brand_name_zh, brand.category, brand.risk_level, brand.aliases, brand.active ? 1 : 0],
      );
      inserted++;
    }
  }

  console.log(`Brand Sync: ${inserted} new, ${updated} updated, ${brands.length} total`);
  closeDatabase();
}

main().catch(e => { console.error(e.message); process.exit(1); });
