/**
 * One-time migration: banned-brands.json + config.ts excludeBrands → brand_list DB table.
 *
 * Usage:
 *   node dist/tasks/migrate-brands-to-db.js [--dry-run]
 *
 * Groups aliases under parent brands where possible, populates brand_name_zh
 * for Chinese entries, and adds fabric brands from config.ts that are missing
 * from the JSON file.
 */

import fs from 'fs';
import path from 'path';
import { getPool, upsertBrand, getBrandCount, closeDatabase } from '../database/db';
import { BrandEntry, BrandRiskLevel } from '../models/product';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('migrate-brands');

// ──────────────────────────────────────────────────────────────────
// Brand grouping: map alias keywords → parent brand name.
// Aliases that should be grouped under a single parent brand.
// ──────────────────────────────────────────────────────────────────
const BRAND_GROUPS: Record<string, { parent: string; zh?: string; aliases: string[] }> = {
  // Electronics
  apple: { parent: 'Apple', aliases: ['iphone', 'ipad', 'ipod', 'airpods', 'airpod', 'inpods', 'macbook', 'imac', 'mac mini', 'mac pro', 'apple watch', 'homepod', 'airtag', 'magsafe'] },
  samsung: { parent: 'Samsung', aliases: ['galaxy buds', 'galaxy watch', 'galaxy tab'] },
  sony: { parent: 'Sony', aliases: ['playstation', 'walkman', 'xperia', 'wf-1000', 'wh-1000'] },
  google: { parent: 'Google', aliases: ['google pixel', 'pixel buds', 'chromecast', 'nest hub'] },
  beats: { parent: 'Beats by Dre', aliases: ['beats by dre', 'beats studio', 'beats solo', 'beats fit'] },
  microsoft: { parent: 'Microsoft', aliases: ['xbox', 'surface pro', 'surface laptop'] },
  nintendo: { parent: 'Nintendo', aliases: ['switch oled'] },
  'asus rog': { parent: 'ASUS ROG', aliases: ['asus rog'] },
  // Fashion
  'ralph lauren': { parent: 'Ralph Lauren', zh: '拉夫劳伦', aliases: ['polo ralph', 'polo pony', 'polo horse', '小马刺绣', 'polo小马'] },
  'louis vuitton': { parent: 'Louis Vuitton', zh: '路易威登', aliases: [] },
  'thom browne': { parent: 'Thom Browne', zh: '汤姆布朗', aliases: ['four bar stripe', '4 bar stripe', '四条杠', '四道杠'] },
  'maison kitsune': { parent: 'Maison Kitsuné', aliases: ['maison kitsuné', 'kitsune fox', 'fox logo', 'fox embroidery', '狐狸刺绣', '狐狸logo'] },
  'fear of god': { parent: 'Fear of God', aliases: ['fog essentials', 'essentials hoodie', 'essentials sweatshirt'] },
  'acne studios': { parent: 'Acne Studios', aliases: ['acne 1996'] },
  'alo yoga': { parent: 'Alo Yoga', aliases: ['aloyoga'] },
  stussy: { parent: 'Stüssy', aliases: ['stüssy'] },
  nike: { parent: 'Nike', zh: '耐克', aliases: ['三叶草'] },
  adidas: { parent: 'Adidas', zh: '阿迪达斯', aliases: ['三条杠'] },
  moncler: { parent: 'Moncler', zh: '蒙克莱', aliases: [] },
  'canada goose': { parent: 'Canada Goose', zh: '加拿大鹅', aliases: [] },
  'chrome hearts': { parent: 'Chrome Hearts', zh: '克罗心', aliases: [] },
  'palm angels': { parent: 'Palm Angels', zh: '棕榈天使', aliases: [] },
  sanrio: { parent: 'Sanrio', aliases: ['hello kitty', 'cinnamoroll', 'kuromi', 'my melody', 'pompompurin', 'pochacco'] },
  disney: { parent: 'Disney', aliases: ['mickey mouse', 'minnie mouse', 'winnie the pooh'] },
  marvel: { parent: 'Marvel', aliases: ['avengers'] },
  'coca-cola': { parent: 'Coca-Cola', aliases: ['coca cola'] },
  'harley-davidson': { parent: 'Harley-Davidson', aliases: ['harley davidson', 'harley'] },
  levis: { parent: "Levi's", aliases: ["levi's"] },
  'air jordan': { parent: 'Air Jordan', aliases: ['jordan brand'] },
  yeezy: { parent: 'Yeezy', aliases: ['kanye west'] },
  'mardi mercredi': { parent: 'Mardi Mercredi', zh: '马蒂梅克里迪', aliases: ['mardi'] },
  'miu miu': { parent: 'Miu Miu', zh: '缪缪', aliases: [] },
  'comme des garcons': { parent: 'Comme des Garçons', aliases: ['comme des garçons'] },
  arcteryx: { parent: "Arc'teryx", aliases: ["arc'teryx"] },
  'cp company': { parent: 'C.P. Company', aliases: ['c.p. company'] },
  'a.p.c': { parent: 'A.P.C.', aliases: ['apc'] },
  dsquared2: { parent: 'Dsquared2', aliases: ['dsquared'] },
  'bang & olufsen': { parent: 'Bang & Olufsen', aliases: ['b&o'] },
  'alexander mcqueen': { parent: 'Alexander McQueen', aliases: ['mcqueen'] },
  'saint laurent': { parent: 'Saint Laurent', aliases: ['ysl'] },
};

// Chinese → English mapping for fashion_luxury_chinese entries
const ZH_TO_EN: Record<string, string> = {
  '耐克': 'Nike', '阿迪达斯': 'Adidas', '彪马': 'Puma', '新百伦': 'New Balance',
  '安德玛': 'Under Armour', '锐步': 'Reebok', '优衣库': 'Uniqlo', '北面': 'North Face',
  '哥伦比亚': 'Columbia', '古驰': 'Gucci', '路易威登': 'Louis Vuitton', '普拉达': 'Prada',
  '香奈儿': 'Chanel', '巴宝莉': 'Burberry', '博柏利': 'Burberry', '范思哲': 'Versace',
  '巴黎世家': 'Balenciaga', '迪奥': 'Dior', '爱马仕': 'Hermes', '卡地亚': 'Cartier',
  '劳力士': 'Rolex', '拉夫劳伦': 'Ralph Lauren', '汤米': 'Tommy Hilfiger',
  '卡尔文克莱恩': 'Calvin Klein', '拉科斯特': 'Lacoste', '雨果博斯': 'Hugo Boss',
  '迈克科尔斯': 'Michael Kors', '缪缪': 'Miu Miu', '汤姆布朗': 'Thom Browne',
  '冠军': 'Champion', '蒙克莱': 'Moncler', '加拿大鹅': 'Canada Goose',
  '克罗心': 'Chrome Hearts', '棕榈天使': 'Palm Angels', '马蒂梅克里迪': 'Mardi Mercredi',
  '李宁': 'Li-Ning', '安踏': 'Anta', '特步': 'Xtep', '匹克': 'Peak',
  '鸿星尔克': 'Erke', '斐乐': 'FILA',
};

// Extra fabric/textile brands from config.ts not in banned-brands.json
const EXTRA_FABRIC_BRANDS = [
  'coolmax', 'thermolite', 'gore-tex', 'goretex', 'primaloft',
  'polartec', 'supplex', 'cordura', 'outlast', 'cocona', 'seacell',
];

// Risk levels by category
const CATEGORY_RISK: Record<string, BrandRiskLevel> = {
  electronics_3c: 'critical',
  fashion_luxury: 'high',
  fashion_luxury_chinese: 'high',
  government_agencies: 'high',
  sports_leagues: 'high',
  automotive: 'medium',
  lifestyle_entertainment: 'high',
  textiles_fibers: 'medium',
  streetwear_collabs: 'high',
};

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) logger.info('DRY RUN — no DB writes');

  // Load banned-brands.json
  const jsonPath = path.resolve(__dirname, '../../banned-brands.json');
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const categories = raw.categories as Record<string, string[]>;

  // Track which keywords have been assigned to a grouped parent brand
  const assignedKeywords = new Set<string>();
  const brandsToInsert: BrandEntry[] = [];

  // Build grouped parent brand entries first
  for (const [_key, group] of Object.entries(BRAND_GROUPS)) {
    // Find all keywords that belong to this group across all JSON categories
    const allGroupKeywords = [group.parent.toLowerCase(), ...group.aliases.map(a => a.toLowerCase())];
    const matchedAliases: string[] = [];

    for (const [catName, keywords] of Object.entries(categories)) {
      if (catName === 'fashion_luxury_chinese') continue; // handled separately
      for (const kw of keywords) {
        if (allGroupKeywords.includes(kw.toLowerCase()) && kw.toLowerCase() !== group.parent.toLowerCase()) {
          matchedAliases.push(kw);
          assignedKeywords.add(kw.toLowerCase());
        }
      }
    }
    assignedKeywords.add(group.parent.toLowerCase());

    // Find the category this brand primarily belongs to
    let primaryCategory = 'fashion_luxury';
    for (const [catName, keywords] of Object.entries(categories)) {
      if (catName === 'fashion_luxury_chinese') continue;
      if (keywords.some(kw => allGroupKeywords.includes(kw.toLowerCase()))) {
        primaryCategory = catName;
        break;
      }
    }

    brandsToInsert.push({
      brandNameEn: group.parent,
      brandNameZh: group.zh,
      category: primaryCategory,
      source: 'json_migration',
      riskLevel: CATEGORY_RISK[primaryCategory] || 'high',
      aliases: matchedAliases.length > 0 ? matchedAliases : undefined,
      exactMatch: false,
      active: true,
    });
  }

  // Now add remaining ungrouped keywords as individual brands
  for (const [catName, keywords] of Object.entries(categories)) {
    if (catName === 'fashion_luxury_chinese') continue; // handled via ZH_TO_EN mapping

    for (const kw of keywords) {
      if (assignedKeywords.has(kw.toLowerCase())) continue;

      // Check if this is a Chinese entry in a non-Chinese category
      const zhMatch = ZH_TO_EN[kw];
      if (zhMatch) {
        // This Chinese keyword maps to an English brand — find and add zh name
        const existing = brandsToInsert.find(b => b.brandNameEn === zhMatch);
        if (existing) {
          existing.brandNameZh = existing.brandNameZh || kw;
          continue;
        }
      }

      brandsToInsert.push({
        brandNameEn: kw,
        category: catName,
        source: 'json_migration',
        riskLevel: CATEGORY_RISK[catName] || 'high',
        exactMatch: false,
        active: true,
      });
      assignedKeywords.add(kw.toLowerCase());
    }
  }

  // Handle fashion_luxury_chinese: add zh names to existing entries or create new ones
  const zhKeywords = categories['fashion_luxury_chinese'] || [];
  for (const zh of zhKeywords) {
    const en = ZH_TO_EN[zh];
    if (en) {
      const existing = brandsToInsert.find(b => b.brandNameEn === en || b.brandNameEn.toLowerCase() === en.toLowerCase());
      if (existing) {
        existing.brandNameZh = existing.brandNameZh || zh;
        // Also add as alias for substring matching
        if (!existing.aliases) existing.aliases = [];
        if (!existing.aliases.includes(zh)) existing.aliases.push(zh);
      } else {
        brandsToInsert.push({
          brandNameEn: en,
          brandNameZh: zh,
          category: 'fashion_luxury',
          source: 'json_migration',
          riskLevel: 'high',
          aliases: [zh],
          exactMatch: false,
          active: true,
        });
      }
    } else {
      // Chinese brand with no English mapping — e.g., 三叶草, 三条杠 (already aliased above)
      if (!assignedKeywords.has(zh)) {
        brandsToInsert.push({
          brandNameEn: zh,
          brandNameZh: zh,
          category: 'fashion_luxury',
          source: 'json_migration',
          riskLevel: 'high',
          exactMatch: false,
          active: true,
        });
      }
    }
  }

  // Add extra fabric brands from config.ts
  for (const fabric of EXTRA_FABRIC_BRANDS) {
    if (assignedKeywords.has(fabric.toLowerCase())) continue;

    // Group gore-tex variants
    if (fabric === 'goretex') {
      const goreTex = brandsToInsert.find(b => b.brandNameEn === 'gore-tex');
      if (goreTex) {
        if (!goreTex.aliases) goreTex.aliases = [];
        goreTex.aliases.push('goretex');
        continue;
      }
    }

    brandsToInsert.push({
      brandNameEn: fabric,
      category: 'textiles_fibers',
      source: 'json_migration',
      riskLevel: 'medium',
      aliases: fabric === 'gore-tex' ? ['goretex'] : undefined,
      exactMatch: false,
      active: true,
    });
  }

  logger.info(`Prepared ${brandsToInsert.length} brands for migration`);

  if (dryRun) {
    for (const brand of brandsToInsert) {
      logger.info(`[DRY] ${brand.category} | ${brand.brandNameEn}${brand.brandNameZh ? ` (${brand.brandNameZh})` : ''}${brand.aliases ? ` [aliases: ${brand.aliases.join(', ')}]` : ''} | risk: ${brand.riskLevel}`);
    }
    logger.info(`[DRY] Would insert ${brandsToInsert.length} brands`);
    return;
  }

  // Initialize DB (creates tables if needed)
  await getPool();

  let inserted = 0;
  let updated = 0;
  for (const brand of brandsToInsert) {
    try {
      const id = await upsertBrand(brand);
      if (id > 0) {
        inserted++;
      } else {
        updated++;
      }
    } catch (err: any) {
      logger.error(`Failed to insert brand: ${brand.brandNameEn}`, { error: err.message });
    }
  }

  const totalInDb = await getBrandCount();
  logger.info(`Migration complete: ${inserted} inserted, ${updated} updated. Total active brands in DB: ${totalInDb}`);

  closeDatabase();
}

main().catch((err) => {
  logger.error('Migration failed', { error: err.message });
  closeDatabase();
  process.exit(1);
});
