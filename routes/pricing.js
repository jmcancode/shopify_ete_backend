const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");
const {
  getRawMarketValue,
  getGradedMarketValue,
  getSealedMarketValue,
} = require("../services/pricing.service.js");

// ─── Firestore Buy Rate Loader ─────────────────────────────────────────────────

async function loadBuyRates() {
  const db = admin.firestore();
  const doc = await db.collection("settings").doc("buyRates").get();
  if (!doc.exists) {
    throw new Error("settings/buyRates document not found in Firestore");
  }
  const { updatedAt, updatedBy, ...rates } = doc.data();
  console.log("✅ Buy rates from Firestore:", JSON.stringify(rates));
  return rates;
}

// ─── POST /api/pricing/market-value ──────────────────────────────────────────
// Handles raw cards, graded cards, and sealed products.
//
// Body:
//   type: "raw" | "graded" | "sealed"
//   cardName / productName: string
//   category: string (e.g. "pokemon-singles", "graded-card", "modern-booster", "etb")
//   condition: "NM" | "LP" | "MP" | "HP"   (raw only)
//   grade: "PSA 10" | "BGS 9.5" | etc.     (graded only)
//   setName: string (optional — used for result filtering)
//   localCardId: string (optional — skip search if Scrydex ID is known)
//   localSealedId: string (optional — skip search for sealed)
//   expansionId: string (optional — scope sealed search to an expansion)
//   includeListings: boolean (optional — include recent eBay sold comps, default true)
//   listingDays: number (optional — how far back to look, default 90)

router.post("/market-value", async (req, res) => {
  try {
    const {
      type = "raw",
      cardName,
      productName,
      condition = "NM",
      category,
      setName = null,
      grade,
      localCardId = null,
      localSealedId = null,
      expansionId = null,
      includeListings = true,
      listingDays = 90,
    } = req.body;

    // Load live buy rates — throws if Firestore is unavailable
    const buyRates = await loadBuyRates();

    let result;

    if (type === "sealed") {
      const name = productName?.trim() || cardName?.trim();
      if (!name) {
        return res.status(400).json({
          success: false,
          message: "productName is required for sealed type",
        });
      }
      const sealedCategory = category ?? "modern-booster";
      result = await getSealedMarketValue({
        productName: name,
        category: sealedCategory,
        localSealedId,
        expansionId,
        buyRates,
        includeListings,
        listingDays,
      });
    } else if (type === "graded") {
      if (!cardName?.trim()) {
        return res
          .status(400)
          .json({ success: false, message: "cardName is required" });
      }
      if (!grade) {
        return res.status(400).json({
          success: false,
          message: "grade is required for graded type (e.g. 'PSA 10')",
        });
      }
      result = await getGradedMarketValue({
        cardName: cardName.trim(),
        grade,
        setName,
        localCardId,
        category: category ?? "graded-card",
        buyRates,
        includeListings,
        listingDays,
      });
    } else {
      // Default: raw
      if (!cardName?.trim()) {
        return res
          .status(400)
          .json({ success: false, message: "cardName is required" });
      }
      result = await getRawMarketValue({
        cardName: cardName.trim(),
        condition,
        category: category ?? "pokemon-singles",
        setName,
        localCardId,
        buyRates,
        includeListings,
        listingDays,
      });
    }

    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("❌ /api/pricing/market-value error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
