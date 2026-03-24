export interface ProductSpecification {
  name: string;
  value: string;
}

export interface SellerInfo {
  name: string;
  rating?: number;
  transactionCount?: number;
  sellerId?: string;      // numeric shop ID extracted from shop URL
  shopUrl?: string;       // full URL to seller's 1688 storefront
  wangwangId?: string;    // Wangwang IM handle (旺旺 ID)
}

export type CertType = 'oeko-tex' | 'reach' | 'sgs' | 'gots' | 'iso' | 'ce' | 'unknown';

export interface ComplianceCert {
  certType: CertType;
  certNumber?: string;
  imageUrl?: string;
  sourceUrl: string;
}

export interface SellerContact {
  sellerId: string;
  sellerName: string;
  wangwangId?: string;
  sellerUrl?: string;
  productIds: number[];
}

export interface VariantOption {
  name: string;       // e.g., "颜色" (color), "尺码" (size)
  values: string[];   // e.g., ["黑色", "白色", "肤色"]
}

export interface SkuVariant {
  optionValues: Record<string, string>;  // e.g., { "颜色": "黑色" }
  priceCNY: number;
  image?: string;
  stock?: number;
  available: boolean;
}

export interface ProductVariants {
  options: VariantOption[];
  skus: SkuVariant[];
}

export interface ScrapedProduct {
  id1688: string;
  title: string;
  description: string;
  priceCNY: number;
  images: string[];
  specifications: ProductSpecification[];
  seller: SellerInfo;
  category: string;
  minOrderQty: number;
  url: string;
  scrapedAt: Date;
  variants?: ProductVariants;
}

export interface TranslatedProduct extends ScrapedProduct {
  titleEN: string;
  descriptionEN: string;
  specificationsEN: ProductSpecification[];
  priceUSD: number;
  variantsEN?: ProductVariants;
}

export interface ProductFilter {
  minPrice: number;
  maxPrice: number;
  minOrderQty: number;
  excludeBrands: string[];
}

export interface ImageAnalysisResult {
  imageUrl: string;
  hasChineseText: boolean;
  hasWatermark: boolean;
  detectedText: string[];
  passed: boolean;
}

export type ProductStatus =
  | 'scraped'
  | 'discovered'
  | 'detail_scraped'
  | 'images_checked'
  | 'translated'
  | 'ae_enriched'
  | 'brand_verified'
  | 'images_translated'
  | 'skipped'
  | 'failed';

// ──────────────────────────────────────────────────────────────────
// Brand Safety System
// ──────────────────────────────────────────────────────────────────

export type BrandRiskLevel = 'critical' | 'high' | 'medium' | 'low';
export type BrandSource = 'json_migration' | 'aliexpress_ipr' | 'violation_report' | 'manual' | 'trademark_db';

export interface BrandEntry {
  id?: number;
  brandNameEn: string;
  brandNameZh?: string;
  category: string;
  source: BrandSource;
  riskLevel: BrandRiskLevel;
  aliases?: string[];
  exactMatch: boolean;
  active: boolean;
  notes?: string;
}

export type AuthorizationType = 'not_branded' | 'authorized_reseller' | 'own_brand' | 'generic';

export type AuthorizationConfidence = 'seller_confirmed' | 'auto_verified' | 'manual';

export interface AutoCheckResults {
  brand_list_check: 'pass' | 'fail';
  price_check: 'pass' | 'fail' | 'warn';
  image_logo_check?: 'pass' | 'fail' | 'skipped';
  cross_platform_check?: 'pass' | 'fail' | 'skipped';
  seller_profile_check?: 'pass' | 'fail' | 'skipped';
  price_cny?: number;
  category?: string;
  checked_at: string;
}

export interface AuthorizedProduct {
  id?: number;
  productId: number;
  authorizationType: AuthorizationType;
  authorizedPlatforms: string[];
  providerId?: number;
  sellerConfirmation?: string;
  authorizationDocUrl?: string;
  confirmedBy?: string;
  confirmedAt?: Date;
  expiresAt?: Date;
  active: boolean;
  confidence?: AuthorizationConfidence;
  autoCheckResults?: AutoCheckResults;
  notes?: string;
}

export type ProviderPlatform = '1688' | 'taobao' | 'pinduoduo' | 'jd' | 'wechat' | 'qq' | 'direct' | 'other';
export type ProviderTrustLevel = 'new' | 'verified' | 'trusted' | 'preferred' | 'blacklisted';

export interface Provider {
  id?: number;
  providerName: string;
  platform: ProviderPlatform;
  platformId?: string;
  wangwangId?: string;
  wechatId?: string;
  email?: string;
  phone?: string;
  shopUrl?: string;
  trustLevel: ProviderTrustLevel;
  totalProducts: number;
  complianceScore?: number;
  notes?: string;
}

export interface BrandMatch {
  matched: boolean;
  brandName?: string;
  riskLevel?: BrandRiskLevel;
}

// ──────────────────────────────────────────────────────────────────
// 3C Supplier Outreach Pipeline (Amazon)
// ──────────────────────────────────────────────────────────────────

export interface SupplierSearchResult {
  storeName: string;
  storeUrl: string;       // e.g., https://shop1234567890.1688.com/
  sellerId: string;       // numeric shop ID
  mainProducts?: string;  // brief description of what they sell
  yearsInBusiness?: number;
  location?: string;      // city/province
}

/**
 * 3C supplier search keywords for 1688 factory/company search.
 * Plain product names only — no 工厂/厂家/源头工厂 suffix needed because
 * we use the dedicated factory search URL (s.1688.com/company/pc/factory_search.htm)
 * and supplier search URL (s.1688.com/company/company_search.htm).
 * Used by Task 10 (3C Supplier Discovery).
 */
export const SUPPLIER_3C_KEYWORDS: Record<string, string[]> = {
  'earphones':           ['蓝牙耳机'],
  'smart watches':       ['智能手表'],
  'action cameras':      ['运动相机'],
  'portable projector':  ['便携投影仪'],
  'vr glasses':          ['VR眼镜'],
  'power station':       ['户外电源'],
  'ip camera':           ['监控摄像头'],
  'smart doorbell':      ['智能门铃'],
  'soundbar':            ['蓝牙音响条'],
  'solar panel':         ['太阳能充电板'],
  'gimbal stabilizer':   ['手持稳定器'],
  'lavalier microphone': ['无线领夹麦克风'],
  'smart ring':          ['智能戒指'],
};

export interface ProductRecord {
  id: number;
  id1688: string;
  status: ProductStatus;
  skipReason?: string;
  rawData: string;
  url?: string;
  titleZh?: string;
  category?: string;
  thumbnailUrl?: string;
  createdAt: string;
  updatedAt: string;
}
