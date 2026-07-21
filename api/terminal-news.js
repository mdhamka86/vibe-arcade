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
    'FX analysis EURUSD OR GBPUSD OR USDJPY',
    'central bank rate decision currency',
    'US dollar index DXY move',
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
  // returns { items, health } so callers can SEE whether a feed actually delivered,
  // rather than a silent [] hiding a 404/timeout (audit finding 5).
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (TheTerminal/1.0)' } });
    if (!r.ok) return { items: [], health: { source: srcName || url, ok: false, status: r.status, count: 0 } };
    const items = parseRSS(await r.text(), srcName);
    return { items, health: { source: srcName || url, ok: true, status: 200, count: items.length } };
  } catch (e) {
    return { items: [], health: { source: srcName || url, ok: false, status: 'error', count: 0, err: String(e).slice(0, 60) } };
  }
}

async function fetchFeed(q) {
  return fetchXml(
    'https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:2d') + '&hl=en-SG&gl=SG&ceid=SG:en',
    'GoogleNews'
  );
}

// Direct publisher feeds for the forex digest — a WIDE net so convergence is meaningful.
// Each is optional and independent: a dead feed reports ok:false in health and the merge
// carries on; we do NOT delete a feed just because it's down today (feeds recover). Only
// sources with a real, fetchable RSS/XML feed belong here — interactive/paywalled platforms
// (TradingView, Bloomberg Terminal, IG sentiment, COT dashboards, YouTube, etc.) can't be
// auto-fetched and are deliberately NOT claimed as coverage.
const DIRECT_FOREX_FEEDS = [
  ['https://www.forexlive.com/feed', 'ForexLive'],
  ['https://www.forexlive.com/feed/centralbank', 'ForexLive CB'],
  ['https://www.fxstreet.com/rss/news', 'FXStreet'],
  ['https://www.actionforex.com/feed', 'ActionForex'],
  ['https://www.myfxbook.com/rss/latest-forex-news', 'Myfxbook'],
  ['https://www.dailyforex.com/rss/forexnews.xml', 'DailyForex'],
  ['https://www.dailyfx.com/feeds/market-news', 'DailyFX'],
  ['https://www.fxempire.com/api/v1/en/articles/rss/news', 'FXEmpire'],
  ['https://www.investing.com/rss/news_1.rss', 'Investing.com'],
  ['https://www.investing.com/rss/news_285.rss', 'Investing FX'],
  ['https://www.financemagnates.com/feed/', 'FinanceMagnates'],
  ['https://invezz.com/feed/', 'Invezz'],
  ['https://www.babypips.com/feed.rss', 'BabyPips'],
  ['https://www.marketpulse.com/feed/', 'OANDA MarketPulse'],
  ['https://www.kitco.com/rss/news.xml', 'Kitco'],
  ['https://tradingeconomics.com/rss/news.aspx', 'TradingEconomics'],
  ['https://feeds.marketwatch.com/marketwatch/topstories/', 'MarketWatch'],
  ['https://www.cnbc.com/id/100003114/device/rss/rss.html', 'CNBC'],
  ['https://feeds.content.dowjones.io/public/rss/RSSMarketsMain', 'WSJ Markets'],
  ['https://www.fxstreet.com/rss/analysis', 'FXStreet Analysis'],
  ['https://www.tradingview.com/feed/', 'TradingView Ideas'],
  ['https://www.actionforex.com/technical-analysis/feed/', 'ActionForex TA'],
  ['https://www.forexcrunch.com/feed/', 'ForexCrunch'],
  ['https://www.financemagnates.com/forex/feed/', 'FinanceMagnates FX'],
  ['https://www.fxempire.com/api/v1/en/articles/rss/forecasts', 'FXEmpire Forecasts'],
];

// TradingView also exposes PER-SYMBOL idea feeds (real trader pattern setups), fetchable as
// https://www.tradingview.com/feed/?symbol=EURUSD . Used for targeted, pair-specific pattern
// research when the desk is weighing a particular pair (audit finding 4).
export async function getSymbolIdeas(symbol) {
  const sym = (symbol || '').replace(/[^A-Za-z]/g, '').toUpperCase();
  if (!sym) return [];
  const { items } = await fetchXml('https://www.tradingview.com/feed/?symbol=' + sym, 'TradingView ' + sym);
  return items;
}

export async function getNews(topic, tickers) {
  let queries;
  if (topic === 'markets') {
    const list = (tickers || 'CRDO,CAMT').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 14);
    queries = [];
    for (let i = 0; i < list.length; i += 4) {
      queries.push(list.slice(i, i + 4).map((t) => `"${t}" stock`).join(' OR '));
    }
  } else {
    queries = TOPIC_QUERIES[topic] || TOPIC_QUERIES.football;
  }
  // each fetch now returns { items, health }; collect both
  const fetches = await Promise.all([
    ...queries.map(fetchFeed),
    ...(topic === 'forex' ? DIRECT_FOREX_FEEDS.map(([u, n]) => fetchXml(u, n)) : []),
  ]);
  const health = fetches.map((f) => f.health).filter(Boolean);

  // ROBUST DEDUP (audit finding 4): the old 60-char-prefix check let reworded syndications of
  // one story survive as separate items, faking convergence. We now (a) strip the trailing
  // "- Source" suffix, (b) key on a normalized full-title signature, and (c) catch near-dupes
  // by comparing significant-word sets — two headlines sharing most of their meaningful words
  // are treated as the SAME underlying story, so syndication can't inflate source diversity.
  const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'as', 'at', 'is', 'are', 'by', 'with', 'from', 'after', 'amid', 'over', 'its', 'this', 'that', 'steady', 'unchanged', 'keeps', 'holds', 'hold', 'kept']);
  // normalize common finance abbreviations so "ECB" and "european central bank" match, etc.
  const ABBR = [
    [/\beuropean central bank\b/g, 'ecb'], [/\bbank of japan\b/g, 'boj'],
    [/\bbank of england\b/g, 'boe'], [/\bfederal reserve\b/g, 'fed'],
    [/\breserve bank of australia\b/g, 'rba'], [/\bswiss national bank\b/g, 'snb'],
    [/\bbank of canada\b/g, 'boc'], [/\bpercent\b/g, '%'],
  ];
  const canon = (title) => {
    let t = (title || '').toLowerCase().replace(/\s+-\s+[^-]+$/, ''); // drop "- Source"
    for (const [re, r] of ABBR) t = t.replace(re, r);
    return t;
  };
  const sigWords = (title) => new Set(
    canon(title).replace(/[^a-z0-9%. ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w))
  );
  // pull distinctive numbers (rates, levels like 2.25 or 162) — a shared number is a strong
  // same-story signal that survives rewording.
  const nums = (title) => new Set((canon(title).match(/\d+(?:\.\d+)?/g) || []));
  const overlap = (a, b) => {
    if (!a.size || !b.size) return 0;
    let common = 0; for (const w of a) if (b.has(w)) common++;
    return common / Math.min(a.size, b.size);
  };
  const shareNum = (a, b) => { for (const n of a) if (b.has(n)) return true; return false; };
  const seenKeys = new Set();
  const kept = []; // {words, numbers}
  const merged = [];
  for (const item of fetches.flatMap((f) => f.items)) {
    const c = canon(item.title).replace(/[^a-z0-9]/g, '');
    if (!c || seenKeys.has(c)) continue;
    const words = sigWords(item.title);
    const numbers = nums(item.title);
    // same story if: high word overlap, OR (shared distinctive number AND moderate word overlap)
    const dupe = kept.some((k) => {
      const wo = overlap(words, k.words);
      return wo >= 0.7 || (shareNum(numbers, k.numbers) && wo >= 0.4);
    });
    if (dupe) continue;
    seenKeys.add(c);
    kept.push({ words, numbers });
    merged.push(item);
  }
  merged.sort((a, b) => b.ts - a.ts);
  const out = merged.slice(0, topic === 'forex' ? 60 : 30);
  Object.defineProperty(out, 'health', { value: health, enumerable: false });
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');
  const { topic = 'football', tickers = '' } = req.query;
  try {
    const items = await getNews(topic, tickers);
    res.status(200).json({ topic, count: items.length, health: items.health || [], items });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
