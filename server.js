//===============
// SUKEBEI AV — SERVER CORE
//===============

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const path = require("path");
const { getRouter } = require("stremio-addon-sdk");
const { addonInterface } = require("./addon");

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
// TRACKERS — used when building full magnet URIs
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
// HEALTH
//===============
app.get("/health", (req, res) => res.json({ status: "alive", addon: "Sukebei AV" }));

//===============
// CONFIGURE PAGE
//===============
app.get("/configure", (req, res) => res.redirect("/"));

//===============
// LOADING VIDEO FALLBACK
// Big Buck Bunny short clip from a reliable public CDN
// Stremio will play this while debrid downloads in the background.
//===============
const LOADING_VIDEO_URL = "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4";

function serveLoadingVideo(req, res) {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.redirect(LOADING_VIDEO_URL);
}

//===============
// SELECT BEST VIDEO FILE (largest video file = full quality AV)
//===============
function selectBestVideoFile(files) {
    if (!files || files.length === 0) return null;
    const videoFiles = files.filter(f =>
        /\.(mkv|mp4|avi|wmv|flv|m4v|ts|mov|webm)$/i.test(f.path || f.name || "")
    );
    if (videoFiles.length === 0) return null;
    return videoFiles.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
}

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
    // Always use a full magnet with trackers — critical for Torbox to find the torrent
    const magnet = buildMagnet(hash);

    console.log(`[Resolve] ${provider} | hash=${hash.substring(0, 10)}...`);

    try {
        //===============
        // REAL-DEBRID
        //===============
        if (provider === "realdebrid") {
            const listRes = await axios.get(
                "https://api.real-debrid.com/rest/1.0/torrents?limit=250",
                { headers: { Authorization: "Bearer " + apiKey }, timeout: 10000 }
            );
            let torrent = listRes.data.find(t => t.hash.toLowerCase() === hash.toLowerCase());

            if (!torrent) {
                console.log("[RD] Adding magnet...");
                const add = await axios.post(
                    "https://api.real-debrid.com/rest/1.0/torrents/addMagnet",
                    new URLSearchParams({ magnet }),
                    { headers: { Authorization: "Bearer " + apiKey }, timeout: 10000 }
                );
                torrent = { id: add.data.id };
            }

            let info = await axios.get(
                "https://api.real-debrid.com/rest/1.0/torrents/info/" + torrent.id,
                { headers: { Authorization: "Bearer " + apiKey }, timeout: 10000 }
            );

            if (["magnet_error", "error", "virus", "dead"].includes(info.data.status)) {
                await axios.delete(
                    "https://api.real-debrid.com/rest/1.0/torrents/delete/" + torrent.id,
                    { headers: { Authorization: "Bearer " + apiKey } }
                ).catch(() => null);
                return res.status(404).send("Torrent is dead.");
            }

            if (info.data.status === "waiting_files_selection") {
                const selectedIds = info.data.files
                    .filter(f => /\.(mkv|mp4|avi|wmv|flv|m4v|ts|mov|webm)$/i.test(f.path))
                    .map(f => f.id);
                await axios.post(
                    "https://api.real-debrid.com/rest/1.0/torrents/selectFiles/" + torrent.id,
                    "files=" + (selectedIds.length ? selectedIds.join(",") : "all"),
                    { headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 }
                );
                await new Promise(r => setTimeout(r, 1500));
                info = await axios.get(
                    "https://api.real-debrid.com/rest/1.0/torrents/info/" + torrent.id,
                    { headers: { Authorization: "Bearer " + apiKey }, timeout: 10000 }
                );
            }

            if (info.data.status !== "downloaded") {
                console.log("[RD] Not downloaded yet, status:", info.data.status);
                return serveLoadingVideo(req, res);
            }

            const bestFile = selectBestVideoFile(info.data.files);
            if (!bestFile) return serveLoadingVideo(req, res);

            const fileIdx = info.data.files.findIndex(f => f.id === bestFile.id);
            let targetLink = info.data.links[0];
            if (fileIdx !== -1) {
                let linkCounter = 0;
                for (let i = 0; i < info.data.files.length; i++) {
                    if (i === fileIdx) { targetLink = info.data.links[linkCounter]; break; }
                    if (info.data.files[i].selected === 1) linkCounter++;
                }
            }

            if (!targetLink) return serveLoadingVideo(req, res);

            const unrestrict = await axios.post(
                "https://api.real-debrid.com/rest/1.0/unrestrict/link",
                new URLSearchParams({ link: targetLink }),
                { headers: { Authorization: "Bearer " + apiKey }, timeout: 10000 }
            );
            console.log("[RD] Streaming:", unrestrict.data.download.substring(0, 60));
            return res.redirect(unrestrict.data.download);
        }

        //===============
        // TORBOX
        //===============
        if (provider === "torbox") {
            // Step 1: Check if torrent already in Torbox library
            const list = await axios.get(
                "https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true",
                { headers: { Authorization: "Bearer " + apiKey }, timeout: 15000 }
            );
            let torrent = list.data.data
                ? list.data.data.find(t => t.hash && t.hash.toLowerCase() === hash.toLowerCase())
                : null;

            // Step 2: If not there, add it
            if (!torrent) {
                console.log("[TB] Adding magnet to Torbox...", magnet.substring(0, 60));
                try {
                    const FormData = require("form-data");
                    const form = new FormData();
                    form.append("magnet", magnet);
                    const addRes = await axios.post(
                        "https://api.torbox.app/v1/api/torrents/createtorrent",
                        form,
                        {
                            headers: {
                                ...form.getHeaders(),
                                Authorization: "Bearer " + apiKey,
                            },
                            timeout: 15000,
                        }
                    );
                    console.log("[TB] Add result:", JSON.stringify(addRes.data).substring(0, 200));
                } catch (addErr) {
                    console.error("[TB] Failed to add magnet:", addErr.response?.data || addErr.message);
                }
                // Torrent was just added — send loading video while TB downloads
                return serveLoadingVideo(req, res);
            }

            console.log("[TB] Torrent found. State:", torrent.download_state);

            if (["error", "failed", "dead", "deleted"].includes(torrent.download_state)) {
                return res.status(404).send("Torrent is dead on Torbox.");
            }

            if (torrent.download_state !== "completed" && torrent.download_state !== "cached") {
                console.log("[TB] Not ready yet:", torrent.download_state, torrent.progress);
                return serveLoadingVideo(req, res);
            }

            // Step 3: Get the best video file and request download link
            const bestFile = selectBestVideoFile(torrent.files);
            if (!bestFile) {
                console.error("[TB] No video file found in torrent files:", torrent.files?.length);
                return serveLoadingVideo(req, res);
            }

            const dl = await axios.get(
                `https://api.torbox.app/v1/api/torrents/requestdl?token=${apiKey}&torrent_id=${torrent.id}&file_id=${bestFile.id}&zip_link=false`,
                { timeout: 10000 }
            );
            const streamUrl = dl.data.data;
            console.log("[TB] Streaming:", streamUrl ? streamUrl.substring(0, 60) : "no URL returned");

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
// STREMIO ADDON ROUTER
//===============
app.use("/", getRouter(addonInterface));

app.listen(PORT, () => {
    console.log(`\n🌸 Sukebei AV running on port ${PORT}`);
    console.log(`   Configure: ${BASE_URL}`);
    console.log(`   Manifest:  ${BASE_URL}/manifest.json\n`);
});
