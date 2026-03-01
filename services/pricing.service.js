// services/pricing.service.js
const scrydexService = require("./scrydex.service");

// ─── Buy Rate ─────────────────────────────────────────────────────────────────

function getBuyRate(category, buyRates) {
  const rate = buyRates[category] ?? buyRates["default"];
  if (rate == null) {
    throw new Error(
      `No buy rate for category "${category}" in Firestore settings/buyRates`,
    );
  }
  return rate;
}

// ─── Card Number Parser ───────────────────────────────────────────────────────

// Matches: GG28/GG70 | GG28 | 060/172 | 060 | TG18/TG30 | TG18
const CARD_NUM_REGEX = /\b([A-Z]{0,3}\d{1,3}(?:\/[A-Z]{0,3}\d{1,3})?)\b/;

/**
 * parseCardName — splits "Duskull GG28" into:
 *   { cleanName: "Duskull", cardNumber: "GG28" }
 *
 * WHY: Scrydex mangles card numbers in search queries.
 *   "Duskull GG28" → Scrydex parses as name:"Duskull GG/GG" numbers:[28,70]
 *
 * FIX: strip the number before sending to Scrydex, then pass it to
 * pickBestCard() which uses it to select the correct print from results.
 */
function parseCardName(rawName) {
  if (!rawName) return { cleanName: rawName, cardNumber: null };
  const match = rawName.match(CARD_NUM_REGEX);
  if (!match) return { cleanName: rawName.trim(), cardNumber: null };
  const cardNumber = match[1];
  const cleanName = rawName
    .replace(match[0], "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { cleanName: cleanName || rawName.trim(), cardNumber };
}

// ─── Card Identity ────────────────────────────────────────────────────────────

function extractCardIdentity(card) {
  const image =
    card.images?.find((i) => i.type === "front")?.medium ??
    card.images?.[0]?.medium ??
    null;
  return {
    name: card.name ?? null,
    set: card.expansion?.name ?? null,
    setCode: card.expansion?.id ?? null,
    number: card.printed_number ?? card.number ?? null,
    rarity: card.rarity ?? null,
    imageUrl: image,
    scrydexId: card.id ?? null,
  };
}

// ─── Raw Price Extraction ─────────────────────────────────────────────────────

function normalizeCondition(condition) {
  const map = { NM: "NM", LP: "LP", MP: "MP", HP: "HP", DM: "DMG", DMG: "DMG" };
  return map[condition?.toUpperCase()] ?? "NM";
}

function extractRawPrices(card, targetCondition = "NM") {
  const allConditions = {};
  let bestPrice = null;
  let fallbackNM = null;

  for (const variant of card?.variants ?? []) {
    for (const entry of variant.prices ?? []) {
      if (entry.type === "graded") continue;
      const cond = normalizeCondition(entry.condition);
      const market = entry.market ?? entry.low ?? null;
      if (!market || market <= 0) continue;

      if (!allConditions[cond]) {
        allConditions[cond] = {
          market,
          low: entry.low ?? null,
          trends: entry.trends ?? null,
        };
      }
      if (cond === targetCondition && !bestPrice) {
        bestPrice = {
          market,
          condition: cond,
          low: entry.low,
          trends: entry.trends,
        };
      }
      if (cond === "NM" && !fallbackNM) {
        fallbackNM = {
          market,
          condition: "NM",
          low: entry.low,
          trends: entry.trends,
        };
      }
    }
  }

  return { best: bestPrice ?? fallbackNM, allConditions };
}

// ─── Sealed Price Extraction ──────────────────────────────────────────────────

function extractSealedPrice(sealedProduct) {
  let fallback = null;

  for (const variant of sealedProduct?.variants ?? []) {
    for (const entry of variant.prices ?? []) {
      const market = entry.market ?? entry.low ?? null;
      if (!market || market <= 0) continue;

      const price = {
        market,
        low: entry.low ?? null,
        trends: entry.trends ?? null,
        currency: entry.currency ?? "USD",
        variantName: variant.name,
        condition: entry.condition ?? null,
      };

      if (entry.condition === "U") return price;
      if (!fallback) fallback = price;
    }
  }

  return fallback;
}

// ─── Graded Price Extraction ──────────────────────────────────────────────────

function extractGradedPrice(card, gradeLabel) {
  const allPrices = (card?.variants ?? []).flatMap((v) => v.prices ?? []);
  const gradedPrices = allPrices.filter((p) => p.type === "graded");
  if (!gradedPrices.length) return null;

  const parts = gradeLabel.trim().split(/\s+/);
  const targetCompany = parts[0].toUpperCase();
  const targetGrade = parts.slice(1).join(" ").toLowerCase().trim();

  const match = gradedPrices.find((p) => {
    const company = p.company?.toUpperCase();
    const grade = String(p.grade ?? "")
      .toLowerCase()
      .trim();
    const isPerfect = p.is_perfect ?? false;
    if (company !== targetCompany) return false;
    if (grade === targetGrade) return true;
    if (targetGrade === "pristine" && isPerfect) return true;
    if (targetGrade === "black label" && isPerfect && company === "BGS")
      return true;
    return false;
  });

  if (!match) return null;
  return {
    market: match.market ?? null,
    low: match.low ?? null,
    mid: match.mid ?? null,
    high: match.high ?? null,
    trends: match.trends ?? null,
    currency: match.currency ?? "USD",
  };
}

function buildGradeBreakdown(card, graderKey, buyRate) {
  const allPrices = (card?.variants ?? []).flatMap((v) => v.prices ?? []);
  const gradedPrices = allPrices.filter(
    (p) => p.type === "graded" && p.company?.toUpperCase() === graderKey,
  );
  if (!gradedPrices.length) return [];

  const sorted = [...gradedPrices].sort((a, b) => {
    if (a.is_perfect && !b.is_perfect) return -1;
    if (!a.is_perfect && b.is_perfect) return 1;
    return (parseFloat(b.grade) || 0) - (parseFloat(a.grade) || 0);
  });

  return sorted.map((p) => {
    const gradeLabel = p.is_perfect
      ? graderKey === "BGS"
        ? "Black Label"
        : "Pristine"
      : String(p.grade);
    const marketValue = p.market ?? null;
    const shopOffer = marketValue
      ? parseFloat((marketValue * buyRate).toFixed(2))
      : null;
    return {
      grade: `${graderKey} ${gradeLabel}`,
      short: gradeLabel,
      company: graderKey,
      marketValue,
      low: p.low ?? null,
      mid: p.mid ?? null,
      high: p.high ?? null,
      shopOffer,
      isSpecial: p.is_perfect ?? false,
      trends: p.trends ?? null,
      currency: p.currency ?? "USD",
    };
  });
}

function buildAllGradeBreakdowns(card, buyRate) {
  const availableGraders = getAvailableGraders(card);
  const breakdown = [];
  for (const graderKey of availableGraders) {
    breakdown.push(...buildGradeBreakdown(card, graderKey, buyRate));
  }
  return breakdown;
}

function getAvailableGraders(card) {
  const allPrices = (card?.variants ?? []).flatMap((v) => v.prices ?? []);
  return [
    ...new Set(
      allPrices
        .filter((p) => p.type === "graded")
        .map((p) => p.company?.toUpperCase())
        .filter(Boolean),
    ),
  ];
}

// ─── Recent Sales ─────────────────────────────────────────────────────────────

async function getRecentSales(cardId, filters = {}) {
  try {
    const { days = 90, company, grade, condition, variant } = filters;
    const listingsResult = await scrydexService.getCardListings(cardId, {
      days,
      page_size: 10,
      company,
      grade,
      condition,
      variant,
    });

    return (listingsResult?.data ?? []).map((listing) => ({
      id: listing.id,
      source: listing.source,
      title: listing.title,
      url: listing.url,
      price: listing.price,
      currency: listing.currency ?? "USD",
      soldAt: listing.sold_at,
      variant: listing.variant,
      company: listing.company,
      grade: listing.grade,
      isPerfect: listing.is_perfect,
      isSigned: listing.is_signed,
      isError: listing.is_error,
    }));
  } catch (err) {
    console.warn("⚠️  Listings fetch failed:", err.message);
    return [];
  }
}

// ─── Card Picker ──────────────────────────────────────────────────────────────

/**
 * pickBestCard — selects the best Scrydex result.
 *
 * Priority:
 *  1. Card number exact match — "GG28" matches printed_number "GG28" or "GG28/GG70"
 *  2. Exact name + set name
 *  3. Name contains + set name
 *  4. Exact name only
 *  5. Name contains only
 *  6. First result
 *
 * cardNumber is extracted by parseCardName() BEFORE the Scrydex search,
 * so it is never sent in the query string (which Scrydex mangles).
 */
function pickBestCard(results, cardName, setName, cardNumber = null) {
  if (!results?.length) return null;

  const nameLower = cardName.toLowerCase().trim();
  const setLower = setName?.toLowerCase().trim() ?? "";

  // 1. Card number match — most precise signal
  if (cardNumber) {
    const numNorm = cardNumber.replace(/^0+/, "").toLowerCase();
    const byNumber = results.find((c) => {
      const cn = (c.printed_number ?? c.number ?? "")
        .replace(/^0+/, "")
        .toLowerCase();
      return cn === numNorm || cn.startsWith(numNorm + "/");
    });
    if (byNumber) {
      console.log(
        `🎯 Picked by card number: ${byNumber.name} #${byNumber.printed_number ?? byNumber.number}`,
      );
      return byNumber;
    }
    console.log(
      `⚠️  Card number "${cardNumber}" not in Scrydex results — falling back to name match`,
    );
  }

  // 2. Exact name + set
  if (setLower) {
    const exactWithSet = results.find(
      (c) =>
        c.name?.toLowerCase().trim() === nameLower &&
        c.expansion?.name?.toLowerCase().includes(setLower),
    );
    if (exactWithSet) return exactWithSet;

    const containsWithSet = results.find(
      (c) =>
        c.name?.toLowerCase().includes(nameLower) &&
        c.expansion?.name?.toLowerCase().includes(setLower),
    );
    if (containsWithSet) return containsWithSet;
  }

  // 3. Exact name
  const exactName = results.find(
    (c) => c.name?.toLowerCase().trim() === nameLower,
  );
  if (exactName) return exactName;

  // 4. Name contains
  const contains = results.find((c) =>
    c.name?.toLowerCase().includes(nameLower),
  );
  if (contains) return contains;

  return results[0];
}

function calcConfidence(points) {
  if (points >= 4) return "high";
  if (points >= 2) return "medium";
  if (points >= 1) return "low";
  return "none";
}

// ─── Public: Raw Card Market Value ────────────────────────────────────────────

async function getRawMarketValue({
  cardName,
  condition = "NM",
  category = "pokemon-singles",
  setName = null,
  localCardId = null,
  buyRates,
  includeListings = true,
  listingDays = 90,
}) {
  const buyRate = getBuyRate(category, buyRates);

  // Strip card number before Scrydex — Scrydex mangles "Duskull GG28"
  // into name:"Duskull GG/GG" which returns wrong results.
  // We use cardNumber in pickBestCard() instead.
  const { cleanName, cardNumber } = parseCardName(cardName);

  console.log(
    `\n🏷️  getRawMarketValue: "${cleanName}"${cardNumber ? ` #${cardNumber}` : ""} | ${category} | ${(buyRate * 100).toFixed(0)}% | ${condition}`,
  );

  let scrydexPoints = 0;
  let scrydexMarket = null;
  let allConditionPrices = {};
  let priceTrends = null;
  let recentSales = [];
  let cardIdentity = {
    name: cleanName,
    set: setName,
    setCode: null,
    number: cardNumber,
    rarity: null,
    imageUrl: null,
    scrydexId: null,
  };

  try {
    let card = null;

    if (localCardId) {
      card = await scrydexService.getCardWithPrices(localCardId);
    } else {
      // Send cleanName only — cardNumber handled post-search in pickBestCard
      const searchResult = await scrydexService.searchCards(cleanName, true);
      const results = searchResult?.data ?? [];
      card = pickBestCard(results, cleanName, setName, cardNumber);
    }

    if (card) {
      cardIdentity = extractCardIdentity(card);
      console.log(
        `✅ "${card.name}" | ${card.expansion?.name} | #${card.printed_number ?? card.number}`,
      );

      const { best, allConditions } = extractRawPrices(card, condition);
      allConditionPrices = Object.fromEntries(
        Object.entries(allConditions).map(([k, v]) => [k, v.market]),
      );

      if (best?.market > 0) {
        scrydexMarket = best.market;
        priceTrends = best.trends;
        scrydexPoints = 1;
        console.log(
          `💰 $${scrydexMarket} (${condition}) | conditions: ${JSON.stringify(allConditionPrices)}`,
        );
      } else {
        console.log(`⚠️  No raw price data`);
      }

      if (includeListings && card.id) {
        recentSales = await getRecentSales(card.id, { days: listingDays });
        console.log(`🛍️  ${recentSales.length} recent sales found`);
      }
    }
  } catch (err) {
    console.warn("⚠️  Scrydex error:", err.message);
  }

  const marketValue = scrydexMarket ?? 0;
  const shopOffer =
    marketValue > 0 ? parseFloat((marketValue * buyRate).toFixed(2)) : 0;

  return {
    pricing: {
      marketValue,
      shopOffer,
      buyRate,
      buyRatePercent: `${(buyRate * 100).toFixed(0)}%`,
      spread: parseFloat((marketValue - shopOffer).toFixed(2)),
      confidence: calcConfidence(scrydexPoints),
      totalPricePoints: scrydexPoints,
      conditionPrices: allConditionPrices,
      trends: priceTrends,
      recentSales,
      sources: { scrydex: { points: scrydexPoints } },
    },
    card: cardIdentity,
  };
}

// ─── Public: Graded Card Market Value ─────────────────────────────────────────

async function getGradedMarketValue({
  cardName,
  grade,
  setName = null,
  localCardId = null,
  category = "graded-card",
  buyRates,
  includeListings = true,
  listingDays = 90,
}) {
  const buyRate = getBuyRate(category, buyRates);
  const graderKey = grade.split(" ")[0].toUpperCase();
  const gradeNumber = grade.split(" ").slice(1).join(" ");

  // Strip card number before Scrydex
  const { cleanName, cardNumber } = parseCardName(cardName);

  console.log(
    `\n🏅 getGradedMarketValue: "${cleanName}"${cardNumber ? ` #${cardNumber}` : ""} | ${grade} | ${(buyRate * 100).toFixed(0)}%`,
  );

  let scrydexPoints = 0;
  let scrydexMarket = null;
  let gradeBreakdown = [];
  let availableGraders = [];
  let priceTrends = null;
  let recentSales = [];
  let cardIdentity = {
    name: cleanName,
    set: setName,
    setCode: null,
    number: cardNumber,
    rarity: null,
    imageUrl: null,
    scrydexId: null,
  };

  try {
    let card = null;

    if (localCardId) {
      card = await scrydexService.getCardWithPrices(localCardId);
    } else {
      const searchResult = await scrydexService.searchCards(cleanName, true);
      const results = searchResult?.data ?? [];
      card = pickBestCard(results, cleanName, setName, cardNumber);
    }

    if (card) {
      cardIdentity = extractCardIdentity(card);
      availableGraders = getAvailableGraders(card);
      console.log(
        `✅ "${card.name}" | graders: ${availableGraders.join(", ") || "none"}`,
      );

      const priceData = extractGradedPrice(card, grade);
      if (priceData?.market > 0) {
        scrydexMarket = priceData.market;
        priceTrends = priceData.trends;
        scrydexPoints = 1;
        console.log(
          `💰 ${grade}: $${scrydexMarket} | low: $${priceData.low} | mid: $${priceData.mid} | high: $${priceData.high}`,
        );
      } else {
        console.log(
          `⚠️  No ${grade} price — available: ${availableGraders.join(", ") || "none"}`,
        );
      }

      gradeBreakdown = buildAllGradeBreakdowns(card, buyRate);
      console.log(
        `📊 Total breakdown: ${gradeBreakdown.length} grades across ${availableGraders.length} graders`,
      );

      if (includeListings && card.id) {
        recentSales = await getRecentSales(card.id, {
          days: listingDays,
          company: graderKey,
          grade: gradeNumber,
        });
        console.log(`🛍️  ${recentSales.length} recent ${grade} sales found`);
      }
    }
  } catch (err) {
    console.warn("⚠️  Scrydex error:", err.message);
  }

  const marketValue = scrydexMarket ?? 0;
  const shopOffer =
    marketValue > 0 ? parseFloat((marketValue * buyRate).toFixed(2)) : 0;

  return {
    pricing: {
      marketValue,
      shopOffer,
      buyRate,
      buyRatePercent: `${(buyRate * 100).toFixed(0)}%`,
      spread: parseFloat((marketValue - shopOffer).toFixed(2)),
      confidence: calcConfidence(scrydexPoints),
      totalPricePoints: scrydexPoints,
      trends: priceTrends,
      recentSales,
      sources: { scrydex: { points: scrydexPoints } },
      gradeBreakdown: gradeBreakdown.length ? gradeBreakdown : undefined,
      availableGraders,
      grader: graderKey,
    },
    card: cardIdentity,
  };
}

// ─── Public: Sealed Product Market Value ──────────────────────────────────────

async function getSealedMarketValue({
  productName,
  category = "modern-booster",
  localSealedId = null,
  expansionId = null,
  buyRates,
  includeListings = false,
  listingDays = 90,
}) {
  const buyRate = getBuyRate(category, buyRates);
  console.log(
    `\n📦 getSealedMarketValue: "${productName}" | ${category} | ${(buyRate * 100).toFixed(0)}%`,
  );

  let scrydexMarket = null;
  let scrydexLow = null;
  let priceTrends = null;
  let productIdentity = {
    name: productName,
    set: null,
    type: null,
    imageUrl: null,
    scrydexId: null,
  };

  try {
    let product = null;

    if (localSealedId) {
      product = await scrydexService.getSealed(localSealedId, true);
    } else {
      const words = productName.trim().split(/\s+/);
      const q =
        words.length > 1
          ? `name:"${productName.trim()}"`
          : `name:${productName.trim()}`;

      const searchResult = await scrydexService.searchSealed({
        q,
        page_size: 10,
        includePrices: true,
        expansionId,
      });

      let results = searchResult?.data ?? [];

      if (results.length === 0) {
        const firstKeyword = productName.trim().split(/\s+/)[0];
        const fallbackResult = await scrydexService.searchSealed({
          q: `name:${firstKeyword}*`,
          page_size: 20,
          includePrices: true,
          expansionId,
        });
        results = fallbackResult?.data ?? [];
      }

      const nameLower = productName.toLowerCase().trim();
      product =
        results.find((p) => p.name?.toLowerCase().trim() === nameLower) ??
        results.find((p) => p.name?.toLowerCase().includes(nameLower)) ??
        results[0] ??
        null;
    }

    if (product) {
      const image =
        product.images?.find((i) => i.type === "front")?.medium ??
        product.images?.[0]?.medium ??
        null;

      productIdentity = {
        name: product.name ?? null,
        set: product.expansion?.name ?? null,
        setCode: product.expansion?.id ?? null,
        type: product.type ?? null,
        imageUrl: image,
        scrydexId: product.id ?? null,
      };

      console.log(
        `✅ "${product.name}" | ${product.expansion?.name} | type: ${product.type}`,
      );

      const priceData = extractSealedPrice(product);
      if (priceData?.market > 0) {
        scrydexMarket = priceData.market;
        scrydexLow = priceData.low;
        priceTrends = priceData.trends;
        console.log(`💰 $${scrydexMarket} (low: $${scrydexLow})`);
      } else {
        console.log(`⚠️  No sealed pricing data`);
      }
    }
  } catch (err) {
    if (err?.message?.includes("404")) {
      console.warn(
        "⚠️  Scrydex sealed 404 — check if your plan includes sealed access.",
      );
    } else {
      console.warn("⚠️  Scrydex sealed error:", err.message);
    }
  }

  const marketValue = scrydexMarket ?? 0;
  const shopOffer =
    marketValue > 0 ? parseFloat((marketValue * buyRate).toFixed(2)) : 0;

  return {
    pricing: {
      marketValue,
      shopOffer,
      buyRate,
      buyRatePercent: `${(buyRate * 100).toFixed(0)}%`,
      spread: parseFloat((marketValue - shopOffer).toFixed(2)),
      low: scrydexLow,
      confidence: marketValue > 0 ? "low" : "none",
      trends: priceTrends,
      sources: { scrydex: { points: marketValue > 0 ? 1 : 0 } },
    },
    product: productIdentity,
  };
}

module.exports = {
  getRawMarketValue,
  getGradedMarketValue,
  getSealedMarketValue,
};
