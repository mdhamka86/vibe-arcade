// api/terminal-news.js
// THE TERMINAL — news wire. Google News RSS aggregator, dependency-free.
// GET /api/terminal-news?topic=spurs
// GET /api/terminal-news?topic=markets&tickers=CRDO,CAMT,MRVL

const TOPIC_QUERIES = {
  football: ['football premier league OR "champions league" OR transfer'],
  spurs: ['"Tottenham Hotspur"'],
  singapore: ['Singapore news'],
  f1: ['"Formula 1" grand prix'],
  racing: [
    'horse racing UK',
    'horse racing "South Africa"',
    'horse racing Australia',
    'horse racing France OR Japan OR "Hong Kong"',
  ],
  worldcup: ['"World Cup" 2026 football'],
  phuket: ['Phuket'],
  fm: ['"Football Manager" game'],
  forex: [
    'forex dollar euro yen "central bank" OR Fed OR ECB OR BOJ',
    'currency markets outlook',
  ],
};

function decodeEntities(s) {
  return (s || '')
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

function parseRSS(xml) {
  const items = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const b of blocks) {
    const title = tag(b, 'title');
    if (!title) continue;
    items.push({
      title,
      link: tag(b, 'link'),
      source: tag(b, 'source') || (title.split(' - ').pop() || '').slice(0, 40),
      pubDate: tag(b, 'pubDate'),
      ts: Date.parse(tag(b, 'pubDate')) || 0,
      desc: tag(b, 'description').slice(0, 280),
    });
  }
  return items;
}

async function fetchFeed(q) {
  const url =
    'https://news.google.com/rss/search?q=' +
    encodeURIComponent(q + ' when:2d') +
    '&hl=en-SG&gl=SG&ceid=SG:en';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (TheTerminal/1.0)' } });
    if (!r.ok) return [];
    return parseRSS(await r.text());
  } catch {
    return [];
  }
}

export async function getNews(topic, tickers) {
  let queries;
  if (topic === 'markets') {
    const list = (tickers || 'CRDO,CAMT').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 14);
    // chunk tickers into OR groups of 4 so queries stay tight
    queries = [];
    for (let i = 0; i < list.length; i += 4) {
      queries.push(list.slice(i, i + 4).map((t) => `"${t}" stock`).join(' OR '));
    }
  } else {
    queries = TOPIC_QUERIES[topic] || TOPIC_QUERIES.football;
  }
  const results = await Promise.all(queries.map(fetchFeed));
  const seen = new Set();
  const merged = [];
  for (const item of results.flat()) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  merged.sort((a, b) => b.ts - a.ts);
  return merged.slice(0, 30);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');
  const { topic = 'football', tickers = '' } = req.query;
  try {
    const items = await getNews(topic, tickers);
    res.status(200).json({ topic, count: items.length, items });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
