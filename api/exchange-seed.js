// exchange-seed.js
// A one-time seed of Hammy's genuine NOVA book, transcribed faithfully from the
// Phillip Nova platform screenshot dated 2026/07/07 21:45 (UTC+7).
//
// Figures are taken AS REPORTED by the platform (its Unrealised P/L already accounts
// for CFD financing/swap and SGD->USD conversion, which a naive price*qty would miss).
//
// HOW TO LOAD (once, after deploying the engine):
//   Call POST /api/exchange-engine  with  { "action": "seed" }
//   The engine writes this into exchange:book in Upstash Redis.
//   Safe to run once; running again simply overwrites the book with this snapshot.

export const SEED_BOOK = {
  netLiq: 3756.35,
  lastSync: '2026-07-07T14:45:09.000Z', // 21:45 BKK in UTC
  seededFrom: 'NOVA platform screenshot 2026/07/07 21:45 BKK',
  account: {
    ledgerBalance: 981.33,
    realizedPL: 0.00,
    unrealizedPL: -127.93,
    equityBalance: 853.40,
    initialMargin: 282.07,
    buyingPowerETD: 571.27,
    buyingPowerSecurities: 571.27,
    netLiquidityValue: 3756.35,
  },
  holdings: [
    // ---- Leveraged (CFD) positions ----
    { id: 'seed_mrvl', ticker: 'MARVELL', name: 'Marvell Technology Group', assetClass: 'CFD', leveraged: true, exchange: 'NASDAQ', qty: 1, avgCost: 285.19, lastPrice: 223.84, unrealised: -63.07, mentalTP: null, mentalSL: null },
    { id: 'seed_netapp', ticker: 'NETAPP', name: 'NetApp Inc', assetClass: 'CFD', leveraged: true, exchange: 'NASDAQ', qty: 2, avgCost: 182.97, lastPrice: 163.47, unrealised: -41.09, mentalTP: null, mentalSL: null },
    { id: 'seed_tsla', ticker: 'TSLA', name: 'Tesla Motors', assetClass: 'CFD', leveraged: true, exchange: 'NASDAQ', qty: 2, avgCost: 420.18, lastPrice: 408.34, unrealised: -23.83, mentalTP: null, mentalSL: null },

    // ---- Non-leveraged equities (EQ) ----
    { id: 'seed_amba', ticker: 'AMBA', name: 'Ambarella', assetClass: 'EQ', leveraged: false, exchange: 'NASDAQ', qty: 1, avgCost: 69.0299, lastPrice: 71.57, unrealised: 2.54, securitiesValue: 71.57, mentalTP: null, mentalSL: null },
    { id: 'seed_amd', ticker: 'AMD', name: 'AMD', assetClass: 'EQ', leveraged: false, exchange: 'NASDAQ', qty: 0.1, avgCost: 418.62, lastPrice: 503.48, unrealised: 8.49, securitiesValue: 50.35, mentalTP: null, mentalSL: null },
    { id: 'seed_camt', ticker: 'CAMT', name: 'Camtek', assetClass: 'EQ', leveraged: false, exchange: 'NASDAQ', qty: 2, avgCost: 165.67, lastPrice: 127.80, unrealised: -75.74, securitiesValue: 255.6, mentalTP: null, mentalSL: null },
    { id: 'seed_crdo', ticker: 'CRDO', name: 'Credo Technology', assetClass: 'EQ', leveraged: false, exchange: 'NASDAQ', qty: 1, avgCost: 241.6243, lastPrice: 236.00, unrealised: -5.62, securitiesValue: 236, mentalTP: null, mentalSL: null },
    { id: 'seed_mbly', ticker: 'MBLY', name: 'Mobileye Global-A', assetClass: 'EQ', leveraged: false, exchange: 'NASDAQ', qty: 10, avgCost: 9.5465, lastPrice: 9.89, unrealised: 3.44, securitiesValue: 98.9, mentalTP: null, mentalSL: null },
    { id: 'seed_mgni', ticker: 'MGNI', name: 'Magnite', assetClass: 'EQ', leveraged: false, exchange: 'NASDAQ', qty: 4, avgCost: 17.8295, lastPrice: 20.77, unrealised: 11.76, securitiesValue: 83.08, mentalTP: null, mentalSL: null },
    { id: 'seed_spcx', ticker: 'SPCX', name: 'Space Exploration Technologies (SpaceX)', assetClass: 'EQ', leveraged: false, exchange: 'NASDAQ', qty: 2, avgCost: 172.00, lastPrice: 150.91, unrealised: -42.18, securitiesValue: 301.82, mentalTP: null, mentalSL: null },
    { id: 'seed_cohr', ticker: 'COHR', name: 'Coherent', assetClass: 'EQ', leveraged: false, exchange: 'NYSE', qty: 1, avgCost: 361.9899, lastPrice: 305.75, unrealised: -56.24, securitiesValue: 305.75, mentalTP: null, mentalSL: null },
    { id: 'seed_c6l', ticker: 'C6L', name: 'Singapore Airlines (SIA)', assetClass: 'EQ', leveraged: false, exchange: 'SGX', qty: 100, avgCost: 6.50, lastPrice: 7.82, unrealised: 102.13, securitiesValue: 605.03, mentalTP: null, mentalSL: null },

    // ---- Non-leveraged funds (ETF) ----
    { id: 'seed_voo', ticker: 'VOO', name: 'Vanguard S&P 500 ETF (VOO-VGD)', assetClass: 'ETF', leveraged: false, exchange: 'NYSE Arca', qty: 0.1, avgCost: 677.32, lastPrice: 685.61, unrealised: 0.83, securitiesValue: 68.56, mentalTP: null, mentalSL: null },
    { id: 'seed_aiq', ticker: 'AIQ', name: 'Global X AI & Technology ETF', assetClass: 'ETF', leveraged: false, exchange: 'NASDAQ', qty: 2, avgCost: 61.4299, lastPrice: 61.49, unrealised: 0.12, securitiesValue: 122.98, mentalTP: null, mentalSL: null },
    { id: 'seed_smh', ticker: 'SMH', name: 'VanEck Semiconductor ETF (SMH-VEK)', assetClass: 'ETF', leveraged: false, exchange: 'NASDAQ', qty: 0.5, avgCost: 562.92, lastPrice: 567.42, unrealised: 2.25, securitiesValue: 283.71, mentalTP: null, mentalSL: null },
    { id: 'seed_es3', ticker: 'ES3', name: 'SPDR Straits Times Index ETF', assetClass: 'ETF', leveraged: false, exchange: 'SGX', qty: 100, avgCost: 5.068, lastPrice: 5.424, unrealised: 27.54, securitiesValue: 419.65, mentalTP: null, mentalSL: null },
  ],
  netLiqHistory: [
    { ts: '2026-07-07T14:45:09.000Z', netLiq: 3756.35 },
  ],
  pendingReview: [],
};

// The user's "propose" watchlist, seen on the NOVA watchlist tab. These are names he
// actively watches for fresh opportunities, useful context for the ideas engine.
export const SEED_WATCHLIST = [
  { ticker: 'MGNI', name: 'Magnite' },
  { ticker: 'ONTO', name: 'Onto Innovation' },
  { ticker: 'CAMT', name: 'Camtek' },
  { ticker: 'CRDO', name: 'Credo Technology' },
];
