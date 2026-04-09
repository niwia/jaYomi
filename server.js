// =====================================
// SUKEBEI AV — SERVER CORE
// The stremio-addon-sdk does NOT reliably pass config from URL path to handlers.
// So we handle streams ourselves via a custom Express route BEFORE the SDK router.
// This is the same pattern used by many real-world Stremio addons.
// =====================================

require("dotenv").config();

const express = require("express");
const axios = require("axios");
const path = require("path");
const { getRouter } = require("stremio-addon-sdk");
const { addonInterface, buildDebridStreams } = require("./addon");
const { searchSukebeiAV } = require("./lib/sukebei");
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require("./lib/debrid");
const { selectBestVideoFile, logger } = require("./lib/utils");

const TAG = "Server";
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 7474;
let BASE_URL = (process.env.BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");

// =====================================
// CORS
// =====================================
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
    res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
});

app.use(express.static(path.join(__dirname, "public")));

// =====================================
// SIMPLE IN-MEMORY RATE LIMITER
// Protects /resolve from abuse (max 30 req/min per IP)
// =====================================
const rateLimitMap = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 30;

function rateLimit(req, res, next) {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const entry = rateLimitMap.get(ip);

    if (!entry || now - entry.start > RATE_WINDOW_MS) {
        rateLimitMap.set(ip, { start: now, count: 1 });
        return next();
    }

    entry.count++;
    if (entry.count > RATE_MAX) {
        logger.warn(TAG, `Rate limited: ${ip} (${entry.count} req/min)`);
        return res.status(429).json({ error: "Too many requests. Slow down." });
    }
    next();
}

// Cleanup stale entries every 5 min
setInterval(() => {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    for (const [ip, entry] of rateLimitMap) {
        if (entry.start < cutoff) rateLimitMap.delete(ip);
    }
}, 5 * 60 * 1000);

// =====================================
// TRACKERS / MAGNET BUILDER
// =====================================
const TRACKERS = [
    "http://sukebei.tracker.wf:8888/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.torrent.eu.org:451/announce",
];

function buildMagnet(hash, title = "") {
    const dn = encodeURIComponent(title);
    const trs = TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join("");
    return `magnet:?xt=urn:btih:${hash}&dn=${dn}${trs}`;
}

// =====================================
// DECODE CONFIG FROM URL SEGMENT
// Handles base64url → {tbKey, rdKey}
// =====================================
function decodeConfig(configHash) {
    if (!configHash) return {};
    try {
        let b64 = configHash.replace(/-/g, "+").replace(/_/g, "/");
        while (b64.length % 4) b64 += "=";
        const decoded = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
        logger.info(TAG, "Decoded config keys:", Object.keys(decoded));
        return decoded;
    } catch (e) {
        logger.error(TAG, "Config decode error:", e.message);
        return {};
    }
}

// =====================================
// LOADING VIDEO FALLBACK
// =====================================
const LOADING_VIDEO_URL = "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4";
function serveLoadingVideo(req, res) {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.redirect(LOADING_VIDEO_URL);
}

// =====================================
// HEALTH + STATUS ENDPOINTS
// =====================================
const startTime = Date.now();

app.get("/health", (req, res) => res.json({ status: "alive", addon: "Sukebei AV" }));

app.get("/status", (req, res) => {
    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptimeSec / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const s = uptimeSec % 60;
    res.json({
        status: "alive",
        uptime: `${h}h ${m}m ${s}s`,
        env: {
            port: PORT,
            baseUrl: BASE_URL,
            proxy: !!process.env.PROXY_URL,
        },
        memory: process.memoryUsage(),
    });
});

// =====================================
// CONFIGURE PAGE
// =====================================
app.get("/configure", (req, res) => res.redirect("/"));

// =====================================
// CUSTOM STREAM HANDLER
// Mounted BEFORE the SDK router so we can read config from the URL path ourselves.
// URL: /:configHash/stream/movie/av:ENCODEDQUERY.json
// =====================================
app.get("/:configHash/stream/:type/:id.json", async (req, res) => {
    const { configHash, type, id } = req.params;
    res.set("Content-Type", "application/json");

    if (!id.startsWith("av:")) return res.json({ streams: [] });

    const userConfig = decodeConfig(configHash);
    const hasTB = !!userConfig.tbKey;
    const hasRD = !!userConfig.rdKey;

    if (!hasTB && !hasRD) {
        return res.json({
            streams: [{
                name: "⚙️ Setup Required",
                description: `Visit ${BASE_URL}\nEnter your Torbox or RD API key and reinstall the generated manifest URL.`,
                externalUrl: BASE_URL,
            }],
            cacheMaxAge: 60,
        });
    }

    // Delegate to the shared stream builder in addon.js
    const result = await buildDebridStreams(id, userConfig).catch(e => {
        logger.error(TAG, "buildDebridStreams error:", e.message);
        return { streams: [], cacheMaxAge: 60 };
    });

    return res.json(result);
});

// =====================================
// STREAM RESOLVER — Real-Debrid
// =====================================
async function resolveRealDebrid(apiKey, hash, res, req) {
    const magnet = buildMagnet(hash);

    // Check if we already have this torrent
    const listRes = await axios.get("https://api.real-debrid.com/rest/1.0/torrents?limit=250", {
        headers: { Authorization: "Bearer " + apiKey }, timeout: 10000,
    });
    let torrent = listRes.data.find(t => t.hash.toLowerCase() === hash.toLowerCase());

    if (!torrent) {
        logger.info(TAG, "[RD] Adding magnet...");
        const add = await axios.post("https://api.real-debrid.com/rest/1.0/torrents/addMagnet",
            new URLSearchParams({ magnet }),
            { headers: { Authorization: "Bearer " + apiKey }, timeout: 10000 });
        torrent = { id: add.data.id };
    }

    let info = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrent.id}`, {
        headers: { Authorization: "Bearer " + apiKey }, timeout: 10000,
    });

    if (["magnet_error", "error", "virus", "dead"].includes(info.data.status)) {
        await axios.delete(`https://api.real-debrid.com/rest/1.0/torrents/delete/${torrent.id}`,
            { headers: { Authorization: "Bearer " + apiKey } }).catch(() => null);
        return res.status(404).send("Torrent is dead.");
    }

    if (info.data.status === "waiting_files_selection") {
        const selectedIds = info.data.files
            .filter(f => /\.(mkv|mp4|avi|wmv|flv|m4v|ts|mov|webm)$/i.test(f.path))
            .map(f => f.id);
        await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrent.id}`,
            "files=" + (selectedIds.length ? selectedIds.join(",") : "all"),
            { headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 });
        
        // Wait for RD to process the file selection (sometimes takes 1-3 seconds for instant availability)
        for (let i = 0; i < 4; i++) {
            await new Promise(r => setTimeout(r, 1000));
            info = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrent.id}`, {
                headers: { Authorization: "Bearer " + apiKey }, timeout: 10000,
            });
            if (info.data.status === "downloaded") break;
        }
    }

    if (info.data.status !== "downloaded") {
        logger.info(TAG, "[RD] Not ready, status:", info.data.status);
        return serveLoadingVideo(req, res);
    }

    const bestFile = selectBestVideoFile(info.data.files);
    if (!bestFile) return serveLoadingVideo(req, res);

    const fileIdx = info.data.files.findIndex(f => f.id === bestFile.id);
    let targetLink = info.data.links[0];
    if (fileIdx !== -1) {
        let cnt = 0;
        for (let i = 0; i < info.data.files.length; i++) {
            if (i === fileIdx) { targetLink = info.data.links[cnt]; break; }
            if (info.data.files[i].selected === 1) cnt++;
        }
    }
    if (!targetLink) return serveLoadingVideo(req, res);

    const unrestrict = await axios.post("https://api.real-debrid.com/rest/1.0/unrestrict/link",
        new URLSearchParams({ link: targetLink }),
        { headers: { Authorization: "Bearer " + apiKey }, timeout: 10000 });
    return res.redirect(unrestrict.data.download);
}

// =====================================
// STREAM RESOLVER — Torbox
// =====================================
async function resolveTorbox(apiKey, hash, res, req) {
    const magnet = buildMagnet(hash);

    const list = await axios.get("https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true", {
        headers: { Authorization: "Bearer " + apiKey }, timeout: 15000,
    });
    let torrent = list.data.data
        ? list.data.data.find(t => t.hash && t.hash.toLowerCase() === hash.toLowerCase())
        : null;

    if (!torrent) {
        logger.info(TAG, "[TB] Adding magnet to Torbox...");
        try {
            const FormData = require("form-data");
            const form = new FormData();
            form.append("magnet", magnet);
            const addRes = await axios.post("https://api.torbox.app/v1/api/torrents/createtorrent",
                form,
                { headers: { ...form.getHeaders(), Authorization: "Bearer " + apiKey }, timeout: 15000 });
            logger.info(TAG, "[TB] Add result:", JSON.stringify(addRes.data).substring(0, 150));

            if (addRes.data?.data?.torrent_id) {
                // If added successfully, immediately fetch the torrent object from the list to continue streaming
                const recheck = await axios.get("https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true", {
                    headers: { Authorization: "Bearer " + apiKey }, timeout: 15000,
                });
                torrent = recheck.data?.data?.find(t => String(t.id) === String(addRes.data.data.torrent_id));
            }
        } catch (addErr) {
            logger.error(TAG, "[TB] Failed to add magnet:", addErr.response?.data || addErr.message);
        }

        if (!torrent) {
            return serveLoadingVideo(req, res);
        }
    }

    logger.info(TAG, "[TB] Found torrent. State:", torrent.download_state);

    if (["error", "failed", "dead", "deleted"].includes(torrent.download_state)) {
        return res.status(404).send("Torrent is dead on Torbox.");
    }
    if (torrent.download_state !== "completed" && torrent.download_state !== "cached") {
        logger.info(TAG, "[TB] Not ready:", torrent.download_state, `${Math.round((torrent.progress || 0) * 100)}%`);
        return serveLoadingVideo(req, res);
    }

    const bestFile = selectBestVideoFile(torrent.files);
    if (!bestFile) {
        logger.error(TAG, "[TB] No suitable video file. Files:", JSON.stringify(torrent.files?.map(f => ({ name: f.name, size: f.size }))));
        return serveLoadingVideo(req, res);
    }

    logger.info(TAG, "[TB] Streaming file:", bestFile.name, `(${Math.round((bestFile.size || 0) / 1024 / 1024)}MB)`);
    const dl = await axios.get(
        `https://api.torbox.app/v1/api/torrents/requestdl?token=${apiKey}&torrent_id=${torrent.id}&file_id=${bestFile.id}&zip_link=false`,
        { timeout: 10000 });
    const streamUrl = dl.data.data;
    if (!streamUrl) return serveLoadingVideo(req, res);
    return res.redirect(streamUrl);
}

// =====================================
// RESOLVE ROUTE (rate-limited)
// =====================================
app.get("/resolve/:provider/:apiKey/:hash/:episode", rateLimit, handleResolve);
app.get("/resolve/:provider/:apiKey/:hash", rateLimit, (req, res) => {
    req.params.episode = "1";
    handleResolve(req, res);
});

async function handleResolve(req, res) {
    const { provider, apiKey, hash } = req.params;
    logger.info(TAG, `Resolve: ${provider} | hash=${hash.substring(0, 10)}...`);

    try {
        if (provider === "realdebrid") return await resolveRealDebrid(apiKey, hash, res, req);
        if (provider === "torbox") return await resolveTorbox(apiKey, hash, res, req);
        return res.status(400).send("Unknown provider.");
    } catch (e) {
        logger.error(TAG, `Resolve error [${provider}]:`, e.response?.status, e.response?.data || e.message);
        return serveLoadingVideo(req, res);
    }
}

// =====================================
// STREMIO SDK ROUTER (catalog, meta, manifest)
// Must be last — after all custom routes
// =====================================
app.use("/", getRouter(addonInterface));

app.listen(PORT, () => {
    logger.info(TAG, `🌸 Sukebei AV running on port ${PORT}`);
    logger.info(TAG, `   Configure: ${BASE_URL}`);
    logger.info(TAG, `   Manifest:  ${BASE_URL}/manifest.json`);
    logger.info(TAG, `   Status:    ${BASE_URL}/status`);
});
