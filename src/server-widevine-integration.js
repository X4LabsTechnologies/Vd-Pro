/**
 * Server-level Widevine Integration
 * Initializes Widevine adapter on startup
 */

import WidevineAdapter from './widevine-adapter.js';

export async function initializeWidevineOnStartup(logger) {
  try {
    const available = await WidevineAdapter.initialize();
    const status = WidevineAdapter.getStatus();
    
    if (available) {
      logger.info(status, 'WidevineProxy2 bridge initialized successfully');
    } else {
      logger.warn(status, 'WidevineProxy2 bridge not available (optional)');
    }
    
    return status;
  } catch (error) {
    logger.warn({ error: error.message }, 'WidevineProxy2 initialization error (non-fatal)');
    return { available: false, error: error.message };
  }
}

export { WidevineAdapter };
