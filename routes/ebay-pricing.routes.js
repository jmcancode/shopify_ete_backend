// routes/ebay-pricing.routes.js
const express = require("express");
const router = express.Router();
const ebayPricingService = require("../services/ebay-pricing.service");

/**
 * GET /api/pricing/market-data
 * Query: ?query=PSA+10+Charizard+215+Evolving+Skies&limit=10
 */
router.get("/market-data", async (req, res) => {
  try {
    const { query, limit = 10 } = req.query;

    if (!query || query.trim().length < 3) {
      return res.status(400).json({
        error: "Bad Request",
        message: "query param is required (min 3 chars)",
      });
    }

    const listings = await ebayPricingService.getActiveListings(
      query,
      parseInt(limit),
    );
    const summary = ebayPricingService.calculateMarketSummary(listings);

    res.json({
      success: true,
      data: {
        query,
        summary,
        listings,
      },
    });
  } catch (error) {
    console.error(
      "eBay market data error:",
      error.response?.data || error.message,
    );
    res.status(500).json({
      error: "Failed to fetch market data",
      message: error.message,
    });
  }
});

module.exports = router;
