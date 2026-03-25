/**
 * trademarkChecker.ts — Supplementary trademark lookup via public APIs.
 *
 * Checks product title words against:
 *   1. EUIPO eSearch (EU trademark register, no API key needed)
 *   2. USPTO TSDR / IBD API (US trademark register, no API key needed)
 *
 * Results are cached in `trademark_cache` DB table (7-day TTL) so the pipeline
 * never hits the API twice for the same term.
 *
 * Usage:
 *   const hits = await checkTrademark('Marvel sunglasses watch band');
 *   if (hits.length > 0) console.log('Trademark found:', hits);
 *
 * This is SUPPLEMENTARY — the primary gate is `isBannedBrand()` (local DB list).
 * Use this for terms NOT in the brand_list that may still be trademarked.
 */

import axios from 'axios';
import { createChildLogger } from '../utils/logger';
import { getPool } from '../database/db';

const logger = createChildLogger('trademarkChecker');

export interface TrademarkHit {
  term: string;
  jurisdiction: 'EUIPO' | 'USPTO';
  trademarkName: string;
  owner: string;
  classes: number[];    // Nice classification classes (25=clothing, 14=jewelry, etc.)
  status: string;       // "Registered", "Pending", etc.
}

// ---------------------------------------------------------------------------
// DB cache helpers
// ---------------------------------------------------------------------------

const CACHE_TTL_DAYS = 7;

async function getCached(term: string): Promise<TrademarkHit[] | null> {
  try {
    const pool = await getPool();
    const [rows]: any = await pool.execute(
      `SELECT result_json FROM trademark_cache
       WHERE term = ? AND checked_at > DATE_SUB(NOW(), INTERVAL ? DAY)
       LIMIT 1`,
      [term.toLowerCase(), CACHE_TTL_DAYS]
    );
    if (rows.length === 0) return null;
    return JSON.parse(rows[0].result_json) as TrademarkHit[];
  } catch {
    return null; // cache miss on error
  }
}

async function setCache(term: string, hits: TrademarkHit[]): Promise<void> {
  try {
    const pool = await getPool();
    await pool.execute(
      `INSERT INTO trademark_cache (term, result_json, checked_at)
       VALUES (?, ?, NOW())
       ON DUPLICATE KEY UPDATE result_json = VALUES(result_json), checked_at = NOW()`,
      [term.toLowerCase(), JSON.stringify(hits)]
    );
  } catch (e) {
    logger.warn('trademark_cache write failed', { term, error: (e as Error).message });
  }
}

// ---------------------------------------------------------------------------
// EUIPO eSearch REST API
// Docs: https://euipo.europa.eu/eSearch/
// Public endpoint — no API key required.
// ---------------------------------------------------------------------------

const EUIPO_URL = 'https://euipo.europa.eu/eSearch/rest/trademarks';

async function queryEuipo(term: string): Promise<TrademarkHit[]> {
  try {
    const resp = await axios.get(EUIPO_URL, {
      params: {
        start: 0,
        rows: 10,
        // Exact word match on trademark name; language filter reduces noise
        query: `tradeMarkName:"${term}"`,
        filters: 'tradeMarkStatus:(Registered OR "Application published")',
      },
      timeout: 8000,
      headers: { Accept: 'application/json' },
    });

    const trademarks: any[] = resp.data?.trademarks ?? resp.data?.results ?? [];
    return trademarks.map((tm: any) => ({
      term,
      jurisdiction: 'EUIPO' as const,
      trademarkName: tm.tradeMarkName ?? tm.name ?? term,
      owner: tm.holderName ?? tm.ownerName ?? tm.holder ?? 'Unknown',
      classes: (tm.niceClass ?? tm.niceClasses ?? []).map(Number).filter(Boolean),
      status: tm.tradeMarkStatus ?? tm.status ?? 'Unknown',
    }));
  } catch (e: any) {
    if (e.code !== 'ECONNREFUSED' && e.response?.status !== 404) {
      logger.debug('EUIPO API error', { term, error: e.message });
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// USPTO IBD (Inventor & Brand Data) Trademark Search API
// Public endpoint at developer.uspto.gov — no API key required.
// ---------------------------------------------------------------------------

const USPTO_URL = 'https://developer.uspto.gov/ibd-api/v1/trademark/search';

async function queryUspto(term: string): Promise<TrademarkHit[]> {
  try {
    const resp = await axios.get(USPTO_URL, {
      params: {
        searchText: term,
        searchType: 'freeForm',
        start: 0,
        rows: 10,
      },
      timeout: 8000,
      headers: { Accept: 'application/json' },
    });

    // USPTO IBD response: { results: { trademarkIdentificationDescription: [...] } }
    const items: any[] = resp.data?.results?.trademarkIdentificationDescription ?? [];
    return items.map((tm: any) => ({
      term,
      jurisdiction: 'USPTO' as const,
      trademarkName: tm.trademarkName ?? tm.wordMark ?? term,
      owner: tm.registrantName ?? tm.ownerName ?? 'Unknown',
      classes: (tm.internationalClassDescription ?? [])
        .map((c: any) => parseInt(c.classNumber ?? c, 10))
        .filter(Boolean),
      status: tm.registrationNumber ? 'Registered' : (tm.serialNumber ? 'Pending' : 'Unknown'),
    }));
  } catch (e: any) {
    if (e.code !== 'ECONNREFUSED' && e.response?.status !== 404) {
      logger.debug('USPTO API error', { term, error: e.message });
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fashion / accessories Nice classes we care about.
 * Results in other classes (e.g. class 42 = software) are ignored.
 */
const RELEVANT_NICE_CLASSES = new Set([
  9,   // optical/electronic goods, sunglasses
  14,  // jewelry, watches
  18,  // bags, leather goods
  25,  // clothing, footwear, headwear
  26,  // buttons, hair accessories, lace
  35,  // retail services (catch-all)
]);

/**
 * Extract candidate terms from a product title.
 * Returns 1-word and 2-word tokens (title-cased) — short/function words excluded.
 */
function extractCandidateTerms(title: string): string[] {
  const STOP = new Set([
    'a','an','the','and','or','of','for','in','on','at','to','by',
    'with','is','are','be','as','its','has','our','new','free',
    'size','color','style','type','material','quantity','weight',
  ]);
  const words = title
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP.has(w.toLowerCase()));

  const terms: string[] = [];
  for (let i = 0; i < words.length; i++) {
    terms.push(words[i]);
    if (i + 1 < words.length) terms.push(`${words[i]} ${words[i + 1]}`);
  }
  // Deduplicate, preserving original casing
  return [...new Set(terms)];
}

/**
 * Check a product title (English) for trademark hits NOT already in brand_list.
 *
 * @param title   English product title or spec text to check
 * @param classes Optional Nice class filter (default: fashion/accessories classes)
 * @returns       Array of trademark hits (empty = clean)
 */
export async function checkTrademark(
  title: string,
  classes: number[] = [],
): Promise<TrademarkHit[]> {
  const relevantClasses = classes.length > 0
    ? new Set(classes)
    : RELEVANT_NICE_CLASSES;

  const candidates = extractCandidateTerms(title);
  const allHits: TrademarkHit[] = [];

  for (const term of candidates) {
    // Check cache first
    const cached = await getCached(term);
    if (cached !== null) {
      allHits.push(...cached.filter(h =>
        h.classes.length === 0 || h.classes.some(c => relevantClasses.has(c))
      ));
      continue;
    }

    // Query both APIs in parallel
    const [euipoHits, usptoHits] = await Promise.all([
      queryEuipo(term),
      queryUspto(term),
    ]);

    const hits = [...euipoHits, ...usptoHits].filter(h =>
      h.classes.length === 0 || h.classes.some(c => relevantClasses.has(c))
    );

    await setCache(term, hits);
    allHits.push(...hits);

    // Small delay to be a good API citizen
    if (candidates.indexOf(term) < candidates.length - 1) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // Deduplicate by (jurisdiction + trademarkName)
  const seen = new Set<string>();
  return allHits.filter(h => {
    const key = `${h.jurisdiction}:${h.trademarkName.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Quick single-term trademark check (bypasses candidate extraction).
 * Use when you have a specific word to look up (e.g. a brand spec value).
 */
export async function checkTermTrademark(
  term: string,
  classes: number[] = [],
): Promise<TrademarkHit[]> {
  const relevantClasses = classes.length > 0
    ? new Set(classes)
    : RELEVANT_NICE_CLASSES;

  const cached = await getCached(term);
  if (cached !== null) {
    return cached.filter(h =>
      h.classes.length === 0 || h.classes.some(c => relevantClasses.has(c))
    );
  }

  const [euipoHits, usptoHits] = await Promise.all([
    queryEuipo(term),
    queryUspto(term),
  ]);

  const hits = [...euipoHits, ...usptoHits].filter(h =>
    h.classes.length === 0 || h.classes.some(c => relevantClasses.has(c))
  );

  await setCache(term, hits);
  return hits;
}
