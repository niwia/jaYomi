// =====================================
// SUKEBEI AV — METADATA SCRAPER
// Waterfall: JavDB → JavBus → JavDatabase → DMM CDN poster
// Each source is tried in order; we stop at the first that gives us both
// a poster AND a title. Poster-only or title-only partial results are kept
// as fallbacks. The whole result is cached with a TTL.
// =====================================

const axios = require("axios");
const cheerio = require("cheerio");
const { logger } = require("./utils");

const TAG = "Metadata";

// ---- Cache with TTL ----
const metaCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CACHE = 500;

function getCache(key) {
    const item = metaCache.get(key);
    if (!item) return null;
    if (item.expiresAt < Date.now()) { metaCache.delete(key); return null; }
    return item.data;
}

function setCache(key, data) {
    if (metaCache.size >= MAX_CACHE) {
        metaCache.delete(metaCache.keys().next().value);
    }
    metaCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---- HTTP helper (short timeout, browser UA) ----
async function httpGet(url, timeoutMs = 5000) {
    return axios.get(url, {
        timeout: timeoutMs,
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
        },
    });
}

// ==================
// SOURCE 1: JavDB
// ==================
async function fromJavDB(avId) {
    try {
        // JavDB has a search endpoint
        const searchUrl = `https://javdb.com/search?q=${encodeURIComponent(avId)}&f=all`;
        const res = await httpGet(searchUrl, 5000);
        const $ = cheerio.load(res.data);

        // Find the first card matching the AV ID exactly
        let movieUrl = null;
        $(".item a.box").each((_, el) => {
            const uid = $(el).find(".uid").text().trim();
            if (uid.toUpperCase() === avId.toUpperCase()) {
                movieUrl = "https://javdb.com" + $(el).attr("href");
                return false; // break
            }
        });

        if (!movieUrl) return null;

        const detailRes = await httpGet(movieUrl, 5000);
        const $d = cheerio.load(detailRes.data);

        const poster = $d("img.video-cover").attr("src") || $d('meta[property="og:image"]').attr("content") || null;
        let title = $d('meta[property="og:title"]').attr("content") || $d("h2.title strong.current-title").first().text().trim() || null;
        if (title) title = title.replace(/\s*[-|]\s*JavDB.*/i, "").trim();

        let description = "";
        $d(".panel-block").each((_, el) => {
            const label = $d(el).find("strong").text().trim();
            const value = $d(el).find("span, a").map((_, v) => $d(v).text().trim()).get().join(", ").trim();
            if (label.includes("Actors") && value) description += `🎭 Cast: ${value}\n`;
            if (label.includes("Maker") && value) description += `🏢 Studio: ${value}\n`;
            if (label.includes("Released") && value) description += `📅 Released: ${value}\n`;
            if (label.includes("Director") && value) description += `🎬 Director: ${value}\n`;
        });

        if (!poster && !title) return null;
        logger.info(TAG, `JavDB hit for ${avId}`);
        return { poster, title, description: description.trim() };
    } catch (e) {
        logger.warn(TAG, `JavDB miss for ${avId}: ${e.message}`);
        return null;
    }
}

// ==================
// SOURCE 2: JavBus
// ==================
async function fromJavBus(avId) {
    try {
        const url = `https://www.javbus.com/${encodeURIComponent(avId)}`;
        const res = await httpGet(url, 5000);
        const $ = cheerio.load(res.data);

        const poster = $("a.bigImage img").attr("src") || null;
        let title = $("div.container h3").first().text().trim() || null;
        if (title) title = title.replace(avId, "").replace(/^\s*[-—]\s*/, "").trim() || title;

        let description = "";
        $(".col-md-3 .star-name a").each((_, el) => {
            const name = $(el).text().trim();
            if (name) description += (description ? ", " : "🎭 Cast: ") + name;
        });
        if (description) description += "\n";

        const studio = $("a[href*='/studio/']").first().text().trim();
        if (studio) description += `🏢 Studio: ${studio}\n`;

        const date = $("p:contains('Release Date:') span").first().text().trim() ||
            $("div.col-md-3 p").filter((_, el) => $(el).text().includes("發行日期") || $(el).text().includes("Release")).first().text().replace(/.*:\s*/, "").trim();
        if (date) description += `📅 Released: ${date}\n`;

        if (!poster && !title) return null;
        logger.info(TAG, `JavBus hit for ${avId}`);
        return { poster, title: title || null, description: description.trim() };
    } catch (e) {
        logger.warn(TAG, `JavBus miss for ${avId}: ${e.message}`);
        return null;
    }
}

// ==================
// SOURCE 3: JavDatabase
// ==================
async function fromJavDatabase(avId) {
    try {
        const url = `https://www.javdatabase.com/movies/${avId.toLowerCase()}/`;
        const res = await httpGet(url, 5000);
        const $ = cheerio.load(res.data);

        const poster = $('meta[property="og:image"]').attr("content") || null;
        let title = $('meta[property="og:title"]').attr("content") || $("title").text();
        if (title) title = title.replace(/\s*-\s*JAVDatabase\.com/i, "").trim();

        let description = "";
        $("p").each((_, el) => {
            const text = $(el).text();
            if (text.includes("Idol(s)/Actress(es):")) description += `🎭 Cast: ${text.split("Idol(s)/Actress(es):")[1]?.trim()}\n`;
            if (text.includes("Studio:")) description += `🏢 Studio: ${text.split("Studio:")[1]?.trim()}\n`;
            if (text.includes("Release Date:")) description += `📅 Released: ${text.split("Release Date:")[1]?.trim()}\n`;
        });

        if (!poster && !title) return null;
        logger.info(TAG, `JavDatabase hit for ${avId}`);
        return { poster, title: title || null, description: description.trim() };
    } catch (e) {
        logger.warn(TAG, `JavDatabase miss for ${avId}: ${e.message}`);
        return null;
    }
}

// ==================
// SOURCE 4: DMM CDN (poster only, no web request needed)
// ==================
async function fromDMM(avId) {
    try {
        const match = avId.match(/^([A-Za-z]+)-?(\d+)$/);
        if (!match) return null;
        const prefix = match[1].toLowerCase();
        const num = match[2].padStart(5, "0");
        const combined = prefix + num;
        const url = `https://pics.dmm.co.jp/digital/video/${combined}/${combined}pl.jpg`;

        // DMM returns 302 → "now printing" placeholder if not found
        const check = await axios.head(url, { maxRedirects: 0, timeout: 3000, validateStatus: s => s === 200 });
        if (check.status === 200) {
            logger.info(TAG, `DMM CDN poster found for ${avId}`);
            return { poster: url, title: null, description: "" };
        }
        return null;
    } catch {
        return null;
    }
}

// ==================
// MAIN ENTRY: Waterfall
// ==================
async function fetchMetadata(query) {
    if (!query) return null;

    const avIdMatch = query.match(/[A-Z]{2,8}-\d{2,6}/i);
    const id = avIdMatch ? avIdMatch[0].toUpperCase() : null;

    // For non-AV-ID queries (e.g. actress names) we skip metadata entirely
    if (!id) return null;

    const cached = getCache(id);
    if (cached !== null) return cached;

    let result = null;

    // Race all scrapers with a 6s global timeout
    const TIMEOUT = 6000;
    const withTimeout = (p) => Promise.race([p, new Promise(r => setTimeout(() => r(null), TIMEOUT))]);

    // Try sources in waterfall order, stop at first full result (poster + title)
    for (const source of [fromJavDB, fromJavBus, fromJavDatabase]) {
        const data = await withTimeout(source(id));
        if (data) {
            if (!result) result = data;
            else {
                // Merge: fill in missing fields from later sources
                if (!result.poster && data.poster) result.poster = data.poster;
                if (!result.title && data.title) result.title = data.title;
                if (!result.description && data.description) result.description = data.description;
            }
            // If we have both a poster and title, we're done
            if (result.poster && result.title) break;
        }
    }

    // Last resort: DMM poster only
    if (!result || !result.poster) {
        const dmm = await withTimeout(fromDMM(id));
        if (dmm) {
            if (!result) result = dmm;
            else if (!result.poster) result.poster = dmm.poster;
        }
    }

    // Attach the canonical ID
    if (result) result.id = id;

    // If we got nothing at all, cache null briefly to avoid re-hammering
    const cacheDuration = result ? CACHE_TTL_MS : 5 * 60 * 1000;
    const cacheItem = { data: result, expiresAt: Date.now() + cacheDuration };
    if (metaCache.size >= MAX_CACHE) metaCache.delete(metaCache.keys().next().value);
    metaCache.set(id, cacheItem);

    return result;
}

module.exports = { fetchMetadata };
