// =====================================
// SUKEBEI AV — STREMIO ADDON CORE
// Searches sukebei.nyaa.si (category 2_2: Real Life > Videos) for AV content.
// Supports Real-Debrid & Torbox via base64-encoded manifest URL config.
// Stateless — no database. API keys live only in the user's manifest URL.
// =====================================

const { addonBuilder } = require("stremio-addon-sdk");
const { searchSukebeiAV } = require("./lib/sukebei");
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require("./lib/debrid");
const { fetchMetadata } = require("./lib/metadata");
const { parseSizeToBytes, selectBestVideoFile, RES_ORDER, logger } = require("./lib/utils");

const TAG = "Addon";
let BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:7474").replace(/\/+$/, "");

// =====================================
// CONFIG HELPERS (base64url encode/decode)
// =====================================
function parseConfig(config) {
    let parsed = {};
    try {
        logger.info(TAG, "Raw config keys:", config ? Object.keys(config) : "null");

        if (config && config.AV) {
            let b64 = config.AV.replace(/-/g, "+").replace(/_/g, "/");
            while (b64.length % 4) b64 += "=";
            parsed = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
            logger.info(TAG, "Decoded config keys:", Object.keys(parsed));
        } else if (config && Object.keys(config).length > 0) {
            // SDK might pass config differently — try the first value as base64
            const firstKey = Object.keys(config)[0];
            const firstVal = config[firstKey];
            try {
                let b64 = String(firstVal).replace(/-/g, "+").replace(/_/g, "/");
                while (b64.length % 4) b64 += "=";
                const attempt = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
                if (attempt && (attempt.rdKey || attempt.tbKey)) {
                    parsed = attempt;
                    logger.info(TAG, "Fallback config decode worked:", Object.keys(parsed));
                } else {
                    parsed = config;
                }
            } catch {
                parsed = config;
            }
        } else {
            parsed = config || {};
        }
    } catch (e) {
        logger.error(TAG, "Config parse error:", e.message);
    }
    return parsed || {};
}

// =====================================
// MANIFEST
// =====================================
const manifest = {
    id: "community.sukebei.av",
    version: "1.1.0",
    name: "Sukebei AV",
    logo: BASE_URL + "/logo.png",
    description: "Stream AV content via Real-Debrid or Torbox. Searches sukebei.nyaa.si for AV IDs (DLDSS-485, SONE-001, etc). Zero server-side tracking.",
    types: ["movie"],
    resources: [
        { name: "stream", types: ["movie"], idPrefixes: ["av:"] },
        { name: "catalog", types: ["movie"] },
        { name: "meta", types: ["movie"], idPrefixes: ["av:"] },
    ],
    catalogs: [
        {
            type: "movie",
            id: "av_search",
            name: "Sukebei AV",
            extra: [{ name: "search", isRequired: true }],
        },
    ],
    config: [
        { key: "AV", type: "text", title: "AV Internal Payload", required: false },
    ],
    behaviorHints: {
        configurable: true,
        adult: true,
    },
};

const builder = new addonBuilder(manifest);

// =====================================
// HELPERS
// =====================================
function generatePoster(label) {
    return `https://dummyimage.com/300x450/1a1a1a/ff2d5e.png&text=${encodeURIComponent(label)}`;
}

// =====================================
// CATALOG HANDLER
// Metadata is fetched non-blocking with a timeout so catalog never stalls.
// =====================================
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (id !== "av_search" || !extra.search) return { metas: [] };

    const query = extra.search.trim();
    logger.info(TAG, `Catalog search: "${query}"`);

    const torrents = await searchSukebeiAV(query);
    if (!torrents.length) return { metas: [], cacheMaxAge: 60 };

    const avIdMatch = query.match(/[A-Z]{2,8}-\d{2,6}/i);
    const avId = avIdMatch ? avIdMatch[0].toUpperCase() : null;
    const label = avId || query;
    const encodedId = Buffer.from(query).toString("base64url");

    const firstTitle = torrents[0].title.replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim();
    let displayName = avId ? `${avId} — ${firstTitle}`.substring(0, 80) : firstTitle.substring(0, 80);
    let poster = generatePoster(label);
    let description = `${torrents.length} torrent(s) on sukebei.nyaa.si\n\n${torrents[0].title}`;

    // Fetch metadata with a hard 4s ceiling so we never stall the catalog response
    const metaTimeout = new Promise(r => setTimeout(() => r(null), 4000));
    const extMeta = await Promise.race([fetchMetadata(query), metaTimeout]);

    if (extMeta) {
        if (extMeta.title) displayName = `${extMeta.id || label} — ${extMeta.title}`.substring(0, 80);
        if (extMeta.poster) poster = extMeta.poster;
        if (extMeta.description) description = `${description}\n\n---\n\n${extMeta.description}`;
    }

    return {
        metas: [{
            id: "av:" + encodedId,
            type: "movie",
            name: displayName,
            poster,
            posterShape: "poster",
            description,
            genres: ["Adult"],
        }],
        cacheMaxAge: 3600,
    };
});

// =====================================
// META HANDLER
// =====================================
builder.defineMetaHandler(async ({ type, id }) => {
    if (!id.startsWith("av:")) return { meta: null };

    const query = Buffer.from(id.slice(3), "base64url").toString("utf8");
    const avIdMatch = query.match(/[A-Z]{2,8}-\d{2,6}/i);
    const avId = avIdMatch ? avIdMatch[0].toUpperCase() : null;
    const label = avId || query;

    const [torrents, extMeta] = await Promise.all([
        searchSukebeiAV(query),
        fetchMetadata(query),
    ]);

    const firstTitle = torrents.length
        ? torrents[0].title.replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim()
        : query;

    let displayName = avId ? `${avId} — ${firstTitle}`.substring(0, 80) : firstTitle.substring(0, 80);
    let poster = generatePoster(label);
    let description = `${torrents.length} torrent(s) found on sukebei.nyaa.si.\nSearch: ${query}\n\n${firstTitle}`;

    if (extMeta) {
        if (extMeta.title) displayName = `${extMeta.id || label} — ${extMeta.title}`.substring(0, 80);
        if (extMeta.poster) poster = extMeta.poster;
        if (extMeta.description) description = `${description}\n\n---\n\n${extMeta.description}`;
    }

    return {
        meta: {
            id,
            type: "movie",
            name: displayName,
            poster,
            posterShape: "poster",
            description,
            genres: ["Adult", "AV"],
        },
        cacheMaxAge: 3600,
    };
});

// =====================================
// STREAM HANDLER (SDK — fallback, rarely used due to custom Express route)
// =====================================
builder.defineStreamHandler(async ({ type, id, config }) => {
    if (!id.startsWith("av:")) return { streams: [] };

    const userConfig = parseConfig(config);
    const hasTB = !!userConfig.tbKey;
    const hasRD = !!userConfig.rdKey;
    logger.info(TAG, `Stream request — hasRD:${hasRD} hasTB:${hasTB} id:${id.substring(0, 20)}`);

    if (!hasRD && !hasTB) {
        return {
            streams: [{
                name: "⚙️ Setup Required",
                description: `Visit ${BASE_URL}\nEnter your Torbox or RD API key and reinstall the generated manifest URL.`,
                externalUrl: BASE_URL,
            }],
            cacheMaxAge: 60,
        };
    }

    return buildDebridStreams(id, userConfig);
});

// =====================================
// SHARED STREAM BUILDER (used by both SDK handler and custom Express route)
// =====================================
async function buildDebridStreams(id, userConfig) {
    const query = Buffer.from(id.slice(3), "base64url").toString("utf8");
    logger.info(TAG, `Building debrid streams for: "${query}"`);

    const torrents = await searchSukebeiAV(query);
    if (!torrents.length) return { streams: [], cacheMaxAge: 60 };

    const hashes = torrents.map(t => t.hash);

    const [rdC, tbC, rdA, tbA] = await Promise.all([
        userConfig.rdKey ? checkRD(hashes, userConfig.rdKey).catch(() => ({})) : Promise.resolve({}),
        userConfig.tbKey ? checkTorbox(hashes, userConfig.tbKey).catch(() => ({})) : Promise.resolve({}),
        userConfig.rdKey ? getActiveRD(userConfig.rdKey).catch(() => ({})) : Promise.resolve({}),
        userConfig.tbKey ? getActiveTorbox(userConfig.tbKey).catch(() => ({})) : Promise.resolve({}),
    ]);

    const streams = [];

    torrents.forEach(t => {
        const hashLow = t.hash.toLowerCase();
        const res = t.resolution || "SD"; // pre-computed in sukebei.js
        const sizeBytes = parseSizeToBytes(t.size);
        const deadTag = t.isDead ? " ☠️" : "";

        if (userConfig.rdKey) {
            const filesRD = rdC[hashLow];
            const progRD = rdA[hashLow];
            const isCached = !!(filesRD && filesRD.length > 0) || progRD === 100;
            const isDownloading = progRD !== undefined && progRD < 100 && progRD > 0;

            let uiName = `AV [☁️ RD]\n🎥 ${res}${deadTag}`;
            let statusLine = "☁️ Download";
            if (isCached)      { uiName = `AV [⚡ RD]\n🎥 ${res}${deadTag}`; statusLine = "⚡ Cached"; }
            else if (isDownloading) { uiName = `AV [⏳ ${progRD}% RD]\n🎥 ${res}${deadTag}`; statusLine = `⏳ ${progRD}%`; }

            streams.push({
                name: uiName,
                description: `🌸 Sukebei | ${statusLine}\n📄 ${t.title}\n💾 ${t.size} | 🌱 ${t.seeders} seeders`,
                url: `${BASE_URL}/resolve/realdebrid/${userConfig.rdKey}/${t.hash}/1`,
                behaviorHints: {
                    bingeGroup: (isCached ? "av_rd_" : "av_uncached_rd_") + t.hash,
                    notWebReady: !isCached,
                },
                _bytes: sizeBytes, _isCached: isCached, _prog: progRD || 0, _res: res, _dead: t.isDead,
            });
        }

        if (userConfig.tbKey) {
            const filesTB = tbC[hashLow];
            const progTB = tbA[hashLow];
            const isCached = !!(filesTB && filesTB.length > 0) || progTB === 100;
            const isDownloading = progTB !== undefined && progTB < 100 && progTB > 0;

            let uiName = `AV [☁️ TB]\n🎥 ${res}${deadTag}`;
            let statusLine = "☁️ Download";
            if (isCached)      { uiName = `AV [⚡ TB]\n🎥 ${res}${deadTag}`; statusLine = "⚡ Cached"; }
            else if (isDownloading) { uiName = `AV [⏳ ${progTB}% TB]\n🎥 ${res}${deadTag}`; statusLine = `⏳ ${progTB}%`; }

            streams.push({
                name: uiName,
                description: `🌸 Sukebei | ${statusLine}\n📄 ${t.title}\n💾 ${t.size} | 🌱 ${t.seeders} seeders`,
                url: `${BASE_URL}/resolve/torbox/${userConfig.tbKey}/${t.hash}/1`,
                behaviorHints: {
                    bingeGroup: (isCached ? "av_tb_" : "av_uncached_tb_") + t.hash,
                    notWebReady: !isCached,
                },
                _bytes: sizeBytes, _isCached: isCached, _prog: progTB || 0, _res: res, _dead: t.isDead,
            });
        }
    });

    const sorted = streams.sort((a, b) => {
        // Cached > downloading > dead
        if (a._isCached !== b._isCached) return b._isCached ? 1 : -1;
        if (a._prog > 0 && b._prog === 0) return -1;
        if (b._prog > 0 && a._prog === 0) return 1;
        if (a._dead && !b._dead) return 1;
        if (!a._dead && b._dead) return -1;
        // Higher resolution first
        const rDiff = (RES_ORDER[b._res] || 0) - (RES_ORDER[a._res] || 0);
        if (rDiff !== 0) return rDiff;
        // Larger file first
        return b._bytes - a._bytes;
    });

    logger.info(TAG, `Returning ${sorted.length} streams`);
    return { streams: sorted, cacheMaxAge: 3600 };
}

module.exports = { addonInterface: builder.getInterface(), manifest, parseConfig, buildDebridStreams };
