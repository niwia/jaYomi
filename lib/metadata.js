const axios = require('axios');
const cheerio = require('cheerio');

// In-memory cache to avoid repeated network calls to external scraper
const metaCache = new Map();

// Helper to generate DMM CDN image URLs instantly (works for 95% of codes)
function getDmmPosterUrl(avId) {
    if (!avId) return null;
    const match = avId.match(/^([A-Za-z]+)-?(\d+)$/);
    if (!match) return null;
    const prefix = match[1].toLowerCase();
    const num = match[2].padStart(5, '0');
    const combined = prefix + num;
    return `https://pics.dmm.co.jp/digital/video/${combined}/${combined}pl.jpg`;
}

async function fetchMetadata(query) {
    if (!query) return null;
    
    // Extract AV ID pattern like "MIDA-575" or "SOE-123"
    const avIdMatch = query.match(/[A-Z]{2,8}-\d{2,6}/i);
    let id = avIdMatch ? avIdMatch[0].toUpperCase() : query.toUpperCase();
    
    if (metaCache.has(id)) {
        return metaCache.get(id);
    }

    let metadata = {
        id: id,
        poster: getDmmPosterUrl(id), // Provide instant predicted DMM poster as base
        title: null,
        description: ''
    };

    try {
        // Try scraping JavDatabase for rich metadata (Title, Cast, Desc)
        const url = `https://www.javdatabase.com/movies/${id.toLowerCase()}/`;
        const res = await axios.get(url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36' 
            },
            timeout: 5000
        });

        const $ = cheerio.load(res.data);
        const jdPoster = $('meta[property="og:image"]').attr('content');
        if (jdPoster) metadata.poster = jdPoster;

        let title = $('meta[property="og:title"]').attr('content') || $('title').text();
        if (title) {
            metadata.title = title.replace(/\s*-\s*JAVDatabase\.com/i, '').trim();
        }

        // Extract some basic elements from the page text
        let description = '';
        $('p').each((i, el) => {
            const text = $(el).text();
            if (text.includes('Idol(s)/Actress(es):')) {
                const parts = text.split('Idol(s)/Actress(es):');
                if (parts[1]) description += `🎭 Cast: ${parts[1].trim()}\n`;
            }
            if (text.includes('Studio:')) {
                const parts = text.split('Studio:');
                if (parts[1]) description += `🏢 Studio: ${parts[1].trim()}\n`;
            }
            if (text.includes('Release Date:')) {
                const parts = text.split('Release Date:');
                if (parts[1]) description += `📅 Released: ${parts[1].trim()}\n`;
            }
        });

        metadata.description = description.trim();

    } catch (e) {
        // Render's IP likely got blocked by JavDatabase Cloudflare challenge (403)
        console.log(`[Metadata] JavDatabase blocked/missed ${id}. Falling back to DMM CDN poster.`);
    }
    
    // We cache it even if it's only the DMM fallback so we don't spam requests
    if (metadata.poster) {
        metaCache.set(id, metadata);
        // Cap memory usage
        if (metaCache.size > 500) {
            const firstKey = metaCache.keys().next().value;
            metaCache.delete(firstKey);
        }
        return metadata;
    }
    
    return null;
}

module.exports = { fetchMetadata };
