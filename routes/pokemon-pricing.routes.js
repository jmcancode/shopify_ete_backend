const express = require("express");
const router = express.Router();
const pokemonPricingService = require("../services/pokemon-pricing.service");
const admin = require("firebase-admin");

const verifyToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split("Bearer ")[1];
    if (!token) return res.status(401).json({ error: "No token provided" });
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = { uid: decoded.uid, email: decoded.email };
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
};

/**
 * GET /api/pricing/card
 * Get raw + graded prices for a Pokemon card
 * Query: ?name=Charizard&setId=swsh7&number=215&grade=psa10
 */
router.get("/card", async (req, res) => {
  try {
    const { name, setId, number, grade = "psa10" } = req.query;

    if (!name) {
      return res.status(400).json({ error: "name param is required" });
    }

    const marketValue = await pokemonPricingService.getGradedMarketValue(
      name,
      grade,
      setId || null,
      number || null,
    );

    if (!marketValue) {
      return res.status(404).json({ error: "Card not found" });
    }

    res.json({ success: true, data: marketValue });
  } catch (error) {
    console.error("Get card price error:", error.message);
    res
      .status(500)
      .json({ error: "Failed to fetch card pricing", message: error.message });
  }
});

/**
 * POST /api/pricing/parse-title
 * Parse a card title string into structured card + pricing data
 * Body: { title: "PSA 10 Charizard 215/203 Evolving Skies" }
 */
router.post("/parse-title", async (req, res) => {
  try {
    const { title } = req.body;

    if (!title) {
      return res.status(400).json({ error: "title is required" });
    }

    const result = await pokemonPricingService.parseTitle(title);

    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Parse title error:", error.message);
    res
      .status(500)
      .json({ error: "Failed to parse title", message: error.message });
  }
});

/**
 * POST /api/pricing/market-value
 * Core endpoint: given card details, return market value + shop offer
 * Body: { cardName, grade, setId, number, buyRateOverride }
 */
router.post("/market-value", async (req, res) => {
  try {
    const {
      cardName,
      grade = "psa10",
      setId,
      number,
      buyRateOverride,
    } = req.body;

    if (!cardName) {
      return res.status(400).json({ error: "cardName is required" });
    }

    // Get market value from Pokemon Price Tracker
    const pricing = await pokemonPricingService.getGradedMarketValue(
      cardName,
      grade,
      setId || null,
      number || null,
    );

    if (!pricing || !pricing.marketValue) {
      return res.status(404).json({
        error: "No pricing data found for this card",
        cardName,
        grade,
      });
    }

    // Get buy rate from Firestore (or use override)
    const db = admin.firestore();
    let buyRate = buyRateOverride || 0.85; // default 85%

    if (!buyRateOverride) {
      const ratesDoc = await db.collection("settings").doc("buyRates").get();
      if (ratesDoc.exists) {
        const rates = ratesDoc.data();
        // Match rate by category - graded cards get their own rate
        buyRate = rates["graded-card"] || rates["default"] || 0.85;
      }
    }

    const marketValue = pricing.marketValue;
    const shopOffer = parseFloat((marketValue * buyRate).toFixed(2));

    res.json({
      success: true,
      data: {
        card: {
          name: pricing.cardName,
          set: pricing.setName,
          number: pricing.cardNumber,
          grade: pricing.grade,
          imageUrl: pricing.imageUrl,
        },
        pricing: {
          marketValue,
          shopOffer,
          buyRate,
          buyRatePercent: `${(buyRate * 100).toFixed(0)}%`,
          rawMarketPrice: pricing.rawMarketPrice,
          lastUpdated: pricing.lastUpdated,
          source: pricing.source,
        },
      },
    });
  } catch (error) {
    console.error("Market value error:", error.message);
    res.status(500).json({
      error: "Failed to calculate market value",
      message: error.message,
    });
  }
});

module.exports = router;
