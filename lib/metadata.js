const axios = require('axios');
const cheerio = require('cheerio');

// In-memory cache to avoid repeated network calls to external scraper
const metaCache = new Map();

async function fetchMetadata(query) {
    if (!query) return null;
    
    // Extract AV ID pattern like "MIDA-575" or "SOE-123"
    const avIdMatch = query.match(/[A-Z]{2,8}-\d{2,6}/i);
    let id = avIdMatch ? avIdMatch[0].toUpperCase() : query.toUpperCase();
    
    if (metaCache.has(id)) {
        return metaCache.get(id);
    }

    try {
        // Try scraping JavDatabase as the primary source
        const url = `https://www.javdatabase.com/movies/${id.toLowerCase()}/`;
        const res = await axios.get(url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36' 
            },
            timeout: 8000
        });

        const $ = cheerio.load(res.data);
        const poster = $('meta[property="og:image"]').attr('content');
        let title = $('meta[property="og:title"]').attr('content') || $('title').text();
        
        if (title) {
            title = title.replace(/\s*-\s*JAVDatabase\.com/i, '').trim();
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

        if (poster) {
            const metadata = {
                id: id,
                poster: poster,
                title: title,
                description: description.trim()
            };
            
            metaCache.set(id, metadata);
            // Cap memory usage
            if (metaCache.size > 500) {
                const firstKey = metaCache.keys().next().value;
                metaCache.delete(firstKey);
            }
            return metadata;
        }
    } catch (e) {
        console.log(`[Metadata] JavDatabase missed ${id}.`);
    }
    
    return null;
}

module.exports = { fetchMetadata };
