/**
 * Test Baidu OCR integration
 * 
 * Tests the new Baidu OCR service with sample 1688 product images
 */

import { baiduOcrService } from './src/services/baiduOcr';
import axios from 'axios';

const testImages = [
  'https://cbu01.alicdn.com/img/ibank/O1CN01cKeebv1XQUpZSA8Vs_!!2543422918-0-cib.jpg',
  'https://cbu01.alicdn.com/img/ibank/O1CN01OnbXBc1XQUl6rgF4c_!!2543422918-0-cib.jpg',
  'https://cbu01.alicdn.com/img/ibank/O1CN01Wmm4IM2NXh0iBfFV7_!!2218495689973-0-cib.jpg',
];

async function testBaiduOcr() {
  console.log('🧪 Testing Baidu OCR Service\n');
  
  for (let i = 0; i < testImages.length; i++) {
    const imageUrl = testImages[i];
    console.log(`\n📸 Testing Image ${i + 1}: ${imageUrl}`);
    
    try {
      // Download image
      console.log('  ⬇️  Downloading image...');
      const response = await axios.get(imageUrl, { 
        responseType: 'arraybuffer',
        timeout: 30000 
      });
      
      const imageBuffer = Buffer.from(response.data);
      console.log(`  📊 Image size: ${imageBuffer.length} bytes`);
      
      // Test OCR
      console.log('  🔍 Running Baidu OCR...');
      const startTime = Date.now();
      
      const regions = await baiduOcrService.extractChineseTextRegions(imageBuffer);
      
      const endTime = Date.now();
      console.log(`  ⏱️  OCR completed in ${endTime - startTime}ms`);
      console.log(`  📝 Found ${regions.length} Chinese text regions`);
      
      // Display results
      if (regions.length > 0) {
        console.log('  📋 Text regions:');
        regions.forEach((region, idx) => {
          console.log(`    ${idx + 1}. "${region.text}"`);
          console.log(`       Confidence: ${(region.confidence * 100).toFixed(1)}%`);
          console.log(`       Position: (${region.boundingBox.x}, ${region.boundingBox.y}) ${region.boundingBox.width}x${region.boundingBox.height}`);
        });
      } else {
        console.log('  ❌ No Chinese text detected');
      }
      
    } catch (error) {
      console.error(`  ❌ Error testing image ${i + 1}:`, error instanceof Error ? error.message : error);
    }
    
    // Small delay between tests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log('\n✅ Baidu OCR testing completed!');
}

// Run test if this file is executed directly
if (require.main === module) {
  testBaiduOcr().catch(error => {
    console.error('❌ Test failed:', error);
    process.exit(1);
  });
}

export { testBaiduOcr };