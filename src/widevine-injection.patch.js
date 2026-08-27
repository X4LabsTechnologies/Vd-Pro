/**
 * PATCH FILE: Integration points for VideoExtractor
 * This file documents where Widevine is integrated into the extraction pipeline
 * 
 * INTEGRATION POINTS:
 * 1. Line ~1268: VideoExtractor.extract() method entry
 *    - Initialize Widevine adapter if needed
 *    - Pass adapter instance to extraction pipeline
 * 
 * 2. Line ~1359: onResponse handler
 *    - Check for DRM indicators in response headers/body
 *    - Mark diagnostics.drmSuspected = true
 *    - Call WidevineAdapter.isDrmProtected() for enhanced detection
 * 
 * 3. Line ~1631: HLS parsing with Widevine awareness
 *    - After parsing HLS/DASH, check for DRM encryption
 *    - If drmSuspected, record in variant metadata
 * 
 * 4. Line ~1720: Validation result processing
 *    - When validation fails with DRM suspected
 *    - Call WidevineAdapter.handleDrmChallenge() if available
 *    - Log Widevine session info if attempt made
 * 
 * 5. Line ~1765-1789: Error classification
 *    - Enhanced DRM_PROTECTED error reporting
 *    - Include Widevine adapter status in diagnostics
 */

import WidevineAdapter from './widevine-adapter.js';

export const WIDEVINE_INTEGRATION_POINTS = {
  EXTRACT_INIT: 'VideoExtractor.extract() start',
  ON_RESPONSE: 'Response handler DRM check',
  HLS_PARSE: 'HLS/DASH manifest parsing',
  VALIDATION: 'Media validation result',
  ERROR_CLASS: 'Error classification and reporting'
};

export function enhanceDrmDetection(url, contentType, responseBody) {
  const isDrm = WidevineAdapter.isDrmProtected(url, contentType);
  const bodyStr = String(responseBody || '');
  const hasEncryptionKey = /EXT-X-KEY:.*METHOD=(?!NONE)/i.test(bodyStr) || /<ContentProtection[^>]*>/i.test(bodyStr);
  
  return isDrm || hasEncryptionKey;
}

export async function attemptWidevineHandling(url, diagnostics) {
  if (!WidevineAdapter.available) return null;
  
  try {
    const result = await WidevineAdapter.handleDrmChallenge(url);
    if (result) {
      diagnostics.widevineAttempted = true;
      diagnostics.widevineSessionId = result.sessionId;
      return result;
    }
  } catch (error) {
    console.warn('[Widevine] DRM handling attempt failed:', error.message);
  }
  
  return null;
}

export function recordWidevineStatus(diagnostics) {
  diagnostics.widevineAvailable = WidevineAdapter.available;
  diagnostics.widevineStatus = WidevineAdapter.getStatus();
  return diagnostics;
}
