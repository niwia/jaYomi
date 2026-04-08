//===============
// SUKEBEI AV — STREMIO ADDON CORE
// Searches sukebei.nyaa.si (category 2_2: Real Life > Videos) for AV content.
// Supports Real-Debrid & Torbox via base64-encoded manifest URL config.
// Stateless — no database. API keys live only in the user's manifest URL.
//===============

const { addonBuilder } = require("stremio-addon-sdk");
const { searchSukebeiAV, extractResolution } = require("./lib/sukebei");
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require("./lib/debrid");

let BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:7474").replace(/\/+$/, "");

//===============
// CONFIG HELPERS (base64url encode/decode — same as Yomi)
//===============
function parseConfig(config) {
    let parsed = {};
    try {
        // Log raw config keys so we can see what the SDK is passing
        console.log("[Config] Raw keys:", config ? Object.keys(config) : "null");

        if (config && config.AV) {
            let b64 = config.AV.replace(/-/g, "+").replace(/_/g, "/");
            while (b64.length % 4) b64 += "=";
            parsed = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
            console.log("[Config] Decoded keys:", Object.keys(parsed));
        } else if (config && Object.keys(config).length > 0) {
            // SDK might pass config differently — try the first value as base64
            const firstKey = Object.keys(config)[0];
            const firstVal = config[firstKey];
            console.log("[Config] Trying first key:", firstKey, "val[:20]:", String(firstVal).substring(0, 20));
            try {
                let b64 = String(firstVal).replace(/-/g, "+").replace(/_/g, "/");
                while (b64.length % 4) b64 += "=";
                const attempt = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
                if (attempt && (attempt.rdKey || attempt.tbKey)) {
                    parsed = attempt;
                    console.log("[Config] Fallback decode worked! Keys:", Object.keys(parsed));
                } else {
                    parsed = config;
                }
            } catch (_) {
                parsed = config;
            }
        } else {
            parsed = config || {};
        }
    } catch (e) {
        console.error("[Config] Parse error:", e.message);
    }
    return parsed || {};
}

//===============
// MANIFEST
//===============
const manifest = {
    id: "community.sukebei.av",
    version: "1.0.0",
    name: "Sukebei AV",
    logo: BASE_URL + "/logo.png",
    description: "Stream AV content via Real-Debrid or Torbox. Searches sukebei.nyaa.si for AV IDs (DLDSS-485, SONE-001, etc). Zero server-side tracking.",
    types: ["movie"],
    resources: [
        {
            name: "stream",
            types: ["movie"],
            idPrefixes: ["av:"],
        },
        { name: "catalog", types: ["movie"] },
        {
            name: "meta",
            types: ["movie"],
            idPrefixes: ["av:"],
        },
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

//===============
// HELPERS
//===============
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

function selectBestVideoFile(files) {
    if (!files || files.length === 0) return null;
    const MIN_SIZE = 50 * 1024 * 1024; // 50 MB — skip preview/spam files
    const videoFiles = files
        .filter(f => /\.(mkv|mp4|avi|wmv|flv|m4v|ts|mov|webm)$/i.test(f.name || f.path || ""))
        .filter(f => (f.size || 0) > MIN_SIZE); // ignore tiny preview files
    if (videoFiles.length === 0) return null;
    // Pick the largest — that's always the full AV content
    return videoFiles.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
}

function generatePoster(label) {
    return `https://dummyimage.com/300x450/1a1a1a/ff2d5e.png&text=${encodeURIComponent(label)}`;
}

//===============
// CATALOG
//===============
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (id !== "av_search" || !extra.search) return { metas: [] };

    const query = extra.search.trim();
    console.log("[Catalog] Search:", query);

    const torrents = await searchSukebeiAV(query);
    if (!torrents.length) return { metas: [], cacheMaxAge: 60 };

    const avIdMatch = query.match(/[A-Z]{2,8}-\d{2,6}/i);
    const avId = avIdMatch ? avIdMatch[0].toUpperCase() : null;
    const label = avId || query;
    const encodedId = Buffer.from(query).toString("base64url");

    const firstTitle = torrents[0].title.replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim();
    const displayName = avId ? `${avId} — ${firstTitle}`.substring(0, 80) : firstTitle.substring(0, 80);

    return {
        metas: [{
            id: "av:" + encodedId,
            type: "movie",
            name: displayName,
            poster: generatePoster(label),
            posterShape: "poster",
            description: `${torrents.length} torrent(s) on sukebei.nyaa.si\n\n${torrents[0].title}`,
            genres: ["Adult"],
        }],
        cacheMaxAge: 3600,
    };
});

//===============
// META
//===============
builder.defineMetaHandler(async ({ type, id }) => {
    if (!id.startsWith("av:")) return { meta: null };

    const query = Buffer.from(id.slice(3), "base64url").toString("utf8");
    const avIdMatch = query.match(/[A-Z]{2,8}-\d{2,6}/i);
    const avId = avIdMatch ? avIdMatch[0].toUpperCase() : null;
    const label = avId || query;

    const torrents = await searchSukebeiAV(query);
    const firstTitle = torrents.length
        ? torrents[0].title.replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim()
        : query;
    const displayName = avId ? `${avId} — ${firstTitle}`.substring(0, 80) : firstTitle.substring(0, 80);

    return {
        meta: {
            id,
            type: "movie",
            name: displayName,
            poster: generatePoster(label),
            posterShape: "poster",
            description: `${torrents.length} torrent(s) found on sukebei.nyaa.si.\nSearch: ${query}\n\n${firstTitle}`,
            genres: ["Adult", "AV"],
        },
        cacheMaxAge: 3600,
    };
});

//===============
// STREAM
//===============
builder.defineStreamHandler(async ({ type, id, config }) => {
    if (!id.startsWith("av:")) return { streams: [] };

    console.log("[Stream] Request for:", id.substring(0, 20));
    const userConfig = parseConfig(config);
    const hasTB = !!userConfig.tbKey;
    const hasRD = !!userConfig.rdKey;
    console.log("[Stream] Config — hasTorbox:", hasTB, "hasRD:", hasRD);

    if (!hasRD && !hasTB) {
        console.log("[Stream] No debrid keys — returning setup instructions");
        return {
            streams: [{
                name: "⚙️ Setup Required",
                description: "Visit your jaYomi configure page, enter your Torbox or RD key, then REINSTALL the generated manifest URL in Stremio.\n\nhttps://jayomi.onrender.com",
                externalUrl: "https://jayomi.onrender.com",
            }],
            cacheMaxAge: 60,
        };
    }

    return await buildDebridStreams(id, userConfig);
});

async function buildRawStreams(id) {
    const query = Buffer.from(id.slice(3), "base64url").toString("utf8");
    const torrents = await searchSukebeiAV(query);
    if (!torrents.length) return { streams: [], cacheMaxAge: 60 };

    const streams = torrents.slice(0, 15).map(t => {
        const res = extractResolution(t.title);
        return {
            name: `🌸 Sukebei\n🎥 ${res}`,
            description: `📄 ${t.title}\n💾 ${t.size} | 🌱 ${t.seeders} seeders`,
            infoHash: t.hash,
            sources: [t.magnet],
            behaviorHints: { bingeGroup: "av_raw_" + t.hash },
        };
    });

    return { streams, cacheMaxAge: 3600 };
}

async function buildDebridStreams(id, userConfig) {
    const query = Buffer.from(id.slice(3), "base64url").toString("utf8");
    console.log("[Stream] Debrid query:", query);

    const torrents = await searchSukebeiAV(query);
    if (!torrents.length) return { streams: [], cacheMaxAge: 60 };

    const hashes = torrents.map(t => t.hash);

    // Parallel cache checks
    const [rdC, tbC, rdA, tbA] = await Promise.all([
        userConfig.rdKey ? checkRD(hashes, userConfig.rdKey).catch(() => ({})) : {},
        userConfig.tbKey ? checkTorbox(hashes, userConfig.tbKey).catch(() => ({})) : {},
        userConfig.rdKey ? getActiveRD(userConfig.rdKey).catch(() => ({})) : {},
        userConfig.tbKey ? getActiveTorbox(userConfig.tbKey).catch(() => ({})) : {},
    ]);

    const streams = [];

    torrents.forEach(t => {
        const hashLow = t.hash.toLowerCase();
        const res = extractResolution(t.title);
        const sizeBytes = parseSizeToBytes(t.size);

        // ── Real-Debrid ──
        if (userConfig.rdKey) {
            const filesRD = rdC[hashLow];
            const progRD = rdA[hashLow];
            const isCached = !!(filesRD && filesRD.length > 0) || progRD === 100;
            const isDownloading = progRD !== undefined && progRD < 100 && progRD > 0;

            let uiName = `AV [☁️ RD]\n🎥 ${res}`;
            let statusLine = "☁️ Download";

            if (isCached) { uiName = `AV [⚡ RD]\n🎥 ${res}`; statusLine = "⚡ Cached"; }
            else if (isDownloading) { uiName = `AV [⏳ ${progRD}% RD]\n🎥 ${res}`; statusLine = `⏳ ${progRD}%`; }

            streams.push({
                name: uiName,
                description: `🌸 Sukebei | ${statusLine}\n📄 ${t.title}\n💾 ${t.size} | 🌱 ${t.seeders} seeders`,
                url: BASE_URL + "/resolve/realdebrid/" + userConfig.rdKey + "/" + t.hash + "/1",
                behaviorHints: {
                    bingeGroup: (isCached ? "av_rd_" : "av_uncached_rd_") + t.hash,
                    notWebReady: !isCached,
                },
                _bytes: sizeBytes,
                _isCached: isCached,
                _prog: progRD || 0,
                _res: res,
            });
        }

        // ── Torbox ──
        if (userConfig.tbKey) {
            const filesTB = tbC[hashLow];
            const progTB = tbA[hashLow];
            const isCached = !!(filesTB && filesTB.length > 0) || progTB === 100;
            const isDownloading = progTB !== undefined && progTB < 100 && progTB > 0;

            let uiName = `AV [☁️ TB]\n🎥 ${res}`;
            let statusLine = "☁️ Download";

            if (isCached) { uiName = `AV [⚡ TB]\n🎥 ${res}`; statusLine = "⚡ Cached"; }
            else if (isDownloading) { uiName = `AV [⏳ ${progTB}% TB]\n🎥 ${res}`; statusLine = `⏳ ${progTB}%`; }

            streams.push({
                name: uiName,
                description: `🌸 Sukebei | ${statusLine}\n📄 ${t.title}\n💾 ${t.size} | 🌱 ${t.seeders} seeders`,
                url: BASE_URL + "/resolve/torbox/" + userConfig.tbKey + "/" + t.hash + "/1",
                behaviorHints: {
                    bingeGroup: (isCached ? "av_tb_" : "av_uncached_tb_") + t.hash,
                    notWebReady: !isCached,
                },
                _bytes: sizeBytes,
                _isCached: isCached,
                _prog: progTB || 0,
                _res: res,
            });
        }
    });

    const resOrder = { "8K": 8000, "4K": 4000, "2K": 2000, "1080p": 1080, "720p": 720, "480p": 480, "SD": 0 };

    return {
        streams: streams.sort((a, b) => {
            if (a._prog > 0 && b._prog === 0) return -1;
            if (b._prog > 0 && a._prog === 0) return 1;
            if (a._isCached !== b._isCached) return b._isCached ? 1 : -1;
            const rDiff = (resOrder[b._res] || 0) - (resOrder[a._res] || 0);
            if (rDiff !== 0) return rDiff;
            return b._bytes - a._bytes;
        }),
        cacheMaxAge: 3600,
    };
}

module.exports = { addonInterface: builder.getInterface(), manifest, parseConfig };
