const express = require("express");
const router = express.Router();
const shopifyAuthService = require("../services/shopify-auth.service");

router.get("/test-storefront", async (req, res) => {
  try {
    // Super simple query - just get shop name
    const query = `
      {
        shop {
          name
        }
      }
    `;

    const data = await shopifyAuthService.storefrontRequest(query);

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Test error:", error.message);
    res.status(500).json({
      error: "Test failed",
      message: error.message,
    });
  }
});

module.exports = router;
