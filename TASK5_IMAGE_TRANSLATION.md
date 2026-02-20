# Task 5: Image Translation — Implementation Guide

## Overview

Task 5 translates Chinese text **inside product images** to English using OCR + Translation + Image Overlay, then **uploads to Tencent Cloud COS** for permanent storage.

**Cost: FREE** when using Tesseract + Baidu (China MacBook setup) ✅

**Storage**: All translated images are stored on **Tencent Cloud COS** (not locally) with public URLs saved to database.

---

## How It Works

1. **OCR Extraction**: Uses Tesseract.js (or Google Vision) to detect Chinese text and get exact positions
2. **Translation**: Translates Chinese text to English using Baidu Translate API (or Google)
3. **Image Overlay**: Uses Sharp library to create new images with English text overlaid
4. **COS Upload**: Uploads translated images to Tencent Cloud COS bucket ← **NEW!**
5. **URL Storage**: Saves public COS URLs to database
6. **Cleanup**: Deletes local temporary files after successful upload

---

## Auto-Detection (Same as Task 3 & 4)

The system automatically chooses providers based on your `.env`:

| Machine | OCR Provider | Translation Provider | Cost |
|---------|-------------|---------------------|------|
| **China MacBook** (no `GOOGLE_CLOUD_API_KEY`) | Tesseract.js (local) | Baidu Translate | **FREE** ✅ |
| **Main Computer** (has `GOOGLE_CLOUD_API_KEY`) | Google Vision API | Google Translate | ~$15-20 per 10k images |

---

## Installation

### 1. Install dependencies (Sharp + COS SDK)

```bash
npm install
```

This installs:
- **Sharp** - Image processing library
- **cos-nodejs-sdk-v5** - Tencent Cloud COS SDK

If you get installation errors on China MacBook:

```bash
# If Sharp fails to install, try:
npm install sharp --platform=darwin --arch=arm64
# Or for Intel Mac:
npm install sharp --platform=darwin --arch=x64
```

### 2. Configure Tencent Cloud COS in .env

Your `.env` file already has COS configured:

```bash
TENCENT_SECRET_ID=***REMOVED***
TENCENT_SECRET_KEY=***REMOVED***
COS_BUCKET_NAME=autostore1688-1255419904
COS_REGION=ap-guangzhou
```

### 3. Build the project

```bash
npm run build
# Or manually:
./node_modules/.bin/tsc
```

---

## Usage

### Run Task 5 directly:

```bash
# Process 10 products
node dist/tasks/task5-translate-images.js --limit 10

# Process 50 products
node dist/tasks/task5-translate-images.js --limit 50

# Force retranslate even if already done
node dist/tasks/task5-translate-images.js --limit 10 --force
```

### Using npm shortcut:

```bash
npm run task:translate-images -- --limit 10
```

---

## Pipeline Flow

```
Task 1: Discover Products
    ↓
Task 2: Scrape Details
    ↓
Task 3: Check Images (OCR to detect Chinese text)
    ↓
Task 4: Translate Text (title, description, specs)
    ↓
Task 5: Translate Images (NEW! ← Translate Chinese text IN images)
    ↓
Status: images_translated
```

---

## Database Changes

### New Table: `products_images_translated`

```sql
CREATE TABLE products_images_translated (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  raw_image_id INT NOT NULL,
  original_image_url VARCHAR(1000) NOT NULL,
  translated_image_url VARCHAR(1000) NOT NULL,  -- COS public URL
  cos_key VARCHAR(500),                          -- COS object key
  text_regions_count INT DEFAULT 0,
  success BOOLEAN DEFAULT TRUE,
  translated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (raw_image_id) REFERENCES products_images_raw(id) ON DELETE CASCADE,
  UNIQUE KEY unique_raw_image (raw_image_id)
);
```

### New Status: `images_translated`

The `products.status` field now includes:
- `discovered` → `detail_scraped` → `images_checked` → `translated` → **`images_translated`** ← NEW!

---

## Output & Storage

### COS Storage Structure:

```
Bucket: autostore1688-1255419904
Region: ap-guangzhou

translated_images/
  {product_id_1688}/
    image_0.jpg
    image_1.jpg
    image_2.jpg
    ...
```

### Public URLs:

```
https://autostore1688-1255419904.cos.ap-guangzhou.myqcloud.com/translated_images/{product_id}/image_0.jpg
https://autostore1688-1255419904.cos.ap-guangzhou.myqcloud.com/translated_images/{product_id}/image_1.jpg
...
```

### Local Storage:

- **Temporary files only**: Created in `temp_images/translated/` during processing
- **Automatically deleted**: After successful COS upload
- **No permanent local storage**: Only COS URLs are kept in database

---

## Cost Breakdown (Tesseract + Baidu)

### For 10,000 images:

| Component | Service | Cost |
|-----------|---------|------|
| OCR | Tesseract.js (local) | **$0** |
| Translation | Baidu Translate Free Tier | **$0** (up to 1M chars/month) |
| Image Processing | Sharp (local) | **$0** |
| **TOTAL** | | **$0** 🎉 |

### Baidu Free Tier Limits:
- **1 million characters/month** for translation
- **1 QPS** (1 query per second) rate limit
- Automatic retry with delay if rate limited

---

## Files Added/Modified

### NEW Files:
1. `src/services/imageTranslator.ts` — Image translation service with OCR + overlay
2. `src/services/cosUploader.ts` — Tencent Cloud COS upload service ← **NEW!**
3. `src/tasks/task5-translate-images.ts` — Task 5 CLI script
4. `TASK5_IMAGE_TRANSLATION.md` — This documentation

### Modified Files:
1. `src/database/db.ts` — Added `products_images_translated` table with `translated_image_url` and `cos_key`
2. `src/models/product.ts` — Added `images_translated` status
3. `src/services/translator.ts` — Exported `translateText()` function
4. `src/config.ts` — Added Tencent Cloud COS configuration
5. `package.json` — Added Sharp + COS SDK dependencies + npm script
6. `CLAUDE.md` — Updated documentation

---

## Example Output

### Before:
![Original image with Chinese text]

### After:
![Translated image with English text overlaid]

Text regions detected and translated:
- "耳机" → "Earphones"
- "无线蓝牙" → "Wireless Bluetooth"
- "降噪" → "Noise Cancelling"

---

## Logging

Task 5 logs include:
- Provider detection (Tesseract/Google + Baidu/Google)
- Number of images processed per product
- Text regions detected per image
- Translation success/failure
- Final statistics

Example log output:
```
[task5-translate-images] Task 5: Image Translation { limit: 10 }
[task5-translate-images] Found 8 products to process
[task5-translate-images] Processing 1/8: TWS无线蓝牙耳机 降噪运动...
[imageTranslator] Extracting text from image { provider: 'tesseract', size: 245678 }
[imageTranslator] Found 5 Chinese text regions in image
[translator] Translating text { provider: 'baidu' }
[task5-translate-images] Product images translated successfully { id: '123456', translatedCount: 3 }
[task5-translate-images] Task 5 complete { processed: 8, successful: 7, skipped: 1, failed: 0 }
```

---

## Troubleshooting

### Sharp installation fails
```bash
# Clear npm cache and reinstall
npm cache clean --force
rm -rf node_modules package-lock.json
npm install
```

### Tesseract worker initialization slow
- First run downloads language data (~50MB for chi_sim + eng)
- Subsequent runs use cached data
- To speed up: pre-download tessdata to `data/tessdata/` folder

### Baidu rate limit (54003 error)
- Free tier: 1 QPS limit
- Task 5 automatically retries with 1.5s delay
- To avoid: process smaller batches (--limit 5)

### Text overlay quality issues
Sharp's text rendering is basic. For better quality:
- Use larger font sizes (adjust in `imageTranslator.ts`)
- Match background color (currently white rectangle)
- Consider using node-canvas for more control

---

## Next Steps

1. **Test on a few products first**:
   ```bash
   npm run task:translate-images -- --limit 3
   ```

2. **Check output images**:
   ```bash
   ls -la temp_images/translated/
   ```

3. **Review database**:
   ```sql
   SELECT * FROM products_images_translated LIMIT 10;
   ```

4. **Run on full dataset**:
   ```bash
   npm run task:translate-images -- --limit 100
   ```

---

## Performance

- **OCR**: ~2-5 seconds per image (Tesseract), ~0.5-1 second (Google Vision)
- **Translation**: ~0.1-0.5 seconds per text block
- **Image overlay**: ~0.2-0.5 seconds per image
- **Total**: ~3-6 seconds per image with Tesseract + Baidu

For 1000 images: **~1-2 hours**

---

## Questions?

Check the logs in `logs/` directory or review:
- `src/services/imageTranslator.ts` — Core implementation
- `src/tasks/task5-translate-images.ts` — Task logic
- `CLAUDE.md` — Full project documentation
