/**
 * Systematic OCR quality test: compare different Tesseract configs
 * to find the best settings for 1688 product images.
 *
 * Tests: PSM modes, word vs line level, confidence thresholds, preprocessing
 */
import axios from 'axios';
import fs from 'fs';
import path from 'path';

interface BBox {
  x0: number; y0: number; x1: number; y1: number;
  text: string; confidence: number; level: string;
}

function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text);
}

async function testImage(
  worker: any,
  imageBuffer: Buffer,
  label: string,
  useWords: boolean = false,
): Promise<BBox[]> {
  const { data } = await worker.recognize(imageBuffer, {}, { blocks: true });
  const boxes: BBox[] = [];

  for (const block of (data.blocks || [])) {
    for (const para of (block.paragraphs || [])) {
      for (const line of (para.lines || [])) {
        if (useWords) {
          // Word-level: smaller, more precise bounding boxes
          for (const word of (line.words || [])) {
            if (!word.text || !containsChinese(word.text)) continue;
            if (word.confidence < 20) continue;
            boxes.push({
              ...word.bbox,
              text: word.text.trim(),
              confidence: word.confidence,
              level: 'word',
            });
          }
        } else {
          // Line-level: larger bounding boxes
          if (!line.text || !containsChinese(line.text)) continue;
          if (line.confidence < 30) continue;
          boxes.push({
            ...line.bbox,
            text: line.text.trim(),
            confidence: line.confidence,
            level: 'line',
          });
        }
      }
    }
  }

  console.log(`\n--- ${label} ---`);
  console.log(`  Detected: ${boxes.length} regions`);
  for (const b of boxes) {
    const w = b.x1 - b.x0;
    const h = b.y1 - b.y0;
    const area = w * h;
    console.log(`  [${b.confidence.toFixed(0)}%] ${b.level} ${w}x${h} (area=${area}) "${b.text.substring(0, 30)}"`);
  }
  return boxes;
}

async function main() {
  const Tesseract = require('tesseract.js');
  const sharp = require('sharp');

  const tessdata = path.join(__dirname, '..', 'tessdata');

  // Test images (one from each product)
  const testUrls = [
    'https://cbu01.alicdn.com/img/ibank/O1CN01cKeebv1XQUpZSA8Vs_!!2543422918-0-cib.jpg',
    'https://cbu01.alicdn.com/img/ibank/O1CN01OnbXBc1XQUl6rgF4c_!!2543422918-0-cib.jpg',
    'https://cbu01.alicdn.com/img/ibank/O1CN01Wmm4IM2NXh0iBfFV7_!!2218495689973-0-cib.jpg',
  ];

  for (let imgIdx = 0; imgIdx < testUrls.length; imgIdx++) {
    const url = testUrls[imgIdx];
    console.log(`\n${'='.repeat(70)}`);
    console.log(`IMAGE ${imgIdx + 1}: ${url.substring(url.lastIndexOf('/') + 1, url.lastIndexOf('/') + 30)}...`);

    let buf: Buffer;
    try {
      const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
      buf = Buffer.from(resp.data);
    } catch {
      console.log('  SKIP: could not download');
      continue;
    }

    const meta = await sharp(buf).metadata();
    console.log(`  Size: ${meta.width}x${meta.height}, ${buf.length} bytes`);

    // Preprocess variants
    const original = buf;
    const grayscale = await sharp(buf).grayscale().normalize().toBuffer();

    // Test 1: Line-level, chi_sim+eng, original
    const w1 = await Tesseract.createWorker(['chi_sim', 'eng'], 1, { langPath: tessdata, gzip: false });
    await testImage(w1, original, 'Lines | chi_sim+eng | original', false);
    await testImage(w1, original, 'Words | chi_sim+eng | original', true);
    await testImage(w1, grayscale, 'Words | chi_sim+eng | grayscale', true);
    await w1.terminate();

    // Test 2: chi_sim only (might be more accurate for Chinese)
    const w2 = await Tesseract.createWorker('chi_sim', 1, { langPath: tessdata, gzip: false });
    await testImage(w2, original, 'Words | chi_sim only | original', true);
    await w2.terminate();

    // Test 3: Higher confidence threshold comparison
    const w3 = await Tesseract.createWorker(['chi_sim', 'eng'], 1, { langPath: tessdata, gzip: false });
    const { data: d3 } = await w3.recognize(original, {}, { blocks: true });
    console.log(`\n--- Confidence distribution ---`);
    const allWords: Array<{ text: string; conf: number; w: number; h: number }> = [];
    for (const block of (d3.blocks || [])) {
      for (const para of (block.paragraphs || [])) {
        for (const line of (para.lines || [])) {
          for (const word of (line.words || [])) {
            if (containsChinese(word.text)) {
              const w = word.bbox.x1 - word.bbox.x0;
              const h = word.bbox.y1 - word.bbox.y0;
              allWords.push({ text: word.text.trim(), conf: word.confidence, w, h });
            }
          }
        }
      }
    }
    const bins = [0, 20, 40, 60, 80, 100];
    for (let i = 0; i < bins.length - 1; i++) {
      const count = allWords.filter(w => w.conf >= bins[i] && w.conf < bins[i + 1]).length;
      console.log(`  ${bins[i]}-${bins[i + 1]}%: ${count} words`);
    }

    // Show words with size info to identify oversized boxes
    console.log(`\n--- All Chinese words (sorted by area) ---`);
    allWords.sort((a, b) => (b.w * b.h) - (a.w * a.h));
    for (const w of allWords.slice(0, 15)) {
      console.log(`  [${w.conf.toFixed(0)}%] ${w.w}x${w.h} area=${w.w * w.h} "${w.text.substring(0, 20)}"`);
    }

    await w3.terminate();
  }

  console.log('\n\nDONE');
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
