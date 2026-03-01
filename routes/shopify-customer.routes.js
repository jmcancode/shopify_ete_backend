const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");
const shopifyCustomerService = require("../services/shopify-customer.service");

// ── Simple per-user rate limiter (1 sync per 60 seconds) ──
const syncCooldowns = new Map();
const SYNC_COOLDOWN_MS = 60 * 1000;

function checkSyncCooldown(uid) {
  const lastSync = syncCooldowns.get(uid);
  if (lastSync && Date.now() - lastSync < SYNC_COOLDOWN_MS) {
    const remaining = Math.ceil(
      (SYNC_COOLDOWN_MS - (Date.now() - lastSync)) / 1000,
    );
    return remaining;
  }
  return 0;
}

// Middleware to verify Firebase token
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "No token provided",
      });
    }

    const token = authHeader.split("Bearer ")[1];
    const decodedToken = await admin.auth().verifyIdToken(token);

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
    };

    next();
  } catch (error) {
    console.error("Auth error:", error);
    res.status(401).json({
      error: "Unauthorized",
      message: "Invalid or expired token",
    });
  }
};

/**
 * POST /api/shopify/sync-customer
 * Sync Firebase user with Shopify customer
 * Pulls store credit, orders, amountSpent from Shopify
 * Does NOT touch rewards.points (managed separately)
 */
router.post("/sync-customer", verifyToken, async (req, res) => {
  try {
    // Rate limit check
    const cooldown = checkSyncCooldown(req.user.uid);
    if (cooldown > 0) {
      return res.status(429).json({
        error: "Too many requests",
        message: `Please wait ${cooldown} seconds before syncing again`,
        retryAfter: cooldown,
      });
    }

    const db = admin.firestore();
    const userDoc = await db.collection("users").doc(req.user.uid).get();

    if (!userDoc.exists) {
      return res.status(404).json({
        error: "User not found in Firestore",
      });
    }

    const userData = userDoc.data();
    let syncResult;

    if (userData.shopifyCustomerId) {
      console.log(
        "🔄 Refreshing Shopify data for:",
        userData.shopifyCustomerId,
      );

      const shopifyCustomer = await shopifyCustomerService.getCustomerById(
        userData.shopifyCustomerId,
      );

      if (!shopifyCustomer) {
        return res.status(404).json({
          error: "Shopify customer not found",
          message: "The linked Shopify customer no longer exists",
        });
      }

      syncResult = {
        isNew: false,
        shopifyCustomerId: shopifyCustomer.id,
        email: shopifyCustomer.email,
        firstName: shopifyCustomer.firstName,
        lastName: shopifyCustomer.lastName,
        displayName: shopifyCustomer.displayName,
        numberOfOrders: shopifyCustomer.numberOfOrders,
        amountSpent: shopifyCustomer.amountSpent,
        storeCredit: shopifyCustomer.storeCredit,
        tags: shopifyCustomer.tags,
      };
    } else {
      syncResult = await shopifyCustomerService.syncCustomer({
        email: userData.email,
        firstName: userData.firstName || "",
        lastName: userData.lastName || "",
        phone: userData.phone || "",
        emailMarketing: userData.preferences?.emailMarketing || false,
      });
    }

    // Write Shopify data using dot notation — never overwrites rewards.points
    await db
      .collection("users")
      .doc(req.user.uid)
      .update({
        shopifyCustomerId: syncResult.shopifyCustomerId,
        "rewards.storeCredit": syncResult.storeCredit,
        "rewards.numberOfOrders": syncResult.numberOfOrders,
        "rewards.amountSpent": parseFloat(
          syncResult.amountSpent?.amount || "0",
        ),
        "rewards.lastSyncedAt": admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    // Set cooldown
    syncCooldowns.set(req.user.uid, Date.now());

    console.log("🏆 Synced to user doc:", req.user.uid, {
      storeCredit: syncResult.storeCredit,
      orders: syncResult.numberOfOrders,
      amountSpent: syncResult.amountSpent?.amount,
    });

    res.json({
      success: true,
      message: syncResult.isNew
        ? "Customer created and synced"
        : "Customer synced",
      data: syncResult,
    });
  } catch (error) {
    console.error("Sync customer error:", error);
    res.status(500).json({
      error: "Failed to sync customer",
      message: error.message,
    });
  }
});

/**
 * GET /api/shopify/customer
 * Get current user's Shopify customer data (fresh from Shopify)
 */
router.get("/customer", verifyToken, async (req, res) => {
  try {
    const db = admin.firestore();
    const userDoc = await db.collection("users").doc(req.user.uid).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = userDoc.data();

    if (!userData.shopifyCustomerId) {
      return res.status(404).json({
        error: "No Shopify customer linked",
        message: "Call /sync-customer first",
      });
    }

    const customer = await shopifyCustomerService.getCustomerById(
      userData.shopifyCustomerId,
    );

    res.json({
      success: true,
      data: customer,
    });
  } catch (error) {
    console.error("Get customer error:", error);
    res.status(500).json({
      error: "Failed to get customer data",
      message: error.message,
    });
  }
});

/**
 * PATCH /api/shopify/customer
 * Update customer information in both Shopify and Firebase
 */
router.patch("/customer", verifyToken, async (req, res) => {
  try {
    const db = admin.firestore();
    const userDoc = await db.collection("users").doc(req.user.uid).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = userDoc.data();

    if (!userData.shopifyCustomerId) {
      return res.status(404).json({
        error: "No Shopify customer linked",
      });
    }

    const { firstName, lastName, phone } = req.body;

    const updates = {};
    if (firstName !== undefined) updates.firstName = firstName;
    if (lastName !== undefined) updates.lastName = lastName;
    if (phone !== undefined) updates.phone = phone;

    const updatedCustomer = await shopifyCustomerService.updateCustomer(
      userData.shopifyCustomerId,
      updates,
    );

    const firebaseUpdates = { ...updates };
    firebaseUpdates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await db.collection("users").doc(req.user.uid).update(firebaseUpdates);

    res.json({
      success: true,
      message: "Customer updated successfully",
      data: updatedCustomer,
    });
  } catch (error) {
    console.error("Update customer error:", error);
    res.status(500).json({
      error: "Failed to update customer",
      message: error.message,
    });
  }
});

module.exports = router;
