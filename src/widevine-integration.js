/**
 * WidevineProxy2 Integration Module
 * Provides optional Widevine capabilities to Vd-Pro extraction pipeline
 * Can be used for enhanced DRM detection and reporting
 */

import { loadWidevineProxy, loadWidevineComponent } from './widevine-bridge.js';

class WidevineIntegration {
  constructor() {
    this.available = false;
    this.session = null;
    this.util = null;
  }

  /**
   * Initialize WidevineProxy2 integration
   * Safely loads all available components
   */
  async initialize() {
    try {
      // Load Session component
      const sessionModule = await loadWidevineComponent('session');
      if (sessionModule) {
        this.session = sessionModule;
      }

      // Load Util component
      const utilModule = await loadWidevineComponent('util');
      if (utilModule) {
        this.util = utilModule;
      }

      // Mark as available if at least one component loaded
      this.available = this.session || this.util;

      if (this.available) {
        console.log('WidevineProxy2 integration initialized successfully');
      } else {
        console.warn(
          'WidevineProxy2 integration: No components available (optional)'
        );
      }
    } catch (error) {
      console.warn('WidevineProxy2 integration initialization failed:', error.message);
      this.available = false;
    }
  }

  /**
   * Check if URL requires Widevine decryption
   * @param {string} url - Media URL to check
   * @returns {boolean} True if Widevine suspected
   */
  suspectWidevine(url) {
    if (!url) return false;
    const urlStr = String(url).toLowerCase();
    // Check for common Widevine indicators
    return /widevine|drm|encrypted|fairplay|playready/.test(urlStr);
  }

  /**
   * Get Widevine session if available
   * @returns {Object|null} Session object or null
   */
  async getSession() {
    if (!this.available || !this.session) return null;

    try {
      return await this.session.createSession();
    } catch (error) {
      console.warn('Failed to create Widevine session:', error.message);
      return null;
    }
  }

  /**
   * Get Widevine utilities if available
   * @returns {Object|null} Utilities object or null
   */
  getUtil() {
    return this.util || null;
  }

  /**
   * Get integration status
   * @returns {Object} Status information
   */
  getStatus() {
    return {
      available: this.available,
      hasSession: !!this.session,
      hasUtil: !!this.util,
      timestamp: new Date().toISOString(),
    };
  }
}

export default WidevineIntegration;
