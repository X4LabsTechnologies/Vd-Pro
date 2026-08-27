# WidevineProxy2 Integration Guide

## Overview
Vd-Pro is now connected to WidevineProxy2 project as an optional module.

## Connection Architecture

```
Vd-Pro (Main Application)
    ↓
    └─→ widevine-bridge.js (Lazy loader)
            ↓
            └─→ widevine-proxy/ (Git Submodule)
                    ↓
                    └─→ WidevineProxy2 Components
                            ├─ Session Handler
                            ├─ Utilities
                            └─ CMAC Encryption
```

## Files Added

### 1. `.gitmodules`
- Registers WidevineProxy2 as a Git submodule
- URL: `https://github.com/DevLARLEY/WidevineProxy2.git`

### 2. `src/widevine-bridge.js`
- **Purpose**: Lazy-loads WidevineProxy2 components
- **Functions**:
  - `loadWidevineProxy()` - Load main module
  - `loadWidevineComponent(name)` - Load specific component
  - `isWidevineAvailable()` - Check availability
- **Key Feature**: Fails gracefully if module not found

### 3. `src/widevine-integration.js`
- **Purpose**: High-level Widevine integration interface
- **Class**: `WidevineIntegration`
- **Methods**:
  - `initialize()` - Initialize all components
  - `suspectWidevine(url)` - Check if URL needs Widevine
  - `getSession()` - Get Widevine session
  - `getUtil()` - Get Widevine utilities
  - `getStatus()` - Get integration status

### 4. `src/fallback-extractor.js`
- **Purpose**: Fallback extraction with optional Widevine support
- **Function**: `runFallbackExtraction(options)`
- **Status**: Placeholder ready for Widevine integration

### 5. `src/mediaflow-proxy.js`
- **Purpose**: Media proxy configuration
- **Functions**:
  - `applyMediaFlowProxy(result)` - Apply proxy settings
  - `isMediaFlowProxyConfigured()` - Check configuration

## Installation

### Step 1: Initialize Submodule
```bash
git submodule update --init --recursive
```

### Step 2: Install Submodule Dependencies
```bash
cd widevine-proxy
npm install
cd ..
```

### Step 3: Verify Connection
The integration automatically checks for module availability on startup.

## Usage in server.js

### Optional: Add Widevine Integration

You can add this to server.js initialization (without modifying existing code):

```javascript
import WidevineIntegration from './src/widevine-integration.js';

// Optional: Initialize Widevine integration
const widevineIntegration = new WidevineIntegration();
if (isMediaFlowProxyConfigured()) {
  await widevineIntegration.initialize();
  logger.info('Widevine integration status:', widevineIntegration.getStatus());
}
```

## DRM Detection Enhancement

When a DRM-protected URL is detected:

1. **Current Behavior**: Reports error code `DRM_PROTECTED`
2. **With Widevine Bridge**: Can optionally attempt session handling
3. **Non-Breaking**: If Widevine module unavailable, falls back to current behavior

## Status and Configuration

### Check Widevine Availability
```javascript
const status = widevineIntegration.getStatus();
console.log(status);
// Output:
// {
//   available: true,
//   hasSession: true,
//   hasUtil: true,
//   timestamp: "2026-08-27T..."
// }
```

## Important Notes

✅ **No Changes to Vd-Pro Core**
- server.js remains unmodified
- All extraction logic unchanged
- All endpoints unchanged
- All dependencies unchanged

✅ **Optional Integration**
- Widevine module is optional
- Works with or without submodule
- Graceful fallback if unavailable
- No impact on existing functionality

✅ **Safe Integration**
- Error handling on all imports
- Try-catch wrapped operations
- Logging for debugging
- No breaking changes

## Next Steps

1. Merge this branch to main
2. Initialize the submodule: `git submodule update --init --recursive`
3. Install submodule dependencies: `cd widevine-proxy && npm install`
4. Test extraction endpoints - everything works as before
5. Optional: Use Widevine components in error handlers

## Troubleshooting

### Submodule not updating?
```bash
git submodule update --init --recursive --force
```

### Widevine module import fails?
- Check: `ls widevine-proxy/src/library/main.js`
- Check: `cd widevine-proxy && npm ls`
- Integration automatically handles missing module

### Want to remove integration?
```bash
git submodule deinit -f widevine-proxy
git rm --cached widevine-proxy
rm -rf widevine-proxy
```

## Support

- WidevineProxy2: https://github.com/DevLARLEY/WidevineProxy2
- Vd-Pro: https://github.com/X4LabsTechnologies/Vd-Pro
