/**
 * Baidu OCR Service
 * 
 * Enhanced Baidu OCR integration for Chinese text recognition
 * Uses Baidu's General OCR API which is optimized for Chinese text
 * 
 * API Docs: https://cloud.baidu.com/doc/OCR/s/zk3h7xzxe
 */

import axios from 'axios';
import crypto from 'crypto';
import { createChildLogger } from '../utils/logger';
import { config } from '../config';

const logger = createChildLogger('baiduOcr');

// Baidu OCR API endpoints
const BAIDU_OCR_URL = 'https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic';
const BAIDU_OCR_ACCURATE_URL = 'https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic';
const BAIDU_OCR_GENERAL_URL = 'https://aip.baidubce.com/rest/2.0/ocr/v1/general';

interface BaiduOcrResponse {
  words_result?: Array<{
    words: string;
    location?: {
      left: number;
      top: number;
      width: number;
      height: number;
    };
    probability?: {
      average: number;
      min: number;
      variance: number;
    };
  }>;
  words_result_num?: number;
  error_code?: number;
  error_msg?: string;
  log_id?: number;
}

interface AccessTokenResponse {
  access_token: string;
  session_key: string;
  scope: string;
  refresh_token: string;
  session_secret: string;
  expires_in: number;
}

class BaiduOcrService {
  private accessToken: string = '';
  private tokenExpiry: number = 0;

  /**
   * Get access token for Baidu OCR API
   */
  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const clientId = config.baidu.translateAppId;
    const clientSecret = config.baidu.translateSecret;

    if (!clientId || !clientSecret) {
      throw new Error('Baidu OCR credentials not configured');
    }

    try {
      const response = await axios.get<AccessTokenResponse>(
        'https://aip.baidubce.com/oauth/2.0/token',
        {
          params: {
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret,
          },
          timeout: 10000,
        }
      );

      this.accessToken = response.data.access_token;
      this.tokenExpiry = Date.now() + (response.data.expires_in - 300) * 1000; // Refresh 5 minutes early
      
      logger.info('Obtained Baidu OCR access token', { 
        expiresIn: response.data.expires_in,
        scope: response.data.scope 
      });

      return this.accessToken;
    } catch (error) {
      logger.error('Failed to get Baidu OCR access token', { 
        error: axios.isAxiosError(error) ? error.response?.data : error 
      });
      throw error;
    }
  }

  /**
   * Extract text from image using Baidu OCR
   */
  async extractText(
    imageBuffer: Buffer, 
    options: {
      accurate?: boolean;
      detectDirection?: boolean;
      probability?: boolean;
      languageType?: 'CHN_ENG' | 'ENG' | 'JAP' | 'KOR' | 'FRE' | 'SPA' | 'GER' | 'RUS' | 'POR';
    } = {}
  ): Promise<BaiduOcrResponse> {
    const accessToken = await this.getAccessToken();
    
    // Choose endpoint based on accuracy requirement
    const endpoint = options.accurate ? BAIDU_OCR_ACCURATE_URL : BAIDU_OCR_GENERAL_URL;
    
    // Convert image to base64
    const base64Image = imageBuffer.toString('base64');
    
    // Build request parameters
    const params = new URLSearchParams();
    params.append('image', base64Image);
    params.append('language_type', options.languageType || 'CHN_ENG');
    
    if (options.detectDirection) {
      params.append('detect_direction', 'true');
    }
    
    if (options.probability) {
      params.append('probability', 'true');
    }

    try {
      const response = await axios.post<BaiduOcrResponse>(
        `${endpoint}?access_token=${accessToken}`,
        params.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          },
          timeout: 30000,
        }
      );

      if (response.data.error_code) {
        logger.error('Baidu OCR API error', {
          errorCode: response.data.error_code,
          errorMsg: response.data.error_msg,
          endpoint,
        });
        throw new Error(`Baidu OCR error ${response.data.error_code}: ${response.data.error_msg}`);
      }

      logger.info('Baidu OCR extraction successful', {
        wordsCount: response.data.words_result_num || 0,
        endpoint: endpoint.includes('accurate') ? 'accurate' : 'general',
      });

      return response.data;
    } catch (error) {
      logger.error('Baidu OCR extraction failed', {
        error: axios.isAxiosError(error) ? error.response?.data : error,
        endpoint,
      });
      throw error;
    }
  }

  /**
   * Extract Chinese text regions with bounding boxes
   */
  async extractChineseTextRegions(imageBuffer: Buffer): Promise<Array<{
    text: string;
    boundingBox: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    confidence: number;
  }>> {
    try {
      const result = await this.extractText(imageBuffer, {
        accurate: true, // Use accurate mode for better Chinese recognition
        probability: true, // Get confidence scores
        languageType: 'CHN_ENG', // Focus on Chinese and English
      });

      if (!result.words_result || result.words_result.length === 0) {
        return [];
      }

      // Filter for Chinese text and convert to standard format
      const chineseRegions = result.words_result
        .filter(item => this.containsChinese(item.words))
        .map(item => ({
          text: item.words,
          boundingBox: {
            x: item.location?.left || 0,
            y: item.location?.top || 0,
            width: item.location?.width || 0,
            height: item.location?.height || 0,
          },
          confidence: item.probability?.average || 0,
        }))
        .filter(region => region.confidence > 0.5); // Filter low confidence detections

      logger.info(`Baidu OCR found ${chineseRegions.length} Chinese text regions`);
      return chineseRegions;
    } catch (error) {
      logger.error('Failed to extract Chinese text regions', { error });
      return [];
    }
  }

  /**
   * Check if text contains Chinese characters
   */
  private containsChinese(text: string): boolean {
    return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text);
  }

  /**
   * Test OCR with a sample image
   */
  async testOcr(imageUrl: string): Promise<void> {
    try {
      logger.info('Testing Baidu OCR with sample image', { imageUrl });
      
      // Download test image
      const axios = require('axios');
      const response = await axios.get(imageUrl, { 
        responseType: 'arraybuffer',
        timeout: 30000 
      });
      
      const imageBuffer = Buffer.from(response.data);
      const result = await this.extractChineseTextRegions(imageBuffer);
      
      logger.info('Baidu OCR test results', {
        totalRegions: result.length,
        regions: result.map(r => ({
          text: r.text,
          confidence: r.confidence,
          box: r.boundingBox,
        })),
      });
    } catch (error) {
      logger.error('Baidu OCR test failed', { error });
    }
  }
}

// Export singleton instance
export const baiduOcrService = new BaiduOcrService();

// Export for testing
export { BaiduOcrService };