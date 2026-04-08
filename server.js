//===============
// SUKEBEI AV — SERVER CORE
// Entry point. Express server with:
//   - Stremio addon router
//   - /configure  → setup page
//   - /resolve    → stream resolver (RD + Torbox)
//   - /health     → uptime check
//===============

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const path = require("path");
const { getRouter } = require("stremio-addon-sdk");
const { addonInterface, parseConfig } = require("./addon");

const app = express();
app.use(express.json());

//===============
// CORS (required for Stremio Web & iOS)
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
// HEALTH
//===============
app.get("/health", (req, res) => res.json({ status: "alive", addon: "Sukebei AV" }));

//===============
// CONFIGURE PAGE
//===============
app.get("/configure", (req, res) => {
    res.redirect("/");
});

//===============
// LOADING VIDEO FALLBACK
// While debrid downloads, Stremio plays this instead of a blank screen.
//===============
function serveLoadingVideo(req, res) {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    // Redirect to a tiny public loading video
    res.redirect("https://www.w3schools.com/html/mov_bbb.mp4");
}

//===============
// SELECT THE BEST VIDEO FILE FROM A TORRENT'S FILE LIST
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
// GET /resolve/:provider/:apiKey/:hash/:episode?
//
// - Adds the torrent to debrid if not already there
// - Waits for it to be cached/downloaded
// - Unrestricts the best video file and redirects to the direct link
//===============
app.get("/resolve/:provider/:apiKey/:hash/:episode", handleResolve);
app.get("/resolve/:provider/:apiKey/:hash", (req, res) => {
    req.params.episode = "1";
    handleResolve(req, res);
});

async function handleResolve(req, res) {
    const { provider, apiKey, hash } = req.params;
    const magnet = "magnet:?xt=urn:btih:" + hash;

    try {
        if (provider === "realdebrid") {
            // Check if already in user's RD library
            const listRes = await axios.get(
                "https://api.real-debrid.com/rest/1.0/torrents?limit=250",
                { headers: { Authorization: "Bearer " + apiKey } }
            );
            let torrent = listRes.data.find(t => t.hash.toLowerCase() === hash.toLowerCase());

            // Add magnet if not present
            if (!torrent) {
                const add = await axios.post(
                    "https://api.real-debrid.com/rest/1.0/torrents/addMagnet",
                    new URLSearchParams({ magnet }),
                    { headers: { Authorization: "Bearer " + apiKey } }
                );
                torrent = { id: add.data.id };
            }

            let info = await axios.get(
                "https://api.real-debrid.com/rest/1.0/torrents/info/" + torrent.id,
                { headers: { Authorization: "Bearer " + apiKey } }
            );

            // Dead torrent
            if (["magnet_error", "error", "virus", "dead"].includes(info.data.status)) {
                await axios.delete(
                    "https://api.real-debrid.com/rest/1.0/torrents/delete/" + torrent.id,
                    { headers: { Authorization: "Bearer " + apiKey } }
                ).catch(() => null);
                return res.status(404).send("Torrent is dead.");
            }

            // Select all video files if waiting
            if (info.data.status === "waiting_files_selection") {
                const selectedIds = info.data.files
                    .filter(f => /\.(mkv|mp4|avi|wmv|flv|m4v|ts|mov|webm)$/i.test(f.path))
                    .map(f => f.id);
                await axios.post(
                    "https://api.real-debrid.com/rest/1.0/torrents/selectFiles/" + torrent.id,
                    "files=" + (selectedIds.length ? selectedIds.join(",") : "all"),
                    { headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/x-www-form-urlencoded" } }
                );
                await new Promise(r => setTimeout(r, 1500));
                info = await axios.get(
                    "https://api.real-debrid.com/rest/1.0/torrents/info/" + torrent.id,
                    { headers: { Authorization: "Bearer " + apiKey } }
                );
            }

            if (info.data.status !== "downloaded") return serveLoadingVideo(req, res);

            const bestFile = selectBestVideoFile(info.data.files);
            if (!bestFile) return serveLoadingVideo(req, res);

            // Map file to its RD streaming link
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
                { headers: { Authorization: "Bearer " + apiKey } }
            );
            return res.redirect(unrestrict.data.download);
        }

        if (provider === "torbox") {
            const list = await axios.get(
                "https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true",
                { headers: { Authorization: "Bearer " + apiKey } }
            );
            let torrent = list.data.data
                ? list.data.data.find(t => t.hash.toLowerCase() === hash.toLowerCase())
                : null;

            if (!torrent) {
                const boundary = "----WebKitFormBoundaryAV";
                await axios.post(
                    "https://api.torbox.app/v1/api/torrents/createtorrent",
                    `--${boundary}\r\nContent-Disposition: form-data; name="magnet"\r\n\r\n${magnet}\r\n--${boundary}--`,
                    {
                        headers: {
                            Authorization: "Bearer " + apiKey,
                            "Content-Type": "multipart/form-data; boundary=" + boundary,
                        },
                    }
                ).catch(() => null);
                return serveLoadingVideo(req, res);
            }

            if (["error", "failed", "dead", "deleted"].includes(torrent.download_state)) {
                return res.status(404).send("Torrent is dead.");
            }
            if (torrent.download_state !== "completed" && torrent.download_state !== "cached") {
                return serveLoadingVideo(req, res);
            }

            const bestFile = selectBestVideoFile(torrent.files);
            if (!bestFile) return serveLoadingVideo(req, res);

            const dl = await axios.get(
                `https://api.torbox.app/v1/api/torrents/requestdl?token=${apiKey}&torrent_id=${torrent.id}&file_id=${bestFile.id}`
            );
            return res.redirect(dl.data.data);
        }

        return res.status(400).send("Unknown provider.");
    } catch (e) {
        console.error("[Resolve Error]", e.message);
        return serveLoadingVideo(req, res);
    }
}

//===============
// STREMIO ADDON ROUTER (must be after all custom routes)
//===============
app.use("/", getRouter(addonInterface));

app.listen(PORT, () => {
    console.log(`\n🌸 Sukebei AV Addon running!`);
    console.log(`   Local:     http://127.0.0.1:${PORT}`);
    console.log(`   Configure: http://127.0.0.1:${PORT}/configure`);
    console.log(`   Manifest:  http://127.0.0.1:${PORT}/manifest.json\n`);
});
