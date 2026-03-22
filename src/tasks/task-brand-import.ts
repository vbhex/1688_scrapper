/**
 * Brand Import CLI — Proactively expand the brand_list database.
 *
 * Supports multiple sources:
 *   --source manual  --brand "Nike" [--zh "耐克"] --category fashion_luxury
 *   --source file    --path brands.csv
 *   --source violation --brand "NewBrand" --notes "Found via AliExpress violation #123"
 *
 * CSV file format (header row required):
 *   brand_name_en,brand_name_zh,category,risk_level,aliases,notes
 *   Nike,耐克,fashion_luxury,critical,"air jordan|jordan brand",Well-known sports brand
 *
 * Usage:
 *   node dist/tasks/task-brand-import.js --source manual --brand "Cartier" --zh "卡地亚" --category fashion_luxury
 *   node dist/tasks/task-brand-import.js --source file --path /path/to/brands.csv
 *   node dist/tasks/task-brand-import.js --source violation --brand "NewBrand" --category fashion_luxury --notes "AE violation #456"
 *   node dist/tasks/task-brand-import.js --list                    # List all brands in DB
 *   node dist/tasks/task-brand-import.js --stats                   # Show brand stats
 *   node dist/tasks/task-brand-import.js --search "nike"           # Search brands
 */

import fs from 'fs';
import { getPool, upsertBrand, getAllActiveBrands, getBrandCount, closeDatabase } from '../database/db';
import { BrandEntry, BrandRiskLevel, BrandSource } from '../models/product';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('brand-import');

interface CLIOptions {
  source?: string;
  brand?: string;
  zh?: string;
  category?: string;
  riskLevel?: BrandRiskLevel;
  path?: string;
  notes?: string;
  list?: boolean;
  stats?: boolean;
  search?: string;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--source': options.source = args[++i]; break;
      case '--brand': options.brand = args[++i]; break;
      case '--zh': options.zh = args[++i]; break;
      case '--category': options.category = args[++i]; break;
      case '--risk': options.riskLevel = args[++i] as BrandRiskLevel; break;
      case '--path': options.path = args[++i]; break;
      case '--notes': options.notes = args[++i]; break;
      case '--list': options.list = true; break;
      case '--stats': options.stats = true; break;
      case '--search': options.search = args[++i]; break;
    }
  }
  return options;
}

async function importManual(options: CLIOptions): Promise<void> {
  if (!options.brand || !options.category) {
    console.error('Usage: --source manual --brand "BrandName" --category <category> [--zh "中文名"] [--risk high] [--notes "..."]');
    console.error('Categories: electronics_3c, fashion_luxury, automotive, sports_leagues, lifestyle_entertainment, textiles_fibers, streetwear_collabs, government_agencies');
    process.exit(1);
  }

  await getPool();
  const source: BrandSource = options.source === 'violation' ? 'violation_report' : 'manual';
  await upsertBrand({
    brandNameEn: options.brand,
    brandNameZh: options.zh,
    category: options.category,
    source,
    riskLevel: options.riskLevel || 'high',
    exactMatch: false,
    active: true,
    notes: options.notes,
  });

  logger.info(`Brand added/updated: "${options.brand}" (${options.category}) [source: ${source}]`);
  const total = await getBrandCount();
  logger.info(`Total active brands in DB: ${total}`);
}

async function importFromFile(filePath: string): Promise<void> {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  await getPool();
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 2) {
    console.error('CSV must have a header row + at least one data row');
    process.exit(1);
  }

  // Parse header
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const nameIdx = header.indexOf('brand_name_en');
  const zhIdx = header.indexOf('brand_name_zh');
  const catIdx = header.indexOf('category');
  const riskIdx = header.indexOf('risk_level');
  const aliasIdx = header.indexOf('aliases');
  const notesIdx = header.indexOf('notes');

  if (nameIdx === -1 || catIdx === -1) {
    console.error('CSV must have columns: brand_name_en, category (required), brand_name_zh, risk_level, aliases, notes (optional)');
    process.exit(1);
  }

  let imported = 0;
  let errors = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const brandNameEn = cols[nameIdx]?.trim();
    const category = cols[catIdx]?.trim();

    if (!brandNameEn || !category) {
      logger.warn(`Skipping line ${i + 1}: missing brand_name_en or category`);
      errors++;
      continue;
    }

    const aliases = aliasIdx >= 0 && cols[aliasIdx]
      ? cols[aliasIdx].split('|').map(a => a.trim()).filter(Boolean)
      : undefined;

    try {
      await upsertBrand({
        brandNameEn,
        brandNameZh: zhIdx >= 0 ? cols[zhIdx]?.trim() || undefined : undefined,
        category,
        source: 'manual',
        riskLevel: (riskIdx >= 0 ? cols[riskIdx]?.trim() as BrandRiskLevel : 'high') || 'high',
        aliases: aliases && aliases.length > 0 ? aliases : undefined,
        exactMatch: false,
        active: true,
        notes: notesIdx >= 0 ? cols[notesIdx]?.trim() || undefined : undefined,
      });
      imported++;
    } catch (err: any) {
      logger.error(`Line ${i + 1} failed: ${err.message}`);
      errors++;
    }
  }

  logger.info(`Import complete: ${imported} brands imported, ${errors} errors`);
  const total = await getBrandCount();
  logger.info(`Total active brands in DB: ${total}`);
}

/** Simple CSV line parser that handles quoted fields */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

async function listBrands(): Promise<void> {
  await getPool();
  const brands = await getAllActiveBrands();

  // Group by category
  const byCategory = new Map<string, BrandEntry[]>();
  for (const brand of brands) {
    if (!byCategory.has(brand.category)) byCategory.set(brand.category, []);
    byCategory.get(brand.category)!.push(brand);
  }

  for (const [category, brandList] of byCategory.entries()) {
    console.log(`\n=== ${category} (${brandList.length}) ===`);
    for (const b of brandList) {
      const zh = b.brandNameZh ? ` (${b.brandNameZh})` : '';
      const aliases = b.aliases ? ` [${b.aliases.join(', ')}]` : '';
      console.log(`  ${b.brandNameEn}${zh}${aliases} — ${b.riskLevel} [${b.source}]`);
    }
  }
  console.log(`\nTotal: ${brands.length} active brands`);
}

async function showStats(): Promise<void> {
  await getPool();
  const pool = await getPool();

  const [catRows] = await pool.execute(`
    SELECT category, COUNT(*) as count, risk_level
    FROM brand_list WHERE active = TRUE
    GROUP BY category, risk_level ORDER BY category, risk_level
  `);
  const [sourceRows] = await pool.execute(`
    SELECT source, COUNT(*) as count
    FROM brand_list WHERE active = TRUE
    GROUP BY source ORDER BY count DESC
  `);
  const total = await getBrandCount();

  console.log(`\nBrand Database Stats`);
  console.log(`  Total active brands: ${total}\n`);

  console.log('By category + risk level:');
  for (const r of catRows as any[]) {
    console.log(`  ${r.category} / ${r.risk_level}: ${r.count}`);
  }

  console.log('\nBy source:');
  for (const r of sourceRows as any[]) {
    console.log(`  ${r.source}: ${r.count}`);
  }
}

async function searchBrands(query: string): Promise<void> {
  await getPool();
  const pool = await getPool();
  const [rows] = await pool.execute(`
    SELECT brand_name_en, brand_name_zh, category, risk_level, aliases, source
    FROM brand_list
    WHERE active = TRUE
      AND (brand_name_en LIKE ? OR brand_name_zh LIKE ? OR aliases LIKE ?)
    ORDER BY brand_name_en
  `, [`%${query}%`, `%${query}%`, `%${query}%`]);

  const results = rows as any[];
  if (results.length === 0) {
    console.log(`No brands found matching "${query}"`);
    return;
  }

  console.log(`\nFound ${results.length} brand(s) matching "${query}":\n`);
  for (const r of results) {
    const zh = r.brand_name_zh ? ` (${r.brand_name_zh})` : '';
    const aliases = r.aliases ? ` [${typeof r.aliases === 'string' ? r.aliases : JSON.stringify(r.aliases)}]` : '';
    console.log(`  ${r.brand_name_en}${zh} — ${r.category} / ${r.risk_level}${aliases} [${r.source}]`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs();

  if (options.list) {
    await listBrands();
  } else if (options.stats) {
    await showStats();
  } else if (options.search) {
    await searchBrands(options.search);
  } else if (options.source === 'file' && options.path) {
    await importFromFile(options.path);
  } else if (options.source === 'manual' || options.source === 'violation') {
    await importManual(options);
  } else {
    console.log(`Brand Import CLI — Add brands to the brand_list database

Usage:
  # Add a single brand manually
  node dist/tasks/task-brand-import.js --source manual --brand "Cartier" --zh "卡地亚" --category fashion_luxury

  # Add from AliExpress violation
  node dist/tasks/task-brand-import.js --source violation --brand "NewBrand" --category fashion_luxury --notes "AE violation #123"

  # Import from CSV file
  node dist/tasks/task-brand-import.js --source file --path brands.csv

  # List all brands
  node dist/tasks/task-brand-import.js --list

  # Show stats
  node dist/tasks/task-brand-import.js --stats

  # Search brands
  node dist/tasks/task-brand-import.js --search "nike"

Categories: electronics_3c, fashion_luxury, automotive, sports_leagues,
            lifestyle_entertainment, textiles_fibers, streetwear_collabs,
            government_agencies`);
  }

  closeDatabase();
}

main().catch(err => {
  logger.error('Error', { error: err.message });
  closeDatabase();
  process.exit(1);
});
