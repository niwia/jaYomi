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

// Generate DMM poster URL (often reliable as a fallback tall crop)
function getDmmPosterUrl(avId) {
    const match = avId.match(/^([A-Za-z]+)-?(\d+)$/);
    if (!match) return null;
    const prefix = match[1].toLowerCase();
    const num = match[2].padStart(5, "0");
    const combined = prefix + num;
    return `https://pics.dmm.co.jp/digital/video/${combined}/${combined}pl.jpg`;
}

// ==================
// SOURCE 1: JavDB
// ==================
async function fromJavDB(avId) {
    try {
        const searchUrl = `https://javdb.com/search?q=${encodeURIComponent(avId)}&f=all`;
        const res = await httpGet(searchUrl, 5000);
        const $ = cheerio.load(res.data);

        let movieUrl = null;
        $(".item a.box").each((_, el) => {
            const uid = $(el).find(".uid").text().trim();
            if (uid.toUpperCase() === avId.toUpperCase()) {
                movieUrl = "https://javdb.com" + $(el).attr("href");
                return false;
            }
        });

        if (!movieUrl) return null;

        const detailRes = await httpGet(movieUrl, 5000);
        const $d = cheerio.load(detailRes.data);

        // JavDB usually provides the wide cover as the main image
        const background = $d("img.video-cover").attr("src") || $d('meta[property="og:image"]').attr("content") || null;
        // The tall poster crop can sometimes be built, but we will rely on DMM fallback for poster if we only have background
        const poster = getDmmPosterUrl(avId) || background;

        let title = $d('meta[property="og:title"]').attr("content") || $d("h2.title strong.current-title").first().text().trim() || null;
        if (title) title = title.replace(/\s*[-|]\s*JavDB.*/i, "").trim();

        let description = "";
        let cast = [];
        let director = [];
        let year = "";

        $d(".panel-block").each((_, el) => {
            const label = $d(el).find("strong").text().trim();
            const value = $d(el).find("span, a").map((_, v) => $d(v).text().trim()).get().join(", ").trim();
            
            if (label.includes("Actors") && value) {
                cast = value.split(",").map(s => s.trim());
                description += `🎭 Cast: ${value}\n`;
            }
            if (label.includes("Maker") && value) description += `🏢 Studio: ${value}\n`;
            if (label.includes("Released") && value) {
                year = value.split("-")[0];
                description += `📅 Released: ${value}\n`;
            }
            if (label.includes("Director") && value) {
                director.push(value);
                description += `🎬 Director: ${value}\n`;
            }
        });

        if (!background && !title) return null;
        logger.info(TAG, `JavDB hit for ${avId}`);
        return { poster, background, title, description: description.trim(), cast, director, year };
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

        const background = $("a.bigImage img").attr("src") || null;
        const poster = getDmmPosterUrl(avId) || background;

        let title = $("div.container h3").first().text().trim() || null;
        if (title) title = title.replace(avId, "").replace(/^\s*[-—]\s*/, "").trim() || title;

        let description = "";
        let cast = [];
        let director = [];
        let year = "";

        $(".col-md-3 .star-name a").each((_, el) => {
            const name = $(el).text().trim();
            if (name) cast.push(name);
        });
        if (cast.length > 0) description += `🎭 Cast: ${cast.join(", ")}\n`;

        const studio = $("a[href*='/studio/']").first().text().trim();
        if (studio) description += `🏢 Studio: ${studio}\n`;

        const date = $("p:contains('Release Date:') span").first().text().trim() ||
            $("div.col-md-3 p").filter((_, el) => $(el).text().includes("發行日期") || $(el).text().includes("Release")).first().text().replace(/.*:\s*/, "").trim();
        if (date) {
            year = date.split("-")[0];
            description += `📅 Released: ${date}\n`;
        }
        
        const dir = $("p:contains('Director:') a").first().text().trim();
        if (dir) {
            director.push(dir);
            description += `🎬 Director: ${dir}\n`;
        }

        if (!background && !title) return null;
        logger.info(TAG, `JavBus hit for ${avId}`);
        return { poster, background, title: title || null, description: description.trim(), cast, director, year };
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

        const background = $('meta[property="og:image"]').attr("content") || null;
        const poster = getDmmPosterUrl(avId) || background;
        
        let title = $('meta[property="og:title"]').attr("content") || $("title").text();
        if (title) title = title.replace(/\s*-\s*JAVDatabase\.com/i, "").trim();

        let description = "";
        let cast = [];
        let year = "";

        $("p").each((_, el) => {
            const text = $(el).text();
            if (text.includes("Idol(s)/Actress(es):")) {
                const parts = text.split("Idol(s)/Actress(es):")[1]?.trim();
                if (parts) {
                    cast = parts.split(",").map(c => c.trim());
                    description += `🎭 Cast: ${parts}\n`;
                }
            }
            if (text.includes("Studio:")) description += `🏢 Studio: ${text.split("Studio:")[1]?.trim()}\n`;
            if (text.includes("Release Date:")) {
                const date = text.split("Release Date:")[1]?.trim();
                if (date) {
                    year = date.split("-")[0];
                    description += `📅 Released: ${date}\n`;
                }
            }
        });

        if (!background && !title) return null;
        logger.info(TAG, `JavDatabase hit for ${avId}`);
        return { poster, background, title: title || null, description: description.trim(), cast, director: [], year };
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
        const url = getDmmPosterUrl(avId);
        if (!url) return null;

        // DMM returns 302 → "now printing" placeholder if not found
        const check = await axios.head(url, { maxRedirects: 0, timeout: 3000, validateStatus: s => s === 200 });
        if (check.status === 200) {
            logger.info(TAG, `DMM CDN poster found for ${avId}`);
            // Provide both so it fills stremio's UI without breaking
            return { poster: url, background: url, title: null, description: "", cast: [], director: [], year: "" };
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
                if (!result.background && data.background) result.background = data.background;
                if (!result.title && data.title) result.title = data.title;
                if (!result.description && data.description) result.description = data.description;
                if (!result.year && data.year) result.year = data.year;
                if ((!result.cast || result.cast.length === 0) && data.cast) result.cast = data.cast;
                if ((!result.director || result.director.length === 0) && data.director) result.director = data.director;
            }
            // If we have both a background and title, we're done
            if (result.background && result.title) break;
        }
    }

    // Last resort: DMM poster only
    if (!result || !result.poster) {
        const dmm = await withTimeout(fromDMM(id));
        if (dmm) {
            if (!result) result = dmm;
            else {
                if (!result.poster) result.poster = dmm.poster;
                if (!result.background) result.background = dmm.background;
            }
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
