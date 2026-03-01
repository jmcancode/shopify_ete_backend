// services/scrydex.service.js
// Single source of truth for all Scrydex API calls.
// Covers: cards, expansions, sealed products, listings (recent sales).

const { scrydexFetch } = require("./scrydexClient.js");
// const { redis, redisGet, redisSet } = require("./redisClient"); // ← Redis disabled temporarily

const cacheKey = (k) => `scrydex:${k}`;

// ─── Redis Helpers (DISABLED) ──────────────────────────────────────────────────

const safeRedisGet = async (key) => {
  return null; // Redis disabled — always fetch fresh from Scrydex
};

const safeRedisSet = async (key, value, ttl) => {
  return; // Redis disabled — skip caching
};

// ─── Cards ─────────────────────────────────────────────────────────────────────

async function getCard(id) {
  const key = cacheKey(`card:${id}`);
  const cached = await safeRedisGet(key);
  if (cached) return cached;

  const data = await scrydexFetch(`/cards/${id}`);
  const card = data?.data ?? data;
  await safeRedisSet(key, card, 3600);
  return card;
}

async function getCardWithPrices(id) {
  const key = cacheKey(`card:prices:${id}`);
  const cached = await safeRedisGet(key);
  if (cached) return cached;

  const data = await scrydexFetch(`/cards/${id}?include=prices`);
  const card = data?.data ?? data;
  await safeRedisSet(key, card, 1800);
  return card;
}

/**
 * Search cards by name.
 * @param {string} query - Card name to search
 * @param {boolean} includePrices - Whether to include pricing data
 * @param {number} pageSize - Results per page (max 100)
 */
async function searchCards(query = "", includePrices = false, pageSize = 50) {
  if (!query?.trim()) return { data: [], total: 0 };

  const trimmed = query.trim();
  const encoded = encodeURIComponent(trimmed);
  const key = cacheKey(
    `search:${encoded}:${includePrices ? "prices" : "basic"}:${pageSize}`,
  );

  const cached = await safeRedisGet(key);
  if (cached) return cached;

  console.log(
    `🌐 Scrydex card search: "${trimmed}"${includePrices ? " +prices" : ""}`,
  );
  const endpoint = `/cards?q=${encoded}&page_size=${pageSize}${includePrices ? "&include=prices" : ""}`;
  const data = await scrydexFetch(endpoint);
  await safeRedisSet(key, data, 600);
  return data;
}

// ─── Expansions ────────────────────────────────────────────────────────────────

async function getExpansion(id) {
  const key = cacheKey(`expansion:${id}`);
  const cached = await safeRedisGet(key);
  if (cached) return cached;

  const data = await scrydexFetch(`/expansions/${id}`);
  const expansion = data?.data ?? data;
  await safeRedisSet(key, expansion, 3600);
  return expansion;
}

async function getExpansionsList(params = {}) {
  const { page_size = 100, page = 1, q, orderBy } = params;
  let queryParams = `page_size=${page_size}&page=${page}`;
  if (q) queryParams += `&q=${encodeURIComponent(q)}`;
  if (orderBy) queryParams += `&orderBy=${orderBy}`;

  const key = cacheKey(`expansions:list:${queryParams}`);
  const cached = await safeRedisGet(key);
  if (cached) return cached;

  console.log(`🌐 Scrydex expansions list: ${queryParams}`);
  const data = await scrydexFetch(`expansions?${queryParams}`);
  await safeRedisSet(key, data, 86400);
  return data;
}

async function getExpansionCards(expansionId, params = {}) {
  const { page_size = 100, page = 1 } = params;
  const queryParams = `page_size=${page_size}&page=${page}`;
  const key = cacheKey(`expansion:${expansionId}:cards:${queryParams}`);
  const cached = await safeRedisGet(key);
  if (cached) return cached;

  console.log(`🌐 Scrydex expansion cards: ${expansionId}`);
  const data = await scrydexFetch(
    `expansions/${expansionId}/cards?${queryParams}`,
  );
  await safeRedisSet(key, data, 3600);
  return data;
}

// ─── Sealed Products ───────────────────────────────────────────────────────────

async function getSealed(id, includePrices = false) {
  const key = cacheKey(`sealed:${id}:${includePrices ? "prices" : "basic"}`);
  const cached = await safeRedisGet(key);
  if (cached) return cached;

  console.log(
    `🌐 Scrydex sealed product: ${id}${includePrices ? " +prices" : ""}`,
  );
  const endpoint = `sealed/${id}${includePrices ? "?include=prices" : ""}`;
  const data = await scrydexFetch(endpoint);
  const product = data?.data ?? data;
  await safeRedisSet(key, product, includePrices ? 1800 : 3600);
  return product;
}

async function searchSealed(params = {}) {
  const {
    q,
    page = 1,
    page_size = 100,
    includePrices = false,
    expansionId,
    orderBy,
  } = params;

  const parts = [`page_size=${page_size}`, `page=${page}`];
  if (q) parts.push(`q=${q}`);
  if (orderBy) parts.push(`orderBy=${orderBy}`);
  if (includePrices) parts.push(`include=prices`);
  const queryString = parts.join("&");

  const baseEndpoint = expansionId
    ? `expansions/${expansionId}/sealed`
    : `sealed`;

  const key = cacheKey(
    `sealed:search:${expansionId ?? "all"}:${encodeURIComponent(q ?? "")}:p${page}:ps${page_size}:${includePrices}`,
  );
  const cached = await safeRedisGet(key);
  if (cached) return cached;

  console.log(`🌐 Scrydex sealed search: ${baseEndpoint}?${queryString}`);
  const data = await scrydexFetch(`${baseEndpoint}?${queryString}`);
  await safeRedisSet(key, data, includePrices ? 1800 : 21600);
  return data;
}

async function getAllSealedProducts(searchQuery = null) {
  const cacheKeySuffix = searchQuery
    ? `all:q:${encodeURIComponent(searchQuery)}`
    : "all";
  const key = cacheKey(`sealed:${cacheKeySuffix}`);

  const cached = await safeRedisGet(key);
  if (cached) {
    console.log(`✅ Cached ALL sealed products (${cached.totalCount} items)`);
    return cached;
  }

  console.log(
    `🌐 Fetching ALL sealed products${searchQuery ? ` q="${searchQuery}"` : ""}...`,
  );

  let allProducts = [];
  let currentPage = 1;
  const pageSize = 100;
  let hasMore = true;

  while (hasMore) {
    const parts = [`page_size=${pageSize}`, `page=${currentPage}`];
    if (searchQuery) parts.push(`q=${searchQuery}`);
    const queryParams = parts.join("&");

    console.log(`📄 Page ${currentPage}...`);
    const data = await scrydexFetch(`sealed?${queryParams}`);
    const products = data.data || [];
    allProducts = [...allProducts, ...products];

    console.log(
      `   ✓ ${products.length} products (total: ${allProducts.length})`,
    );
    hasMore = products.length === pageSize;
    currentPage++;

    if (currentPage > 10) {
      console.warn("⚠️  Stopped at 10 pages");
      break;
    }
  }

  const result = {
    data: allProducts,
    totalCount: allProducts.length,
    pages: currentPage - 1,
  };
  await safeRedisSet(key, result, 43200);
  return result;
}

// ─── Listings (Recent Sales) ───────────────────────────────────────────────────

async function getCardListings(cardId, params = {}) {
  const {
    days = 90,
    page_size = 10,
    page = 1,
    company,
    grade,
    condition,
    source,
    variant,
  } = params;

  let queryParams = `page_size=${page_size}&page=${page}&days=${days}`;
  if (company) queryParams += `&company=${encodeURIComponent(company)}`;
  if (grade) queryParams += `&grade=${encodeURIComponent(grade)}`;
  if (condition) queryParams += `&condition=${encodeURIComponent(condition)}`;
  if (source) queryParams += `&source=${encodeURIComponent(source)}`;
  if (variant) queryParams += `&variant=${encodeURIComponent(variant)}`;

  const key = cacheKey(`listings:${cardId}:${queryParams}`);
  const cached = await safeRedisGet(key);
  if (cached) return cached;

  console.log(`🌐 Scrydex listings for card ${cardId}: ${queryParams}`);
  const data = await scrydexFetch(`/cards/${cardId}/listings?${queryParams}`);
  await safeRedisSet(key, data, 900);
  return data;
}

async function getListing(listingId) {
  const key = cacheKey(`listing:${listingId}`);
  const cached = await safeRedisGet(key);
  if (cached) return cached;

  console.log(`🌐 Scrydex listing: ${listingId}`);
  const data = await scrydexFetch(`/listings/${listingId}`);
  await safeRedisSet(key, data, 3600);
  return data;
}

// ─── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Cards
  getCard,
  getCardWithPrices,
  searchCards,

  // Expansions
  getExpansion,
  getExpansionsList,
  getExpansionCards,

  // Sealed
  getSealed,
  searchSealed,
  getAllSealedProducts,

  // Listings
  getCardListings,
  getListing,

  // Direct fetch for edge cases
  scrydexFetch,
};
