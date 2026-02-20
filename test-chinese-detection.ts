/**
 * Test script for Chinese text detection strategy
 * 
 * This demonstrates the new approach: detect Chinese text and filter images,
 * instead of translating the text.
 */

import axios from 'axios';
import Tesseract from 'tesseract.js';

const testImages = [
  'https://cbu01.alicdn.com/img/ibank/O1CN01cKeebv1XQUpZSA8Vs_!!2543422918-0-cib.jpg',
  'https://cbu01.alicdn.com/img/ibank/O1CN01OnbXBc1XQUl6rgF4c_!!2543422918-0-cib.jpg', 
  'https://cbu01.alicdn.com/img/ibank/O1CN01Wmm4IM2NXh0iBfFV7_!!2218495689973-0-cib.jpg',
];

/**
 * Check if text contains Chinese characters
 */
function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text);
}

/**
 * Detect Chinese text in image using Tesseract.js
 */
async function detectChineseText(imageUrl: string): Promise<{
  hasChineseText: boolean;
  confidence: number;
  textRegions: Array<{ text: string; boundingBox: any }>;
  detectedText: string;
}> {
  try {
    console.log(`🔍 Processing: ${imageUrl}`);
    
    // Download image
    const response = await axios.get(imageUrl, { 
      responseType: 'arraybuffer',
      timeout: 30000 
    });
    
    const imageBuffer = Buffer.from(response.data);
    
    // Use Tesseract.js for detection (not translation)
    const worker = await Tesseract.createWorker(['chi_sim', 'eng'], 1, {
      logger: m => console.log('Tesseract:', m.status, m.progress?.toFixed(2)),
    });

    // Detect text with positions
    const { data } = await worker.recognize(imageBuffer, {}, { blocks: true });
    await worker.terminate();

    const textRegions: Array<{ text: string; boundingBox: any }> = [];
    let totalConfidence = 0;
    let regionCount = 0;
    let allText = '';

    // Check for Chinese text in detected regions
    for (const block of (data.blocks || [])) {
      for (const para of (block.paragraphs || [])) {
        for (const line of (para.lines || [])) {
          for (const word of (line.words || [])) {
            if (!word.text) continue;
            
            allText += word.text + ' ';
            
            // Check if text contains Chinese characters
            if (containsChinese(word.text)) {
              textRegions.push({
                text: word.text.trim(),
                boundingBox: word.bbox,
              });
              totalConfidence += word.confidence || 0;
              regionCount++;
            }
          }
        }
      }
    }

    const hasChineseText = textRegions.length > 0;
    const avgConfidence = regionCount > 0 ? totalConfidence / regionCount : 0;

    return {
      hasChineseText,
      confidence: avgConfidence,
      textRegions,
      detectedText: allText.trim(),
    };

  } catch (error) {
    console.error('Failed to detect Chinese text:', error);
    return {
      hasChineseText: false,
      confidence: 0,
      textRegions: [],
      detectedText: '',
    };
  }
}

/**
 * Test the new filtering strategy
 */
async function testFilteringStrategy() {
  console.log('🧪 Testing Chinese Text Detection Strategy\n');
  
  let totalImages = 0;
  let imagesWithChineseText = 0;
  let imagesWithoutChineseText = 0;
  
  for (let i = 0; i < testImages.length; i++) {
    const imageUrl = testImages[i];
    console.log(`\n📸 Testing Image ${i + 1}: ${imageUrl}`);
    
    try {
      const detection = await detectChineseText(imageUrl);
      totalImages++;
      
      console.log(`   📊 Result: ${detection.hasChineseText ? '❌ Contains Chinese text' : '✅ No Chinese text detected'}`);
      console.log(`   🔍 Confidence: ${detection.confidence.toFixed(1)}%`);
      console.log(`   📝 Detected text: "${detection.detectedText.substring(0, 100)}${detection.detectedText.length > 100 ? '...' : ''}"`);
      
      if (detection.textRegions.length > 0) {
        console.log(`   🎯 Chinese text regions: ${detection.textRegions.length}`);
        detection.textRegions.forEach((region, idx) => {
          console.log(`      ${idx + 1}. "${region.text}" (confidence: ${region.boundingBox.confidence?.toFixed(1) || 'N/A'}%)`);
        });
        imagesWithChineseText++;
      } else {
        imagesWithoutChineseText++;
      }
      
    } catch (error) {
      console.error(`   ❌ Error:`, error instanceof Error ? error.message : error);
    }
    
    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 FILTERING STRATEGY RESULTS');
  console.log('='.repeat(60));
  console.log(`📸 Total images processed: ${totalImages}`);
  console.log(`❌ Images with Chinese text: ${imagesWithChineseText}`);
  console.log(`✅ Clean images (no Chinese text): ${imagesWithoutChineseText}`);
  
  const chineseRatio = totalImages > 0 ? imagesWithChineseText / totalImages : 0;
  console.log(`📈 Chinese text ratio: ${(chineseRatio * 100).toFixed(1)}%`);
  
  // Recommendation based on different thresholds
  const thresholds = [0.3, 0.5, 0.7];
  console.log('\n🎯 PRODUCT FILTERING RECOMMENDATIONS:');
  
  thresholds.forEach(threshold => {
    const shouldSkip = chineseRatio > threshold;
    const status = shouldSkip ? 'SKIP' : 'KEEP';
    const emoji = shouldSkip ? '❌' : '✅';
    console.log(`   ${emoji} Threshold ${(threshold * 100).toFixed(0)}%: ${status} product (current: ${(chineseRatio * 100).toFixed(1)}%)`);
  });
  
  console.log('\n💡 STRATEGY SUMMARY:');
  console.log('   • Use Tesseract.js for Chinese text detection (not translation)');
  console.log('   • Skip images with Chinese text detected');
  console.log('   • Skip products where >50% of images have Chinese text');
  console.log('   • Keep products with mostly clean images for upload');
  console.log('   • This avoids complex/costly OCR translation while maintaining quality');
}

if (require.main === module) {
  testFilteringStrategy().catch(error => {
    console.error('❌ Test failed:', error);
    process.exit(1);
  });
}

export { detectChineseText, containsChinese, testFilteringStrategy };