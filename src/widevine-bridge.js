/**
 * WidevineProxy2 Integration Bridge
 * Connects WidevineProxy2 module to Vd-Pro without modifying core functionality
 * All imports are lazy-loaded and optional
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIDEVINE_MODULE_PATH = path.join(__dirname, '..', 'widevine-proxy');

/**
 * Load WidevineProxy2 module
 * Returns null if module is not available
 */
export async function loadWidevineProxy() {
  try {
    // Attempt to import the main widevine module
    const widevineModule = await import(
      path.join(WIDEVINE_MODULE_PATH, 'src', 'library', 'main.js')
    );
    return widevineModule;
  } catch (error) {
    console.warn('WidevineProxy2 module not available:', error.message);
    return null;
  }
}

/**
 * Load specific WidevineProxy2 component
 * @param {string} component - Component name (session, util, cmac, etc.)
 */
export async function loadWidevineComponent(component) {
  try {
    const componentPath = path.join(
      WIDEVINE_MODULE_PATH,
      'src',
      'library',
      'main',
      `${component}.js`
    );
    return await import(componentPath);
  } catch (error) {
    console.warn(
      `WidevineProxy2 component '${component}' not available:`,
      error.message
    );
    return null;
  }
}

/**
 * Check if WidevineProxy2 is properly installed
 */
export function isWidevineAvailable() {
  try {
    const fs = await import('fs');
    return fs.existsSync(WIDEVINE_MODULE_PATH);
  } catch {
    return false;
  }
}

export { WIDEVINE_MODULE_PATH };
