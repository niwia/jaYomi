//===============
// SUKEBEI AV — DEBRID PROVIDER INTERFACE
// Manages communication with Real-Debrid & Torbox.
// Includes Promise deduplication and LRU caching.
//===============

const axios = require("axios");

const apiCache = new Map();
const MAX_CACHE_ENTRIES = 500;

function setCache(key, dataOrPromise, ttlMs = 60000) {
    if (apiCache.has(key)) {
        apiCache.delete(key);
    } else if (apiCache.size >= MAX_CACHE_ENTRIES) {
        apiCache.delete(apiCache.keys().next().value);
    }
    apiCache.set(key, { data: dataOrPromise, expiresAt: Date.now() + ttlMs });
}

function getCache(key) {
    if (apiCache.has(key)) {
        const item = apiCache.get(key);
        if (item.expiresAt > Date.now()) {
            apiCache.delete(key);
            apiCache.set(key, item);
            return item.data;
        } else {
            apiCache.delete(key);
        }
    }
    return null;
}

async function checkRD(hashes, apiKey) {
    if (!hashes || hashes.length === 0) return {};
    const hashKey = [...hashes].sort().join("");
    const cacheKey = "rd_chk_" + apiKey.substring(0, 5) + "_" + hashKey;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    const performFetch = async () => {
        try {
            const results = {};
            for (let i = 0; i < hashes.length; i += 40) {
                const chunk = hashes.slice(i, i + 40);
                const url = "https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/" + chunk.join("/");
                const res = await axios.get(url, { headers: { Authorization: "Bearer " + apiKey } });
                Object.keys(res.data).forEach(hash => {
                    const h = hash.toLowerCase();
                    const av = res.data[hash];
                    if (av && av.rd && av.rd.length > 0) {
                        const allFiles = new Map();
                        av.rd.forEach(variant => {
                            Object.keys(variant).forEach(fileId => {
                                if (!allFiles.has(fileId)) {
                                    allFiles.set(fileId, { id: fileId, name: variant[fileId].filename, size: variant[fileId].filesize });
                                }
                            });
                        });
                        results[h] = Array.from(allFiles.values());
                    }
                });
                if (i + 40 < hashes.length) await new Promise(r => setTimeout(r, 300));
            }
            return { data: results, ttl: 60000 };
        } catch (e) {
            const status = e.response ? e.response.status : 500;
            console.error("[RD] checkRD failed:", status);
            return { data: {}, ttl: status === 401 || status === 403 ? 3600000 : status === 429 ? 30000 : 10000 };
        }
    };

    const fetchPromise = performFetch().then(r => { setCache(cacheKey, r.data, r.ttl); return r.data; });
    setCache(cacheKey, fetchPromise, 30000);
    return fetchPromise;
}

async function checkTorbox(hashes, apiKey) {
    if (!hashes || hashes.length === 0) return {};
    const hashKey = [...hashes].sort().join("");
    const cacheKey = "tb_chk_" + apiKey.substring(0, 5) + "_" + hashKey;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    const performFetch = async () => {
        try {
            const results = {};
            for (let i = 0; i < hashes.length; i += 40) {
                const chunk = hashes.slice(i, i + 40);
                const url = "https://api.torbox.app/v1/api/torrents/checkcached?hash=" + chunk.join(",") + "&format=list&list_files=true";
                const res = await axios.get(url, { headers: { Authorization: "Bearer " + apiKey } });
                if (res.data && res.data.data) {
                    res.data.data.forEach(t => {
                        results[t.hash.toLowerCase()] = t.files.map(f => ({ id: f.id, name: f.name, size: f.size }));
                    });
                }
                if (i + 40 < hashes.length) await new Promise(r => setTimeout(r, 300));
            }
            return { data: results, ttl: 60000 };
        } catch (e) {
            const status = e.response ? e.response.status : 500;
            console.error("[TB] checkTorbox failed:", status);
            return { data: {}, ttl: status === 401 || status === 403 ? 3600000 : status === 429 ? 30000 : 10000 };
        }
    };

    const fetchPromise = performFetch().then(r => { setCache(cacheKey, r.data, r.ttl); return r.data; });
    setCache(cacheKey, fetchPromise, 30000);
    return fetchPromise;
}

async function getActiveRD(apiKey) {
    const cacheKey = "rd_act_" + apiKey;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    const performFetch = async () => {
        try {
            const res = await axios.get("https://api.real-debrid.com/rest/1.0/torrents?limit=100", {
                headers: { Authorization: "Bearer " + apiKey }
            });
            const active = {};
            res.data.forEach(t => {
                if (t.status === "downloaded") active[t.hash.toLowerCase()] = 100;
                else if (t.status !== "error" && t.status !== "dead") active[t.hash.toLowerCase()] = t.progress || 0;
            });
            return { data: active, ttl: 10000 };
        } catch (e) {
            const status = e.response ? e.response.status : 500;
            return { data: {}, ttl: status === 401 || status === 403 ? 3600000 : 10000 };
        }
    };

    const fetchPromise = performFetch().then(r => { setCache(cacheKey, r.data, r.ttl); return r.data; });
    setCache(cacheKey, fetchPromise, 10000);
    return fetchPromise;
}

async function getActiveTorbox(apiKey) {
    const cacheKey = "tb_act_" + apiKey;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    const performFetch = async () => {
        try {
            const res = await axios.get("https://api.torbox.app/v1/api/torrents/mylist?bypass_cache=true", {
                headers: { Authorization: "Bearer " + apiKey }
            });
            const active = {};
            if (res.data && res.data.data) {
                res.data.data.forEach(t => {
                    if (t.download_state === "completed" || t.download_state === "cached") {
                        active[t.hash.toLowerCase()] = 100;
                    } else {
                        let p = t.progress || 0;
                        if (p <= 1 && p > 0) p = p * 100;
                        active[t.hash.toLowerCase()] = Math.round(p);
                    }
                });
            }
            return { data: active, ttl: 10000 };
        } catch (e) {
            const status = e.response ? e.response.status : 500;
            return { data: {}, ttl: status === 401 || status === 403 ? 3600000 : 10000 };
        }
    };

    const fetchPromise = performFetch().then(r => { setCache(cacheKey, r.data, r.ttl); return r.data; });
    setCache(cacheKey, fetchPromise, 10000);
    return fetchPromise;
}

module.exports = { checkRD, checkTorbox, getActiveRD, getActiveTorbox };
