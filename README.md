# 🌸 Sukebei AV — Stremio Addon

A stateless Stremio addon that searches [sukebei.nyaa.si](https://sukebei.nyaa.si) for AV content by title/ID and returns torrents as magnet streams.

Inspired by [Yomi](https://github.com/mralanbourne/Yomi) (which does adult anime) — this does the same for AV (JAV, etc.).

---

## How it works

1. You search in Stremio (e.g. `DLDSS-485`)
2. The addon queries the sukebei.nyaa.si RSS feed (category `2_2` = Real Life > Videos)
3. Results are returned as torrent streams with `infoHash` + magnet fallback
4. Stremio passes the magnet to your torrent client or debrid provider

> **No debrid required.** The addon returns raw magnet links that Stremio hands off to your configured torrent backend (WebTorrent, Real-Debrid via another addon, etc).

---

## Quick Start

### 1. Install

```bash
cd stremio-av-addon
npm install
```

### 2. Run

```bash
node server.js
```

By default it runs on **port 7474** (port 7000 conflicts with macOS AirPlay). Set `PORT` env var to change it.

### 3. Install in Stremio

Open Stremio → Add-ons → click the puzzle icon → paste:

```
http://127.0.0.1:7474/manifest.json
```

Or for remote access, set `BASE_URL` and use that URL.

---

## Usage

In Stremio's search bar, type an AV ID like:

- `DLDSS-485`
- `SONE-001`
- `IPZZ-123`
- `Yua Mikami` (actress name, searching title)

The **"Sukebei AV"** catalog will appear with matching results. Click a title to see available torrents sorted by seeder count and resolution.

---

## Configuration (`.env`)

Copy `.env.example` to `.env` and edit as needed:

```env
# Custom sukebei mirror if main domain is blocked
SUKEBEI_DOMAIN=https://sukebei.nyaa.si

# HTTP proxy for bypassing ISP blocks
# PROXY_URL=http://user:pass@host:port

# Port (default 7474)
PORT=7474

# Public URL (important for remote deployments)
BASE_URL=http://127.0.0.1:7474
```

---

## Deployment

### Docker (self-host)

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY . .
RUN npm install
CMD ["node", "server.js"]
```

```bash
docker build -t sukebei-av .
docker run -p 7474:7474 -e BASE_URL=https://your-domain.com sukebei-av
```

### Koyeb / Railway / Render

1. Set `BASE_URL` to your public URL
2. Set `PORT` to `8080` or whatever the platform expects
3. Deploy — no database or storage needed

---

## Notes

- Results are cached **30 minutes** in memory to avoid hammering sukebei
- Streams are sorted by **seeders desc**, then by **resolution** (FHD > HD > SD)
- No metadata (poster art) is fetched — posters are placeholder images with the AV ID
- Want poster art? You can scrape javdb.com or r18.com for covers by integrating with their APIs

---

## License

MIT
