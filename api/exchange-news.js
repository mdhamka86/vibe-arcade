// api/exchange-news.js
// THE EXCHANGE — equities news wire. Google News RSS + direct market feeds, dependency-free.
// A sibling to terminal-news.js, shaped for stocks rather than currencies.
//
// GET /api/exchange-news?scope=holdings&tickers=CRDO,CAMT,MRVL,NVDA
// GET /api/exchange-news?scope=market
// GET /api/exchange-news?scope=semis

// Broad thematic queries for the equities world. Semiconductors lead, since that is
// where the book's concentration genuinely lives.
// ASIAN COVERAGE ADDED 22/07/2026. Until now every source here was US or Western — three
// US thematic queries and five US/Western direct feeds — while the ideas prompt explicitly
// asks for at least one daytime-tradeable SGX/HKEX/Asian name on every hunt. The desk was
// being told to find Asian trades with literally no Asian coverage in front of it, so those
// picks were guesses dressed as research. Each Asian query is issued against its OWN Google
// News locale: an en-SG query returns Singapore market coverage that an en-US one simply
// does not surface.
const ASIA_QUERIES = [
  ['SGX Singapore stocks STI results', 'SG'],
  ['Hong Kong stocks Hang Seng HKEX earnings', 'HK'],
  ['Tokyo stocks Nikkei Japan earnings guidance', 'JP'],
  ['Bursa Malaysia stocks KLCI results', 'MY'],
  ['China A-shares Shanghai Shenzhen stocks', 'CN'],
];

// Google News locale per market. Verified live 22/07/2026 — each returns real, on-topic
// market coverage rather than an empty or US-shaped feed.
const LOCALES = {
  US: { hl: 'en-US', gl: 'US', ceid: 'US:en' },
  SG: { hl: 'en-SG', gl: 'SG', ceid: 'SG:en' },
  HK: { hl: 'en-HK', gl: 'HK', ceid: 'HK:en' },
  JP: { hl: 'en-US', gl: 'JP', ceid: 'JP:en' },
  MY: { hl: 'en-MY', gl: 'MY', ceid: 'MY:en' },
  CN: { hl: 'en-US', gl: 'CN', ceid: 'CN:en' },
};

const SCOPE_QUERIES = {
  market: [
    'US stock market today S&P 500 Nasdaq',
    'Federal Reserve rates stocks outlook',
    'earnings season results guidance',
  ],
  asia: [
    'Asia stock markets today',
    'Asian equities outlook Singapore Hong Kong Tokyo',
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

// How many items getNews hands back. Raised from 45 with the Asian desks (22/07/2026):
// the wire now carries two regions and the old cap would have spent most of itself on
// whichever one published fastest.
const LIMIT = 60;

async function fetchXml(url, srcName, region) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (TheExchange/1.0)' } });
    if (!r.ok) return [];
    const items = parseRSS(await r.text(), srcName);
    return region ? items.map((i) => ({ ...i, region })) : items;
  } catch {
    return [];
  }
}

// `region` selects the Google News locale. Defaults to US, which is right for US names and
// for the general market backdrop; Asian queries pass their own so the results are actually
// local coverage rather than whatever a US edition happens to say about Asia.
async function fetchFeed(q, region = 'US') {
  const L = LOCALES[region] || LOCALES.US;
  return fetchXml(
    'https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:3d')
    + `&hl=${L.hl}&gl=${L.gl}&ceid=${encodeURIComponent(L.ceid)}`,
    null,
    region === 'US' ? null : 'ASIA'
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

// Asian market desks. Every one of these was fetched and item-counted on 22/07/2026 before
// being added, rather than assumed from its URL shape — Nikkei Asia's advertised feed
// returns an empty document, and the Malaysian outlets' feeds 404, so neither is here.
// Malaysia and Japan are covered through their regional Google News locales instead.
const ASIA_MARKET_FEEDS = [
  ['https://www.businesstimes.com.sg/rss/companies-markets', 'Business Times SG'],
  ['https://www.straitstimes.com/news/business/rss.xml', 'Straits Times Business'],
  ['https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6936', 'CNA Business'],
  ['https://www.scmp.com/rss/92/feed', 'SCMP Business'],
  ['https://www.scmp.com/rss/4/feed', 'SCMP China Business'],
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
    feeds.push(...SCOPE_QUERIES.market.map((q) => fetchFeed(q, 'US')));
    feeds.push(...DIRECT_MARKET_FEEDS.map(([u, n]) => fetchXml(u, n)));
    // ...and the Asian desks, for the same reason: this is the mode the idea hunt runs in,
    // and it is the mode that is asked for an Asian name.
    feeds.push(...ASIA_QUERIES.map(([q, region]) => fetchFeed(q, region)));
    feeds.push(...ASIA_MARKET_FEEDS.map(([u, n]) => fetchXml(u, n, 'ASIA')));
  } else {
    const queries = SCOPE_QUERIES[scope] || SCOPE_QUERIES.market;
    feeds = [
      ...queries.map((q) => fetchFeed(q, 'US')),
      ...DIRECT_MARKET_FEEDS.map(([u, n]) => fetchXml(u, n)),
    ];
    if (scope === 'market' || scope === 'asia') {
      feeds.push(...ASIA_QUERIES.map(([q, region]) => fetchFeed(q, region)));
      feeds.push(...ASIA_MARKET_FEEDS.map(([u, n]) => fetchXml(u, n, 'ASIA')));
    }
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

  // REGIONAL BALANCE (22/07/2026). Adding Asian sources was not enough on its own: the
  // merged list is truncated by RECENCY and the US/Western desks publish far more volume,
  // so a straight cut would have handed the hunt an almost entirely US wire again and the
  // Asian feeds would have been decorative. Interleaving guarantees Asian coverage actually
  // reaches the prompt rather than being sorted off the end of it.
  const asia = merged.filter((i) => i.region === 'ASIA');
  const rest = merged.filter((i) => i.region !== 'ASIA');
  if (!asia.length || !rest.length) return merged.slice(0, LIMIT);
  const out = [];
  let ai = 0, ri = 0;
  while (out.length < LIMIT && (ai < asia.length || ri < rest.length)) {
    // roughly one Asian item per two others, each stream already newest-first
    if (ri < rest.length) out.push(rest[ri++]);
    if (out.length < LIMIT && ri < rest.length) out.push(rest[ri++]);
    if (out.length < LIMIT && ai < asia.length) out.push(asia[ai++]);
  }
  return out.slice(0, LIMIT);
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
