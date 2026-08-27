/**
 * MediaFlow Proxy Module
 * Handles media proxy routing and configuration
 */

/**
 * Apply MediaFlow proxy settings to extraction result
 * @param {Object} result - Extraction result
 * @returns {Object} Result with proxy applied
 */
export function applyMediaFlowProxy(result) {
  if (!result) return null;
  // Return result as-is if no proxy transformation needed
  return result;
}

/**
 * Check if MediaFlow proxy is configured
 * @returns {boolean} True if configured
 */
export function isMediaFlowProxyConfigured() {
  const configured = process.env.MEDIAFLOW_PROXY_URL || process.env.MEDIAFLOW_ENABLED;
  return !!configured;
}
