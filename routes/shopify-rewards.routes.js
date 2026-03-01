const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");
const rewardsService = require("../services/shopify-reward.service");

// ============================================================================
// MIDDLEWARE
// ============================================================================

/**
 * Verify Firebase Auth token (Bearer header)
 */
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
    console.error("[rewards] Auth error:", error.message);
    res.status(401).json({
      error: "Unauthorized",
      message: "Invalid or expired token",
    });
  }
};

/**
 * Verify Firebase Auth token AND admin role (Firestore roles.isAdmin)
 */
const verifyAdmin = async (req, res, next) => {
  try {
    const db = admin.firestore();
    const userDoc = await db.collection("users").doc(req.user.uid).get();

    if (!userDoc.exists) {
      return res.status(403).json({
        error: "Forbidden",
        message: "User profile not found",
      });
    }

    const isAdmin = userDoc.data()?.roles?.isAdmin === true;

    if (!isAdmin) {
      return res.status(403).json({
        error: "Forbidden",
        message: "Admin access required",
      });
    }

    req.user.admin = true;
    next();
  } catch (error) {
    console.error("[rewards] Admin verification error:", error.message);
    res.status(403).json({
      error: "Forbidden",
      message: "Admin verification failed",
    });
  }
};

/**
 * Verify Shopify Flow webhook secret (x-webhook-secret header)
 */
const verifyWebhookSecret = (req, res, next) => {
  const secret = req.headers["x-webhook-secret"];
  const expectedSecret = process.env.REWARDS_WEBHOOK_SECRET;

  if (!expectedSecret) {
    console.error(
      "[rewards] REWARDS_WEBHOOK_SECRET env var is not set — webhook is unsecured!",
    );
    return res.status(500).json({ error: "Webhook not configured" });
  }

  if (!secret || secret !== expectedSecret) {
    console.warn("[rewards] Webhook: invalid secret received");
    return res.status(401).json({ error: "Invalid webhook secret" });
  }

  next();
};

// ============================================================================
// PUBLIC ROUTE — Config (no auth)
// ============================================================================

/**
 * GET /api/rewards/config
 * Returns earning rates and redemption tiers.
 * Public — mobile app reads this to render the tiers UI.
 */
router.get("/config", async (req, res) => {
  try {
    const config = await rewardsService.getConfig();

    res.json({
      success: true,
      data: {
        pointsPerDollar: config.POINTS_PER_DOLLAR,
        signupBonus: config.SIGNUP_BONUS,
        redemptionTiers: config.REDEMPTION_TIERS,
      },
    });
  } catch (error) {
    console.error("[rewards] GET /config error:", error.message);
    res.status(500).json({ error: "Failed to fetch rewards config" });
  }
});

// ============================================================================
// SHOPIFY FLOW WEBHOOK — No Firebase auth, secured by shared secret
// ============================================================================

/**
 * POST /api/rewards/webhook/order-paid
 *
 * Called by Shopify Flow when an order is paid.
 * Secured by x-webhook-secret header matching REWARDS_WEBHOOK_SECRET env var.
 *
 * Expected body (from Shopify Flow):
 * {
 *   "email": "{{ order.email }}",
 *   "order_id": "{{ order.id }}",
 *   "order_name": "{{ order.name }}",
 *   "total_price": "{{ order.totalPriceSet.shopMoney.amount }}",
 *   "currency": "{{ order.totalPriceSet.shopMoney.currencyCode }}"
 * }
 */
router.post("/webhook/order-paid", verifyWebhookSecret, async (req, res) => {
  console.log(
    "[webhook:debug] secret header:",
    req.headers["x-webhook-secret"],
  );
  console.log("[webhook:debug] body keys:", Object.keys(req.body || {}));
  try {
    const { email, order_id, order_name, total_price, currency } = req.body;

    // Validate required fields
    if (!email || !order_id || !total_price) {
      return res.status(400).json({
        error: "Bad Request",
        message: "email, order_id, and total_price are required",
      });
    }

    console.log(
      `[rewards] Webhook received: order ${order_name} for ${email} — $${total_price} ${currency}`,
    );

    const result = await rewardsService.awardOrderPoints(
      email,
      total_price,
      order_id,
      order_name,
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("[rewards] Webhook error:", error.message);
    res.status(500).json({
      error: "Failed to process order",
      message: error.message,
    });
  }
});

// ============================================================================
// USER ROUTES — Firebase auth required
// ============================================================================

/**
 * GET /api/rewards/balance
 * Returns current points, lifetime points, total redeemed, store credit.
 */
router.get("/balance", verifyToken, async (req, res) => {
  try {
    const balance = await rewardsService.getBalance(req.user.uid);

    res.json({
      success: true,
      data: balance,
    });
  } catch (error) {
    console.error("[rewards] GET /balance error:", error.message);
    res.status(500).json({
      error: "Failed to fetch balance",
      message: error.message,
    });
  }
});

/**
 * GET /api/rewards/history
 * Returns paginated points ledger for the authenticated user.
 * Query param: ?limit=20 (default 20, max 50)
 */
router.get("/history", verifyToken, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const history = await rewardsService.getPointsHistory(req.user.uid, limit);

    res.json({
      success: true,
      data: history,
    });
  } catch (error) {
    console.error("[rewards] GET /history error:", error.message);
    res.status(500).json({
      error: "Failed to fetch history",
      message: error.message,
    });
  }
});

/**
 * POST /api/rewards/redeem
 * Redeem points for store credit.
 *
 * Body: { tierIndex: 0 | 1 | 2 | 3 }
 *
 * 250 pts → $5    (index 0)
 * 500 pts → $10   (index 1)
 * 750 pts → $25   (index 2)
 * 1000 pts → $35  (index 3)
 */
router.post("/redeem", verifyToken, async (req, res) => {
  try {
    const { tierIndex } = req.body;

    if (tierIndex === undefined || tierIndex === null) {
      return res.status(400).json({
        error: "Bad Request",
        message: "tierIndex is required (0-3)",
      });
    }

    const index = parseInt(tierIndex);

    if (isNaN(index) || index < 0 || index > 3) {
      return res.status(400).json({
        error: "Bad Request",
        message: "tierIndex must be 0, 1, 2, or 3",
      });
    }

    const result = await rewardsService.redeemPoints(req.user.uid, index);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("[rewards] POST /redeem error:", error.message);

    // Return friendly errors for known failure modes
    if (error.message.includes("Insufficient points")) {
      return res.status(400).json({
        error: "Insufficient Points",
        message: error.message,
      });
    }

    if (error.message.includes("No Shopify customer account")) {
      return res.status(400).json({
        error: "Account Not Linked",
        message: error.message,
      });
    }

    res.status(500).json({
      error: "Redemption failed",
      message: error.message,
    });
  }
});

// ============================================================================
// ADMIN ROUTES — Firebase auth + admin role required
// ============================================================================

/**
 * POST /api/rewards/admin/adjust
 * Manually adjust a user's points (positive or negative).
 *
 * Body: { userId, points, reason }
 * - userId: Firebase UID of the target user
 * - points: integer delta (positive = award, negative = deduct)
 * - reason: admin note (required for audit trail)
 */
router.post("/admin/adjust", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { userId, points, reason } = req.body;

    if (!userId) {
      return res.status(400).json({
        error: "Bad Request",
        message: "userId is required",
      });
    }

    if (!points || typeof points !== "number" || points === 0) {
      return res.status(400).json({
        error: "Bad Request",
        message: "points must be a non-zero number",
      });
    }

    if (!reason || !reason.trim()) {
      return res.status(400).json({
        error: "Bad Request",
        message: "reason is required for audit trail",
      });
    }

    const result = await rewardsService.adminAdjustPoints(
      userId,
      points,
      reason,
      req.user.uid, // admin's UID for audit
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("[rewards] POST /admin/adjust error:", error.message);
    res.status(500).json({
      error: "Adjustment failed",
      message: error.message,
    });
  }
});

/**
 * POST /api/rewards/admin/bonus
 * Award bonus points to a user (signup, birthday, promo, etc.)
 *
 * Body: { userId, points, source, description }
 */
router.post("/admin/bonus", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { userId, points, source, description } = req.body;

    if (!userId || !points || !source) {
      return res.status(400).json({
        error: "Bad Request",
        message: "userId, points, and source are required",
      });
    }

    const validSources = ["signup", "birthday", "promo", "manual", "migration"];

    if (!validSources.includes(source)) {
      return res.status(400).json({
        error: "Bad Request",
        message: `source must be one of: ${validSources.join(", ")}`,
      });
    }

    if (typeof points !== "number" || points <= 0) {
      return res.status(400).json({
        error: "Bad Request",
        message: "points must be a positive number",
      });
    }

    const result = await rewardsService.awardBonusPoints(
      userId,
      points,
      source,
      description,
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("[rewards] POST /admin/bonus error:", error.message);
    res.status(500).json({
      error: "Bonus award failed",
      message: error.message,
    });
  }
});

/**
 * GET /api/rewards/admin/user/:userId/balance
 * View any user's current rewards balance.
 */
router.get(
  "/admin/user/:userId/balance",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { userId } = req.params;
      const balance = await rewardsService.getBalance(userId);

      res.json({
        success: true,
        data: balance,
      });
    } catch (error) {
      console.error(
        "[rewards] GET /admin/user/:userId/balance error:",
        error.message,
      );
      res.status(500).json({
        error: "Failed to fetch balance",
        message: error.message,
      });
    }
  },
);

/**
 * GET /api/rewards/admin/user/:userId/history
 * View any user's points ledger (admin only).
 * Query param: ?limit=20
 */
router.get(
  "/admin/user/:userId/history",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { userId } = req.params;
      const limit = Math.min(parseInt(req.query.limit) || 50, 100);
      const history = await rewardsService.getPointsHistory(userId, limit);

      res.json({
        success: true,
        data: history,
      });
    } catch (error) {
      console.error(
        "[rewards] GET /admin/user/:userId/history error:",
        error.message,
      );
      res.status(500).json({
        error: "Failed to fetch history",
        message: error.message,
      });
    }
  },
);



module.exports = router;
