//===============
// SUKEBEI AV — SERVER CORE
// The stremio-addon-sdk does NOT reliably pass config from URL path to handlers.
// So we handle streams ourselves via a custom Express route BEFORE the SDK router.
// This is the same pattern used by many real-world Stremio addons.
//===============

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const path = require("path");
const { getRouter } = require("stremio-addon-sdk");
const { addonInterface } = require("./addon");
const { searchSukebeiAV, extractResolution } = require("./lib/sukebei");
const { checkRD, checkTorbox, getActiveRD, getActiveTorbox } = require("./lib/debrid");

const app = express();
app.use(express.json());

//===============
// CORS
//===============
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
    res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
});

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 7474;
let BASE_URL = (process.env.BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");

//===============
// TRACKERS
//===============
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

//===============
// DECODE CONFIG FROM URL SEGMENT
// Handles base64url → {tbKey, rdKey}
//===============
function decodeConfig(configHash) {
    if (!configHash) return {};
    try {
        let b64 = configHash.replace(/-/g, "+").replace(/_/g, "/");
        while (b64.length % 4) b64 += "=";
        const decoded = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
        console.log("[Config] Decoded keys:", Object.keys(decoded));
        return decoded;
    } catch (e) {
        console.error("[Config] Decode error:", e.message);
        return {};
    }
}

//===============
// HELPERS
//===============
function parseSizeToBytes(sizeStr) {
    if (!sizeStr) return 0;
    const m = sizeStr.match(/([\d.]+)\s*(GB|MB|KB|GiB|MiB|KiB|B)/i);
    if (!m) return 0;
    const val = parseFloat(m[1]);
    const u = m[2].toUpperCase();
    if (u.includes("G")) return val * 1024 ** 3;
    if (u.includes("M")) return val * 1024 ** 2;
    if (u.includes("K")) return val * 1024;
    return val;
}

function selectBestVideoFile(files) {
    if (!files || files.length === 0) return null;
    const MIN_SIZE = 50 * 1024 * 1024; // 50 MB — skip preview/spam files
    const videoFiles = files
        .filter(f => /\.(mkv|mp4|avi|wmv|flv|m4v|ts|mov|webm)$/i.test(f.path || f.name || ""))
        .filter(f => (f.size || 0) > MIN_SIZE);
    if (videoFiles.length === 0) return null;
    return videoFiles.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
}

//===============
// HEALTH
//===============
app.get("/health", (req, res) => res.json({ status: "alive", addon: "Sukebei AV" }));

//===============
// CONFIGURE PAGE
//===============
app.get("/configure", (req, res) => res.redirect("/"));

//===============
// LOADING VIDEO FALLBACK
//===============
const LOADING_VIDEO_URL = "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4";
function serveLoadingVideo(req, res) {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.redirect(LOADING_VIDEO_URL);
}

//===============
// CUSTOM STREAM HANDLER
// Mounted BEFORE the SDK router so we can read config from the URL path ourselves.
// URL: /:configHash/stream/movie/av:ENCODEDQUERY.json
//===============
app.get("/:configHash/stream/:type/:id.json", async (req, res) => {
    const { configHash, type, id } = req.params;
    res.set("Content-Type", "application/json");

    if (!id.startsWith("av:")) return res.json({ streams: [] });

    const userConfig = decodeConfig(configHash);
    const hasTB = !!userConfig.tbKey;
    const hasRD = !!userConfig.rdKey;

    let query;
    try {
        query = Buffer.from(id.slice(3), "base64url").toString("utf8");
    } catch (e) {
        return res.json({ streams: [] });
    }

    console.log(`[Stream] query="${query}" hasTB=${hasTB} hasRD=${hasRD}`);

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

    const torrents = await searchSukebeiAV(query).catch(() => []);
    if (!torrents.length) return res.json({ streams: [], cacheMaxAge: 60 });

    const hashes = torrents.map(t => t.hash);
    const [rdC, tbC, rdA, tbA] = await Promise.all([
        hasRD ? checkRD(hashes, userConfig.rdKey).catch(() => ({})) : {},
        hasTB ? checkTorbox(hashes, userConfig.tbKey).catch(() => ({})) : {},
        hasRD ? getActiveRD(userConfig.rdKey).catch(() => ({})) : {},
        hasTB ? getActiveTorbox(userConfig.tbKey).catch(() => ({})) : {},
    ]);

    const resOrder = { "8K": 8000, "4K": 4000, "2K": 2000, "1080p": 1080, "720p": 720, "480p": 480, "SD": 0 };
    const streams = [];

    torrents.forEach(t => {
        const hashLow = t.hash.toLowerCase();
        const res = extractResolution(t.title);
        const sizeBytes = parseSizeToBytes(t.size);

        if (hasRD) {
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
                url: `${BASE_URL}/resolve/realdebrid/${userConfig.rdKey}/${t.hash}/1`,
                behaviorHints: { bingeGroup: (isCached ? "av_rd_" : "av_uncached_rd_") + t.hash, notWebReady: !isCached },
                _bytes: sizeBytes, _isCached: isCached, _prog: progRD || 0, _res: res,
            });
        }

        if (hasTB) {
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
                url: `${BASE_URL}/resolve/torbox/${userConfig.tbKey}/${t.hash}/1`,
                behaviorHints: { bingeGroup: (isCached ? "av_tb_" : "av_uncached_tb_") + t.hash, notWebReady: !isCached },
                _bytes: sizeBytes, _isCached: isCached, _prog: progTB || 0, _res: res,
            });
        }
    });

    const sorted = streams.sort((a, b) => {
        if (a._prog > 0 && b._prog === 0) return -1;
        if (b._prog > 0 && a._prog === 0) return 1;
        if (a._isCached !== b._isCached) return b._isCached ? 1 : -1;
        const rDiff = (resOrder[b._res] || 0) - (resOrder[a._res] || 0);
        if (rDiff !== 0) return rDiff;
        return b._bytes - a._bytes;
    });

    console.log(`[Stream] Returning ${sorted.length} streams`);
    return res.json({ streams: sorted, cacheMaxAge: 3600 });
});

//===============
// STREAM RESOLVER
//===============
app.get("/resolve/:provider/:apiKey/:hash/:episode", handleResolve);
app.get("/resolve/:provider/:apiKey/:hash", (req, res) => {
    req.params.episode = "1";
    handleResolve(req, res);
});

async function handleResolve(req, res) {
    const { provider, apiKey, hash } = req.params;
    const magnet = buildMagnet(hash);
    console.log(`[Resolve] ${provider} | hash=${hash.substring(0, 10)}...`);

    try {
        if (provider === "realdebrid") {
            const listRes = await axios.get("https://api.real-debrid.com/rest/1.0/torrents?limit=250",
                { headers: { Authorization: "Bearer " + apiKey }, timeout: 10000 });
            let torrent = listRes.data.find(t => t.hash.toLowerCase() === hash.toLowerCase());

            if (!torrent) {
                console.log("[RD] Adding magnet...");
                const add = await axios.post("https://api.real-debrid.com/rest/1.0/torrents/addMagnet",
                    new URLSearchParams({ magnet }),
                    { headers: { Authorization: "Bearer " + apiKey }, timeout: 10000 });
                torrent = { id: add.data.id };
            }

            let info = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrent.id}`,
                { headers: { Authorization: "Bearer " + apiKey }, timeout: 10000 });

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
                await new Promise(r => setTimeout(r, 1500));
                info = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrent.id}`,
                    { headers: { Authorization: "Bearer " + apiKey }, timeout: 10000 });
            }

            if (info.data.status !== "downloaded") {
                console.log("[RD] Not ready, status:", info.data.status);
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

        if (provider === "torbox") {
            const list = await axios.get("https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true",
                { headers: { Authorization: "Bearer " + apiKey }, timeout: 15000 });
            let torrent = list.data.data
                ? list.data.data.find(t => t.hash && t.hash.toLowerCase() === hash.toLowerCase())
                : null;

            if (!torrent) {
                console.log("[TB] Adding magnet to Torbox...");
                try {
                    const FormData = require("form-data");
                    const form = new FormData();
                    form.append("magnet", magnet);
                    const addRes = await axios.post("https://api.torbox.app/v1/api/torrents/createtorrent",
                        form,
                        { headers: { ...form.getHeaders(), Authorization: "Bearer " + apiKey }, timeout: 15000 });
                    console.log("[TB] Add result:", JSON.stringify(addRes.data).substring(0, 150));
                } catch (addErr) {
                    console.error("[TB] Failed to add magnet:", addErr.response?.data || addErr.message);
                }
                return serveLoadingVideo(req, res);
            }

            console.log("[TB] Found torrent. State:", torrent.download_state);

            if (["error", "failed", "dead", "deleted"].includes(torrent.download_state)) {
                return res.status(404).send("Torrent is dead on Torbox.");
            }
            if (torrent.download_state !== "completed" && torrent.download_state !== "cached") {
                console.log("[TB] Not ready:", torrent.download_state, `${Math.round((torrent.progress || 0) * 100)}%`);
                return serveLoadingVideo(req, res);
            }

            const bestFile = selectBestVideoFile(torrent.files);
            if (!bestFile) {
                console.error("[TB] No suitable video file. Files:", JSON.stringify(torrent.files?.map(f => ({ name: f.name, size: f.size }))));
                return serveLoadingVideo(req, res);
            }

            console.log("[TB] Streaming file:", bestFile.name, `(${Math.round((bestFile.size || 0) / 1024 / 1024)}MB)`);
            const dl = await axios.get(
                `https://api.torbox.app/v1/api/torrents/requestdl?token=${apiKey}&torrent_id=${torrent.id}&file_id=${bestFile.id}&zip_link=false`,
                { timeout: 10000 });
            const streamUrl = dl.data.data;
            if (!streamUrl) return serveLoadingVideo(req, res);
            return res.redirect(streamUrl);
        }

        return res.status(400).send("Unknown provider.");
    } catch (e) {
        console.error("[Resolve Error]", provider, e.response?.status, e.response?.data || e.message);
        return serveLoadingVideo(req, res);
    }
}

//===============
// STREMIO SDK ROUTER (catalog, meta, manifest)
//===============
app.use("/", getRouter(addonInterface));

app.listen(PORT, () => {
    console.log(`\n🌸 Sukebei AV running on port ${PORT}`);
    console.log(`   Configure: ${BASE_URL}`);
    console.log(`   Manifest:  ${BASE_URL}/manifest.json\n`);
});
