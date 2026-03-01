const express = require("express");
const router = express.Router();
const axios = require("axios");
const admin = require("firebase-admin");

// ============================================================================
// AUTH MIDDLEWARE
// ============================================================================

const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ error: "Unauthorized", message: "No token provided" });
    }
    const token = authHeader.split("Bearer ")[1];
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = { uid: decodedToken.uid, email: decodedToken.email };
    next();
  } catch (error) {
    res
      .status(401)
      .json({ error: "Unauthorized", message: "Invalid or expired token" });
  }
};

// ============================================================================
// EBAY TOKEN CACHE
// Reuse the token until it expires — avoids hitting auth on every request
// ============================================================================

let ebayTokenCache = {
  token: null,
  expiresAt: 0,
};

const getEbayAccessToken = async () => {
  const now = Date.now();

  // Return cached token if still valid (with 60s buffer)
  if (ebayTokenCache.token && now < ebayTokenCache.expiresAt - 60_000) {
    return ebayTokenCache.token;
  }

  const credentials = Buffer.from(
    `${process.env.SANDBOX_EBAY_CLIENT_ID}:${process.env.SANDBOX_EBAY_CLIENT_SECRET}`,
  ).toString("base64");

  const response = await axios.post(
    "https://api.ebay.com/identity/v1/oauth2/token",
    "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
    },
  );

  ebayTokenCache = {
    token: response.data.access_token,
    expiresAt: now + response.data.expires_in * 1000,
  };

  console.log(
    "[eBay] Token refreshed, expires in",
    response.data.expires_in,
    "seconds",
  );
  return ebayTokenCache.token;
};

// ============================================================================
// HELPERS
// ============================================================================

const CATEGORY_RATE_MAP = {
  "pokemon-singles": "pokemon-singles",
  "graded-card": "graded-card",
  "one-piece": "one-piece",
  "sports-card": "raw-singles",
  "raw-singles": "raw-singles",
};

const LOT_KEYWORDS = [
  "lot",
  "bundle",
  "x10",
  "x5",
  "x4",
  "x3",
  "x2",
  "collection",
  "bulk",
  "set of",
  "pack of",
  "wholesale",
];

const isLotListing = (title = "") => {
  const lower = title.toLowerCase();
  return LOT_KEYWORDS.some((kw) => lower.includes(kw));
};

const buildSearchQuery = (cardName, category, condition) => {
  const base = cardName.trim();
  switch (category) {
    case "graded-card":
      return `${condition} ${base} card`;
    case "pokemon-singles":
      return `${base} pokemon card ${condition}`;
    case "one-piece":
      return `${base} one piece card ${condition}`;
    case "sports-card":
      return `${base} ${condition}`;
    default:
      return `${base} card ${condition}`;
  }
};

const getBuyRates = async () => {
  try {
    const db = admin.firestore();
    const doc = await db.collection("settings").doc("buyRates").get();
    if (doc.exists) return doc.data();
  } catch (e) {
    console.error("Failed to fetch buyRates:", e);
  }
  return {
    "pokemon-singles": 0.85,
    "graded-card": 0.7,
    "one-piece": 0.87,
    "raw-singles": 0.7,
    default: 0.7,
  };
};

// ============================================================================
// POST /api/card-price-check
// ============================================================================

router.post("/", verifyToken, async (req, res) => {
  try {
    const { cardName, category, condition } = req.body;

    // ── Validate ────────────────────────────────────────────────────────
    if (!cardName || cardName.trim().length < 2) {
      return res.status(400).json({
        error: "Bad Request",
        message: "cardName required (min 2 chars)",
      });
    }
    if (!category || !CATEGORY_RATE_MAP[category]) {
      return res.status(400).json({
        error: "Bad Request",
        message: `category must be one of: ${Object.keys(CATEGORY_RATE_MAP).join(", ")}`,
      });
    }
    if (!condition) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "condition is required" });
    }

    const searchQuery = buildSearchQuery(cardName.trim(), category, condition);
    console.log(`[card-price-check] query="${searchQuery}"`);

    // ── Get eBay token ───────────────────────────────────────────────────
    const accessToken = await getEbayAccessToken();

    // ── Search eBay Browse API ───────────────────────────────────────────
    const ebayResponse = await axios.get(
      "https://api.ebay.com/buy/browse/v1/item_summary/search",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        },
        params: {
          q: searchQuery,
          filter: "buyingOptions:{FIXED_PRICE},soldItems:true",
          sort: "NEWLY_LISTED",
          limit: 15, // fetch more so we have room to filter lots
          fieldgroups: "EXTENDED",
        },
      },
    );

    const rawItems = ebayResponse.data?.itemSummaries ?? [];

    // ── Filter ───────────────────────────────────────────────────────────
    const cleanItems = rawItems
      .filter((item) => {
        if (!item.price?.value) return false;
        if (isLotListing(item.title)) return false;
        if (parseFloat(item.price.value) < 0.99) return false;
        return true;
      })
      .slice(0, 5)
      .map((item) => ({
        title: item.title,
        price: parseFloat(item.price.value),
        currency: item.price.currency ?? "USD",
        condition: item.condition ?? null,
        thumbnail:
          item.thumbnailImages?.[0]?.imageUrl ?? item.image?.imageUrl ?? null,
        url: item.itemWebUrl,
        seller: item.seller?.username ?? null,
        // Browse API returns lastSoldDate in EXTENDED fieldgroup
        date: item.lastSoldDate ?? item.itemCreationDate ?? null,
      }));

    if (cleanItems.length === 0) {
      return res.status(404).json({
        error: "No Results",
        message:
          "No recent sold listings found. Try a different search term or condition.",
        searchQuery,
      });
    }

    // ── Calculate average from top 3 ────────────────────────────────────
    const topThree = cleanItems.slice(0, 3);
    const averagePrice =
      topThree.reduce((sum, s) => sum + s.price, 0) / topThree.length;

    // ── Fetch buy rate from Firestore ────────────────────────────────────
    const buyRates = await getBuyRates();
    const rateKey = CATEGORY_RATE_MAP[category];
    const buyRate = buyRates[rateKey] ?? buyRates.default ?? 0.7;
    const ourOffer = averagePrice * buyRate;

    res.json({
      success: true,
      data: {
        searchQuery,
        category,
        condition,
        sales: cleanItems,
        averagePrice: parseFloat(averagePrice.toFixed(2)),
        ourOffer: parseFloat(ourOffer.toFixed(2)),
        buyRate,
        rateKey,
        basedOnCount: topThree.length,
      },
    });
  } catch (error) {
    // eBay token failure
    if (error.response?.status === 401) {
      ebayTokenCache = { token: null, expiresAt: 0 }; // force refresh next call
      return res.status(401).json({
        error: "eBay Auth Failed",
        message: "Token refresh failed — check EBAY_CLIENT_ID/SECRET",
      });
    }

    console.error(
      "[card-price-check] error:",
      error.response?.data ?? error.message,
    );
    res.status(500).json({
      error: "Search Failed",
      message: error.response?.data?.errors?.[0]?.message ?? error.message,
    });
  }
});

module.exports = router;
