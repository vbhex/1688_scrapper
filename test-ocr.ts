/**
 * Quick test: download an image and run Tesseract OCR to check detection
 */
import axios from 'axios';
import fs from 'fs';
import path from 'path';

async function main() {
  const Tesseract = require('tesseract.js');

  // Test image from product 1 (flagged as having Chinese text)
  const url = 'https://cbu01.alicdn.com/img/ibank/O1CN01cKeebv1XQUpZSA8Vs_!!2543422918-0-cib.jpg';
  console.log('Downloading:', url);
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  const buf = Buffer.from(resp.data);
  console.log('Image size:', buf.length, 'bytes');

  // Save locally for inspection
  const testDir = path.join(__dirname, '..', 'temp_images', 'test');
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(path.join(testDir, 'test_image.jpg'), buf);
  console.log('Saved to:', path.join(testDir, 'test_image.jpg'));

  // Try Tesseract with local data
  const projectRoot = path.resolve(__dirname, '..');
  const tessdata = path.join(projectRoot, 'tessdata');
  console.log('Tessdata path:', tessdata);
  console.log('chi_sim exists:', fs.existsSync(path.join(tessdata, 'chi_sim.traineddata')));
  console.log('eng exists:', fs.existsSync(path.join(tessdata, 'eng.traineddata')));

  // Test 1: chi_sim + eng (default)
  console.log('\n=== Test 1: chi_sim + eng ===');
  const worker1 = await Tesseract.createWorker(['chi_sim', 'eng'], 1, {
    langPath: tessdata,
    gzip: false,
  });
  const result1 = await worker1.recognize(buf);
  console.log('Full text:', JSON.stringify(result1.data.text.substring(0, 500)));
  console.log('Lines:', (result1.data.lines || []).length);
  for (const line of (result1.data.lines || []).slice(0, 10)) {
    const hasChinese = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(line.text);
    console.log(`  [${line.confidence.toFixed(1)}%] ${hasChinese ? 'ZH' : 'EN'}: ${line.text.trim()}`);
  }
  await worker1.terminate();

  // Test 2: chi_sim only
  console.log('\n=== Test 2: chi_sim only ===');
  const worker2 = await Tesseract.createWorker('chi_sim', 1, {
    langPath: tessdata,
    gzip: false,
  });
  const result2 = await worker2.recognize(buf);
  console.log('Full text:', JSON.stringify(result2.data.text.substring(0, 500)));
  console.log('Lines:', (result2.data.lines || []).length);
  for (const line of (result2.data.lines || []).slice(0, 10)) {
    const hasChinese = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(line.text);
    console.log(`  [${line.confidence.toFixed(1)}%] ${hasChinese ? 'ZH' : 'EN'}: ${line.text.trim()}`);
  }
  await worker2.terminate();

  // Test 3: With preprocessing (grayscale + normalize)
  console.log('\n=== Test 3: Preprocessed (grayscale) ===');
  try {
    const sharp = require('sharp');
    const preprocessed = await sharp(buf).grayscale().normalize().toBuffer();
    console.log('Preprocessed size:', preprocessed.length, 'bytes');

    const worker3 = await Tesseract.createWorker(['chi_sim', 'eng'], 1, {
      langPath: tessdata,
      gzip: false,
    });
    const result3 = await worker3.recognize(preprocessed);
    console.log('Full text:', JSON.stringify(result3.data.text.substring(0, 500)));
    console.log('Lines:', (result3.data.lines || []).length);
    for (const line of (result3.data.lines || []).slice(0, 10)) {
      const hasChinese = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(line.text);
      console.log(`  [${line.confidence.toFixed(1)}%] ${hasChinese ? 'ZH' : 'EN'}: ${line.text.trim()}`);
    }
    await worker3.terminate();
  } catch (e: any) {
    console.log('Sharp test failed:', e.message);
  }

  // Also test second product's image
  console.log('\n=== Test 4: Product 2 image ===');
  const url2 = 'https://cbu01.alicdn.com/img/ibank/O1CN0121mQYg2NXh0hmRL2V_!!2218495689973-0-cib.jpg';
  console.log('Downloading:', url2);
  const resp2 = await axios.get(url2, { responseType: 'arraybuffer', timeout: 30000 });
  const buf2 = Buffer.from(resp2.data);
  console.log('Image size:', buf2.length, 'bytes');

  const worker4 = await Tesseract.createWorker(['chi_sim', 'eng'], 1, {
    langPath: tessdata,
    gzip: false,
  });
  const result4 = await worker4.recognize(buf2);
  console.log('Full text:', JSON.stringify(result4.data.text.substring(0, 500)));
  console.log('Lines:', (result4.data.lines || []).length);
  for (const line of (result4.data.lines || []).slice(0, 10)) {
    const hasChinese = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(line.text);
    console.log(`  [${line.confidence.toFixed(1)}%] ${hasChinese ? 'ZH' : 'EN'}: ${line.text.trim()}`);
  }
  await worker4.terminate();

  console.log('\n=== DONE ===');
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
