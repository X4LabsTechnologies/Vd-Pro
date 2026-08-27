/**
 * Widevine Adapter - Direct integration with VideoExtractor
 * Handles DRM detection and session management
 */

import { loadWidevineComponent } from './widevine-bridge.js';

class WidevineAdapter {
  constructor() {
    this.session = null;
    this.util = null;
    this.available = false;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return this.available;
    this.initialized = true;

    try {
      const sessionModule = await loadWidevineComponent('session');
      const utilModule = await loadWidevineComponent('util');

      if (sessionModule?.Session) {
        this.session = sessionModule.Session;
      }
      if (utilModule?.Util) {
        this.util = utilModule.Util;
      }

      this.available = !!(this.session || this.util);
      return this.available;
    } catch (error) {
      console.warn('[Widevine] Initialization failed:', error.message);
      this.available = false;
      return false;
    }
  }

  /**
   * Check if URL is DRM protected
   */
  isDrmProtected(url = '', contentType = '') {
    if (!url) return false;
    const urlStr = String(url).toLowerCase();
    const typeStr = String(contentType).toLowerCase();

    return (
      /widevine|fairplay|playready|encrypted/i.test(urlStr) ||
      /encrypted|drm/i.test(typeStr) ||
      /EXT-X-KEY:.*METHOD=(?!NONE)/i.test(url)
    );
  }

  /**
   * Attempt to handle DRM challenge
   */
  async handleDrmChallenge(url, licenseUrl = null) {
    if (!this.available || !this.session) return null;

    try {
      // Session creation attempt (placeholder for actual DRM handling)
      return {
        handled: true,
        sessionId: Math.random().toString(36).slice(2),
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.warn('[Widevine] Challenge handling failed:', error.message);
      return null;
    }
  }

  /**
   * Get Widevine status
   */
  getStatus() {
    return {
      available: this.available,
      initialized: this.initialized,
      hasSession: !!this.session,
      hasUtil: !!this.util,
      timestamp: new Date().toISOString()
    };
  }
}

export default new WidevineAdapter();
