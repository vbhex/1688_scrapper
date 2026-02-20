import axios from 'axios';
import { createChildLogger } from '../utils/logger';
import { config } from '../config';
import { roundPrice } from '../utils/helpers';

const logger = createChildLogger('priceConverter');

let cachedExchangeRate: number | null = null;
let cacheTimestamp: number = 0;
const CACHE_DURATION_MS = 3600000; // 1 hour

export async function getExchangeRate(): Promise<number> {
  const now = Date.now();

  // Return cached rate if still valid
  if (cachedExchangeRate && now - cacheTimestamp < CACHE_DURATION_MS) {
    return cachedExchangeRate;
  }

  try {
    // Using a free exchange rate API
    const response = await axios.get(
      'https://api.exchangerate-api.com/v4/latest/CNY',
      { timeout: 10000 }
    );

    const rate = response.data.rates.USD;

    if (typeof rate !== 'number' || rate <= 0) {
      throw new Error('Invalid exchange rate received');
    }

    cachedExchangeRate = rate;
    cacheTimestamp = now;

    logger.info('Exchange rate fetched', { cnyToUsd: rate });
    return rate;
  } catch (error) {
    logger.error('Failed to fetch exchange rate', { error: (error as Error).message });

    // Fallback to approximate rate if API fails
    const fallbackRate = 0.14; // Approximate CNY to USD
    logger.warn('Using fallback exchange rate', { rate: fallbackRate });

    return fallbackRate;
  }
}

export async function convertPrice(priceCNY: number): Promise<number> {
  const exchangeRate = await getExchangeRate();
  const markup = config.filters.priceMarkup;

  // Formula: USD = (CNY * exchange_rate) * markup
  const priceUSD = priceCNY * exchangeRate * markup;

  const roundedPrice = roundPrice(priceUSD);

  logger.debug('Price converted', {
    priceCNY,
    exchangeRate,
    markup,
    rawUSD: priceUSD,
    roundedUSD: roundedPrice,
  });

  return roundedPrice;
}

export function isPriceInRange(priceCNY: number): boolean {
  return priceCNY >= config.filters.minPriceCNY && priceCNY <= config.filters.maxPriceCNY;
}

export interface PriceBreakdown {
  originalCNY: number;
  exchangeRate: number;
  baseUSD: number;
  markup: number;
  finalUSD: number;
}

export async function getPriceBreakdown(priceCNY: number): Promise<PriceBreakdown> {
  const exchangeRate = await getExchangeRate();
  const markup = config.filters.priceMarkup;
  const baseUSD = priceCNY * exchangeRate;
  const finalUSD = roundPrice(baseUSD * markup);

  return {
    originalCNY: priceCNY,
    exchangeRate,
    baseUSD,
    markup,
    finalUSD,
  };
}
