// =====================================
// SUKEBEI AV SCRAPER LIBRARY
// Searches sukebei.nyaa.si RSS for AV content
// Category 2_2 = "Real Life / Videos"
// =====================================

const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

const MIRRORS = [
  (process.env.SUKEBEI_DOMAIN || "https://sukebei.nyaa.si").replace(/\/+$/, ""),
  "https://sukebei.nyaa.iss.one",
];

let currentMirrorIndex = 0;

function getNextMirror() {
  currentMirrorIndex = (currentMirrorIndex + 1) % MIRRORS.length;
  return MIRRORS[currentMirrorIndex];
}

// ---- In-memory cache ----
const searchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30; // 30 min

function setCache(key, data) {
  if (searchCache.size >= 500) searchCache.delete(searchCache.keys().next().value);
  searchCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

function getCache(key) {
  const item = searchCache.get(key);
  if (!item) return null;
  if (item.expiresAt < Date.now()) { searchCache.delete(key); return null; }
  return item.data;
}

// ---- Core search ----
async function searchSukebeiAV(query) {
  if (!query || query.trim().length < 2) return [];

  const cacheKey = query.trim().toLowerCase();
  const cached = getCache(cacheKey);
  if (cached) { console.log("[CACHE HIT]", cacheKey); return cached; }

  const PROXY_URL = process.env.PROXY_URL;
  const uniqueResults = new Map();

  let attempts = 0;
  let success = false;

  while (attempts < MIRRORS.length && !success) {
    const domain = MIRRORS[currentMirrorIndex];
    // c=2_2 = Real Life > Videos on sukebei, f=0 = no filter
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

      console.log(`[SUKEBEI] Fetching: ${rssUrl}`);
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
        const magnet = item["nyaa:magnetUrl"] || item["link"] || null;
        if (!hash || uniqueResults.has(hash)) continue;

        uniqueResults.set(hash, {
          title: item.title || "Unknown",
          hash,
          magnet: buildMagnet(hash, item.title),
          torrentUrl: item.link || "",
          seeders: parseInt(item["nyaa:seeders"], 10) || 0,
          leechers: parseInt(item["nyaa:leechers"], 10) || 0,
          size: item["nyaa:size"] || "Unknown",
        });
      }

      success = true;
    } catch (err) {
      console.warn(`[SUKEBEI] Mirror ${domain} failed: ${err.message}. Rotating...`);
      getNextMirror();
      attempts++;
    }
  }

  const results = Array.from(uniqueResults.values()).sort((a, b) => b.seeders - a.seeders);
  if (results.length > 0) setCache(cacheKey, results);
  return results;
}

function buildMagnet(hash, title) {
  const trackers = [
    "http://sukebei.tracker.wf:8888/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.torrent.eu.org:451/announce",
  ];
  const dn = encodeURIComponent(title || "");
  const trs = trackers.map(t => `&tr=${encodeURIComponent(t)}`).join("");
  return `magnet:?xt=urn:btih:${hash}&dn=${dn}${trs}`;
}

function extractResolution(title) {
  if (/(4320p|8k)/i.test(title)) return "8K";
  if (/(2160p|4k)/i.test(title)) return "4K";
  if (/(1440p)/i.test(title)) return "2K";
  if (/(1080p|FHD)/i.test(title)) return "1080p";
  if (/(720p|HD)/i.test(title)) return "720p";
  if (/(480p)/i.test(title)) return "480p";
  return "SD";
}

module.exports = { searchSukebeiAV, extractResolution };
