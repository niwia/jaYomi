const axios = require('axios');
async function testV() {
  try {
    const res = await axios.get('https://www.javlibrary.com/en/vl_searchbyid.php?keyword=DLDSS-485', {
        headers: { 'User-Agent': 'Mozilla/5.0' }, maxRedirects:5, timeout: 5000
    });
    console.log(res.status, res.data.length);
  } catch(e) { console.log('Err:', e.message); }
}
testV();
