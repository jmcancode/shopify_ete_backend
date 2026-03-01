const express = require("express");
const router = express.Router();
const shopifyStorefront = require("../services/shopify-storefront.service");
const admin = require("firebase-admin");

const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.split("Bearer ")[1];
      const decodedToken = await admin.auth().verifyIdToken(token);
      req.user = { uid: decodedToken.uid };
    }
  } catch (error) {
    console.warn("optionalAuth: invalid token, proceeding as guest");
  }
  next();
};

router.post("/checkout", optionalAuth, async (req, res) => {
  try {
    const { lineItems } = req.body;

    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      return res
        .status(400)
        .json({ error: "lineItems must be a non-empty array" });
    }

    let buyerEmail = null;

    if (req.user?.uid) {
      const db = admin.firestore();
      const userDoc = await db.collection("users").doc(req.user.uid).get();

      if (userDoc.exists) {
        const email = userDoc.data()?.email;
        if (email && email.includes("@")) {
          buyerEmail = email.trim().toLowerCase();
          console.log("✅ Pre-filling checkout for:", buyerEmail);
        }
      }
    }

    const checkout = await shopifyStorefront.createCheckout(
      lineItems,
      buyerEmail,
    );

    res.json({
      success: true,
      data: {
        checkoutId: checkout.checkoutId,
        checkoutUrl: checkout.checkoutUrl,
      },
    });
  } catch (error) {
    console.error("Create checkout error:", error);
    res
      .status(500)
      .json({ error: "Failed to create checkout", message: error.message });
  }
});

module.exports = router;
