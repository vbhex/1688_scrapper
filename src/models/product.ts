export interface ProductSpecification {
  name: string;
  value: string;
}

export interface SellerInfo {
  name: string;
  rating?: number;
  transactionCount?: number;
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
  | 'skipped'
  | 'failed';

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
