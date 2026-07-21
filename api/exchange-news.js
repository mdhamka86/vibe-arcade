// api/exchange-news.js
// THE EXCHANGE — equities news wire. Google News RSS + direct market feeds, dependency-free.
// A sibling to terminal-news.js, shaped for stocks rather than currencies.
//
// GET /api/exchange-news?scope=holdings&tickers=CRDO,CAMT,MRVL,NVDA
// GET /api/exchange-news?scope=market
// GET /api/exchange-news?scope=semis

// Broad thematic queries for the equities world. Semiconductors lead, since that is
// where the book's concentration genuinely lives.
const SCOPE_QUERIES = {
  market: [
    'US stock market today S&P 500 Nasdaq',
    'Federal Reserve rates stocks outlook',
    'earnings season results guidance',
  ],
  semis: [
    'semiconductor stocks Nvidia AMD chip',
    'semiconductor sector SMH earnings outlook',
    'chip stocks TSMC ASML memory demand',
  ],
  tech: [
    'US tech stocks Nasdaq megacap',
    'AI stocks datacenter demand',
  ],
  etf: [
    'ETF flows S&P 500 VOO SMH sector',
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

function parseRSS(xml, srcName) {
  const items = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const b of blocks) {
    const title = tag(b, 'title');
    if (!title) continue;
    items.push({
      title,
      link: tag(b, 'link'),
      source: srcName || tag(b, 'source') || (title.split(' - ').pop() || '').slice(0, 40),
      pubDate: tag(b, 'pubDate'),
      ts: Date.parse(tag(b, 'pubDate')) || 0,
      desc: tag(b, 'description').slice(0, 280),
    });
  }
  return items;
}

async function fetchXml(url, srcName) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (TheExchange/1.0)' } });
    if (!r.ok) return [];
    return parseRSS(await r.text(), srcName);
  } catch {
    return [];
  }
}

async function fetchFeed(q) {
  // US market focus: en-US locale gives more relevant financial coverage than en-SG
  return fetchXml(
    'https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:3d') + '&hl=en-US&gl=US&ceid=US:en'
  );
}

// A Google News RSS feed scoped to a single ticker/company, handy for per-holding trawls.
async function fetchTicker(ticker, name) {
  const q = name ? `"${name}" OR ${ticker} stock` : `${ticker} stock`;
  const items = await fetchFeed(q);
  // tag each item with the ticker it was fetched for, so the engine can group by holding
  return items.map((it) => ({ ...it, ticker }));
}

// Direct financial news feeds. Each is optional: a dead feed returns [] and the
// merge carries on. Google News queries remain the reliable backstop.
const DIRECT_MARKET_FEEDS = [
  ['https://feeds.a.dj.com/rss/RSSMarketsMain.xml', 'WSJ Markets'],
  ['https://www.cnbc.com/id/100003114/device/rss/rss.html', 'CNBC Markets'],
  ['https://www.cnbc.com/id/15839135/device/rss/rss.html', 'CNBC Tech'],
  ['https://seekingalpha.com/market_currents.xml', 'Seeking Alpha'],
  ['https://www.investing.com/rss/news_25.rss', 'Investing.com Stocks'],
];

export async function getNews(scope, tickers) {
  let feeds = [];

  if (scope === 'holdings' || (tickers && tickers.length)) {
    // per-ticker trawl: split the watchlist and fetch each name individually so the
    // engine gets genuine per-holding coverage rather than a blurred blob.
    const list = (tickers || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 18);
    feeds = list.map((entry) => {
      // allow "TICKER|Full Company Name" pairs for a sharper query
      const [tk, nm] = entry.split('|');
      return fetchTicker(tk.trim(), nm ? nm.trim() : null);
    });
    // market backdrop AND the direct premium feeds (audit finding 3): holdings/idea-hunting
    // mode previously skipped WSJ/CNBC/Seeking Alpha, so the desk hunted without the best
    // market coverage. Include them here too so convergence has real material to draw on.
    feeds.push(...SCOPE_QUERIES.market.map(fetchFeed));
    feeds.push(...DIRECT_MARKET_FEEDS.map(([u, n]) => fetchXml(u, n)));
  } else {
    const queries = SCOPE_QUERIES[scope] || SCOPE_QUERIES.market;
    feeds = [
      ...queries.map(fetchFeed),
      ...DIRECT_MARKET_FEEDS.map(([u, n]) => fetchXml(u, n)),
    ];
  }

  const results = await Promise.all(feeds);
  const seen = new Set();
  const merged = [];
  for (const item of results.flat()) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  merged.sort((a, b) => b.ts - a.ts);
  return merged.slice(0, 45);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');
  const { scope = 'market', tickers = '' } = req.query;
  try {
    const items = await getNews(scope, tickers);
    res.status(200).json({ scope, count: items.length, items });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
