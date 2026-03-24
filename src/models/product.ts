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
 * 3C supplier search keywords for 1688 company search.
 * Appended with 工厂/厂家/源头工厂 to target manufacturers & authorized distributors.
 * Used by Task 10 (3C Supplier Discovery).
 */
export const SUPPLIER_3C_KEYWORDS: Record<string, string[]> = {
  'earphones':           ['蓝牙耳机工厂', '蓝牙耳机厂家', 'TWS耳机源头工厂'],
  'smart watches':       ['智能手表工厂', '智能手表厂家', '智能手表源头工厂'],
  'action cameras':      ['运动相机工厂', '运动相机厂家', '运动相机源头'],
  'portable projector':  ['投影仪工厂', '便携投影仪厂家', '微型投影仪源头工厂'],
  'vr glasses':          ['VR眼镜工厂', 'VR眼镜厂家', 'VR头显源头工厂'],
  'power station':       ['户外电源工厂', '便携储能电源厂家', '户外电源源头工厂'],
  'ip camera':           ['监控摄像头工厂', '网络摄像头厂家', '安防摄像头源头工厂'],
  'smart doorbell':      ['智能门铃工厂', '可视门铃厂家', '智能门铃源头工厂'],
  'soundbar':            ['回音壁工厂', '回音壁音响厂家', '蓝牙音响条源头工厂'],
  'solar panel':         ['太阳能板工厂', '太阳能充电板厂家', '太阳能板源头工厂'],
  'gimbal stabilizer':   ['手持稳定器工厂', '云台稳定器厂家', '手持云台源头工厂'],
  'lavalier microphone': ['领夹麦克风工厂', '无线麦克风厂家', '领夹麦克风源头工厂'],
  'smart ring':          ['智能戒指工厂', '智能戒指厂家', '智能穿戴源头工厂'],
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
