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
