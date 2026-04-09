// =====================================
// SUKEBEI AV SCRAPER LIBRARY
// Searches sukebei.nyaa.si RSS for AV content
// Category 2_2 = "Real Life / Videos"
// =====================================

const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");
const { extractResolution, logger } = require("./utils");

const TAG = "Sukebei";

const MIRRORS = [
    (process.env.SUKEBEI_DOMAIN || "https://sukebei.nyaa.si").replace(/\/+$/, ""),
    "https://sukebei.nyaa.iss.one",
];

let currentMirrorIndex = 0;

function getNextMirror() {
    currentMirrorIndex = (currentMirrorIndex + 1) % MIRRORS.length;
    return MIRRORS[currentMirrorIndex];
}

// ---- In-memory LRU cache with TTL ----
const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30; // 30 min
const MAX_CACHE = 500;

function setCache(key, data) {
    if (searchCache.size >= MAX_CACHE) searchCache.delete(searchCache.keys().next().value);
    searchCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

function getCache(key) {
    const item = searchCache.get(key);
    if (!item) return null;
    if (item.expiresAt < Date.now()) { searchCache.delete(key); return null; }
    return item.data;
}

const TRACKERS = [
    "http://sukebei.tracker.wf:8888/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.torrent.eu.org:451/announce",
];

function buildMagnet(hash, title) {
    const dn = encodeURIComponent(title || "");
    const trs = TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join("");
    return `magnet:?xt=urn:btih:${hash}&dn=${dn}${trs}`;
}

// ---- Core search ----
async function searchSukebeiAV(query) {
    if (!query || query.trim().length < 2) return [];

    const cacheKey = query.trim().toLowerCase();
    const cached = getCache(cacheKey);
    if (cached) { logger.info(TAG, `Cache hit: "${cacheKey}"`); return cached; }

    const PROXY_URL = process.env.PROXY_URL;
    const uniqueResults = new Map();

    let attempts = 0;
    let success = false;

    while (attempts < MIRRORS.length && !success) {
        const domain = MIRRORS[currentMirrorIndex];
        const rssUrl = `${domain}/?page=rss&c=2_2&f=0&q=${encodeURIComponent(query.trim())}`;

        try {
            const config = {
                timeout: 12000,
                decompress: true,
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.5",
                    "Accept-Encoding": "gzip, deflate, br",
                    "Connection": "keep-alive",
                },
            };

            if (PROXY_URL) {
                const { HttpsProxyAgent } = require("https-proxy-agent");
                config.httpsAgent = new HttpsProxyAgent(PROXY_URL);
            }

            logger.info(TAG, `Fetching: ${rssUrl}`);
            const response = await axios.get(rssUrl, config);

            if (typeof response.data === "string" && response.data.trim().startsWith("<!DOCTYPE html>")) {
                throw new Error("Cloudflare/HTML block received instead of RSS.");
            }

            const parser = new XMLParser({ ignoreAttributes: true });
            const parsed = parser.parse(response.data);
            const items = parsed?.rss?.channel?.item
                ? Array.isArray(parsed.rss.channel.item)
                    ? parsed.rss.channel.item
                    : [parsed.rss.channel.item]
                : [];

            for (const item of items) {
                const hash = item["nyaa:infoHash"] ? item["nyaa:infoHash"].toLowerCase() : null;
                if (!hash || uniqueResults.has(hash)) continue;

                const seeders = parseInt(item["nyaa:seeders"], 10) || 0;

                uniqueResults.set(hash, {
                    title: item.title || "Unknown",
                    hash,
                    magnet: buildMagnet(hash, item.title),
                    torrentUrl: item.link || "",
                    seeders,
                    leechers: parseInt(item["nyaa:leechers"], 10) || 0,
                    size: item["nyaa:size"] || "Unknown",
                    resolution: extractResolution(item.title || ""),
                    isDead: seeders === 0,
                });
            }

            success = true;
            logger.info(TAG, `Got ${uniqueResults.size} results for "${query}"`);
        } catch (err) {
            logger.warn(TAG, `Mirror ${domain} failed: ${err.message}. Rotating...`);
            getNextMirror();
            attempts++;
        }
    }

    const results = Array.from(uniqueResults.values())
        .sort((a, b) => b.seeders - a.seeders);

    if (results.length > 0) setCache(cacheKey, results);
    return results;
}

module.exports = { searchSukebeiAV, extractResolution };
