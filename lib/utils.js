// =====================================
// SUKEBEI AV — SHARED UTILITIES
// Eliminates duplication between server.js and addon.js
// =====================================

/**
 * Parse a human-readable size string (e.g. "1.4 GiB") into bytes.
 */
function parseSizeToBytes(sizeStr) {
    if (!sizeStr || typeof sizeStr !== "string") return 0;
    const m = sizeStr.match(/([\d.]+)\s*(GB|MB|KB|GiB|MiB|KiB|B)/i);
    if (!m) return 0;
    const val = parseFloat(m[1]);
    const unit = m[2].toUpperCase();
    if (unit.includes("G")) return val * 1024 ** 3;
    if (unit.includes("M")) return val * 1024 ** 2;
    if (unit.includes("K")) return val * 1024;
    return val;
}

/**
 * Pick the largest video file from a list, skipping tiny preview/spam files.
 */
function selectBestVideoFile(files) {
    if (!files || files.length === 0) return null;
    const MIN_SIZE = 50 * 1024 * 1024; // 50 MB
    const videoFiles = files
        .filter(f => /\.(mkv|mp4|avi|wmv|flv|m4v|ts|mov|webm)$/i.test(f.path || f.name || ""))
        .filter(f => (f.size || 0) > MIN_SIZE);
    if (videoFiles.length === 0) return null;
    return videoFiles.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
}

/**
 * Extract a human-readable resolution label from a torrent title.
 * Checks explicit pixel counts before falling back to generic terms.
 */
function extractResolution(title) {
    if (!title) return "SD";
    if (/(4320p|8k)/i.test(title)) return "8K";
    if (/(2160p|4k)/i.test(title)) return "4K";
    if (/(1440p)/i.test(title)) return "2K";
    if (/(1080p|FHD)/i.test(title)) return "1080p";
    if (/(720p)/i.test(title)) return "720p"; // removed generic "HD" — too ambiguous
    if (/(480p)/i.test(title)) return "480p";
    return "SD";
}

/** Resolution sort order for stream sorting. */
const RES_ORDER = { "8K": 8000, "4K": 4000, "2K": 2000, "1080p": 1080, "720p": 720, "480p": 480, "SD": 0 };

/**
 * Simple structured logger with timestamps.
 */
const logger = {
    info:  (tag, msg, ...args) => console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`, ...args),
    warn:  (tag, msg, ...args) => console.warn(`[${new Date().toISOString()}] [${tag}] ⚠️  ${msg}`, ...args),
    error: (tag, msg, ...args) => console.error(`[${new Date().toISOString()}] [${tag}] ❌ ${msg}`, ...args),
};

module.exports = { parseSizeToBytes, selectBestVideoFile, extractResolution, RES_ORDER, logger };
