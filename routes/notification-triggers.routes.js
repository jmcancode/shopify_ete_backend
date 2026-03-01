/**
 * notification-triggers.routes.js
 *
 * Auto-triggered notification endpoints called by:
 *  1. Shopify Flow (webhooks) — new products, points awarded
 *  2. Internal backend events — support ticket status changes
 *
 * Mount at: /api/notify
 *
 * Shopify Flow setup:
 *  - Trigger: "Product created" → Action: HTTP Request → POST /api/notify/new-product
 *  - Trigger: "Customer tag added" (mo_rewards_*) → POST /api/notify/points-added
 *
 * Security:
 *  - Shopify webhooks use HMAC-SHA256 signature verification (SHOPIFY_WEBHOOK_SECRET)
 *  - Internal endpoints use the standard verifyToken + verifyAdmin middleware
 */

const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");
const crypto = require("crypto");
const notificationService = require("../services/notification.service");
const { NOTIFICATION_TYPES } = require("../services/notification.service");

// ─── Shopify Webhook HMAC Verification ───────────────────────────────────────

function verifyShopifyWebhook(req, res, next) {
  const hmac = req.headers["x-shopify-hmac-sha256"];
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  if (!secret) {
    // If no secret configured, skip verification in dev
    if (process.env.NODE_ENV !== "production") return next();
    return res.status(401).json({ error: "Webhook secret not configured" });
  }

  if (!hmac) {
    return res.status(401).json({ error: "Missing HMAC header" });
  }

  // Body must be the raw buffer — ensure express.raw() middleware is used for these routes
  const body = req.rawBody || JSON.stringify(req.body);
  const hash = crypto
    .createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("base64");

  if (hash !== hmac) {
    return res.status(401).json({ error: "Invalid HMAC signature" });
  }

  next();
}

// ─── Internal Auth Middleware ─────────────────────────────────────────────────

const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const token = authHeader.split("Bearer ")[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = { uid: decoded.uid, email: decoded.email };
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
};

const verifyAdmin = async (req, res, next) => {
  try {
    const db = admin.firestore();
    const userDoc = await db.collection("users").doc(req.user.uid).get();
    const isAdmin = userDoc.data()?.roles?.isAdmin === true;
    if (!isAdmin) return res.status(403).json({ error: "Admin required" });
    req.user.admin = true;
    next();
  } catch {
    res.status(403).json({ error: "Forbidden" });
  }
};

// ─── Helper: Lookup Firebase UID from Shopify Customer ID ────────────────────

async function getUidByShopifyCustomerId(shopifyCustomerId) {
  const db = admin.firestore();
  const snapshot = await db
    .collection("users")
    .where("shopifyCustomerId", "==", shopifyCustomerId)
    .limit(1)
    .get();

  if (snapshot.empty) return null;
  return snapshot.docs[0].id;
}

// ─── Helper: Lookup Firebase UID from email ───────────────────────────────────

async function getUidByEmail(email) {
  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    return userRecord.uid;
  } catch {
    return null;
  }
}

// ============================================================================
// SHOPIFY FLOW WEBHOOKS
// ============================================================================

router.post("/order", verifyShopifyWebhook, async (req, res) => {
  const { shopifyCustomerId, orderId, orderName, event } = req.body;

  const uid = await getUidByShopifyCustomerId(shopifyCustomerId);
  if (!uid) return res.json({ success: false, reason: "user_not_found" });

  const messages = {
    created: {
      title: "Order Confirmed ✅",
      body: `${orderName} has been received and is being processed.`,
    },
    fulfilled: {
      title: "Order Shipped 📦",
      body: `${orderName} is on its way!`,
    },
    cancelled: {
      title: "Order Cancelled",
      body: `${orderName} has been cancelled.`,
    },
  };

  const msg = messages[event];
  if (!msg) return res.status(400).json({ error: "Unknown event" });

  const result = await notificationService.sendToUser(uid, {
    type: "order_update",
    title: msg.title,
    body: msg.body,
    data: { screen: "Orders", orderId: orderId || "" },
  });

  res.json({ success: true, data: result });
});

/**
 * POST /api/notify/new-product
 *
 * Triggered by Shopify Flow when a product is created/published.
 * Broadcasts to users who have newArrivalsAlerts enabled, filtered by
 * the product's TCG tags (pokemon, onepiece, lorcana, etc.).
 *
 * Shopify Flow payload (customize in Flow to send these fields):
 * {
 *   "productId": "gid://shopify/Product/123",
 *   "title": "Scarlet & Violet 151 Booster Box",
 *   "productType": "Booster Box",
 *   "tags": ["pokemon", "sv151", "sealed"],
 *   "vendor": "Pokemon Company"
 * }
 */
router.post("/new-product", verifyShopifyWebhook, async (req, res) => {
  try {
    const { productId, title, productType, tags = [], vendor } = req.body;

    if (!title) {
      return res.status(400).json({ error: "title is required" });
    }

    // Determine TCG filter from product tags
    const TCG_TAGS = [
      "pokemon",
      "onepiece",
      "lorcana",
      "sports",
      "yugioh",
      "mtg",
    ];
    const tcgFilter =
      tags.find((tag) => TCG_TAGS.includes(tag.toLowerCase()))?.toLowerCase() ||
      null;

    // Build a friendly message
    const typeLabel = productType ? `${productType}: ` : "";
    const message = `${typeLabel}${title} is now available in the shop!`;

    const result = await notificationService.sendNewArrivalsAlert(
      { message, id: productId || "" },
      tcgFilter,
    );

    console.log(
      `📦 New product notification: "${title}" tcgFilter=${tcgFilter}`,
      result,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("New product notification error:", error);
    res.status(500).json({ error: "Failed to send notification" });
  }
});

/**
 * POST /api/notify/points-added
 *
 * Triggered by Shopify Flow when loyalty points are awarded to a customer.
 * Sends a personal notification to that specific user only.
 *
 * Shopify Flow payload:
 * {
 *   "shopifyCustomerId": "gid://shopify/Customer/456",
 *   "email": "user@example.com",
 *   "pointsAwarded": 50,
 *   "totalPoints": 350,
 *   "reason": "Purchase"       // "Purchase" | "Referral" | "Bonus"
 * }
 */
router.post("/points-added", verifyShopifyWebhook, async (req, res) => {
  try {
    const { shopifyCustomerId, email, pointsAwarded, totalPoints, reason } =
      req.body;

    if (!shopifyCustomerId && !email) {
      return res
        .status(400)
        .json({ error: "shopifyCustomerId or email is required" });
    }

    // Resolve to Firebase UID
    let uid = null;
    if (shopifyCustomerId) {
      uid = await getUidByShopifyCustomerId(shopifyCustomerId);
    }
    if (!uid && email) {
      uid = await getUidByEmail(email);
    }

    if (!uid) {
      console.log(
        `⚠️ No Firebase user found for shopifyCustomerId=${shopifyCustomerId}`,
      );
      return res.json({ success: false, reason: "user_not_found" });
    }

    const points = parseInt(pointsAwarded) || 0;
    const total = parseInt(totalPoints) || 0;
    const reasonLabel =
      reason === "Purchase"
        ? "your purchase"
        : reason === "Referral"
          ? "referring a friend"
          : reason || "activity";

    const result = await notificationService.sendRewardsUpdate(uid, {
      message: `+${points} Mo'Rewards points for ${reasonLabel}! You now have ${total} points.`,
    });

    console.log(
      `🏆 Points notification sent to uid=${uid}: +${points} points`,
      result,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Points notification error:", error);
    res.status(500).json({ error: "Failed to send notification" });
  }
});

// ============================================================================
// INTERNAL TRIGGERS — called by other backend routes
// ============================================================================

/**
 * POST /api/notify/support-ticket
 *
 * Called internally when a support ticket status changes.
 * NOT exposed to Shopify — called from within shopify-customer.routes.js
 * or wherever you handle ticket PATCH requests.
 *
 * Body: { userId, ticketId, ticketNumber, newStatus }
 */
router.post("/support-ticket", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { userId, ticketId, ticketNumber, newStatus } = req.body;

    if (!userId || !newStatus) {
      return res
        .status(400)
        .json({ error: "userId and newStatus are required" });
    }

    const statusMessages = {
      "in-progress": "is being reviewed by our team.",
      "waiting-customer": "needs your attention — please check for a response.",
      resolved: "has been resolved! Let us know if you need anything else.",
      closed: "has been closed.",
    };

    const statusMsg = statusMessages[newStatus];
    if (!statusMsg) {
      return res
        .status(400)
        .json({ error: "No notification configured for this status" });
    }

    const result = await notificationService.sendToUser(userId, {
      type: NOTIFICATION_TYPES.SUBMISSION_UPDATE,
      title: `Support Ticket ${newStatus === "resolved" ? "✅ Resolved" : "Update"}`,
      body: `Ticket ${ticketNumber || ticketId} ${statusMsg}`,
      data: { screen: "SupportTickets", ticketId: ticketId || "" },
    });

    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Support ticket notification error:", error);
    res.status(500).json({ error: "Failed to send notification" });
  }
});

/**
 * POST /api/notify/live-status
 *
 * Called when admin toggles "Stream Status" on the Admin Dashboard.
 * Broadcasts a live break alert to all users with breakReminders enabled.
 *
 * Body: { isLive, streamTitle, tiktokUrl }
 */
router.post("/live-status", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { isLive, streamTitle, tiktokUrl } = req.body;

    if (!isLive) {
      // Going offline — no notification needed (could add one if desired)
      return res.json({
        success: true,
        message: "Stream offline, no notification sent",
      });
    }

    const result = await notificationService.sendLiveBreakAlert({
      id: "",
      title: streamTitle || "MoBros TCG",
      tiktokUrl: tiktokUrl || "",
    });

    console.log("📡 Live break alert broadcast:", result);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Live status notification error:", error);
    res.status(500).json({ error: "Failed to send live alert" });
  }
});

/**
 * POST /api/notify/manual
 *
 * Manual push by admin. Supports targeting:
 *   - "all"     → broadcast to everyone
 *   - "vip"     → users with roles.isVIP === true
 *   - "role"    → users with a specific Firestore role flag
 *   - "user"    → single user by uid
 *
 * Body: {
 *   title, body,
 *   target: "all" | "vip" | "user",
 *   uid,           // required when target = "user"
 *   tcgFilter,     // optional: "pokemon" | "onepiece" | etc.
 *   type,          // NOTIFICATION_TYPES value
 * }
 */
router.post("/manual", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const {
      title,
      body,
      target = "all",
      uid,
      tcgFilter = null,
      type = NOTIFICATION_TYPES.SYSTEM,
    } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: "title and body are required" });
    }

    let result;

    if (target === "user") {
      if (!uid)
        return res
          .status(400)
          .json({ error: "uid is required for target=user" });
      result = await notificationService.sendToUser(uid, { type, title, body });
    } else if (target === "vip") {
      // Fetch VIP user IDs from Firestore, send individually
      const db = admin.firestore();
      const vipSnapshot = await db
        .collection("users")
        .where("roles.isVIP", "==", true)
        .get();

      let successCount = 0;
      await Promise.allSettled(
        vipSnapshot.docs.map(async (doc) => {
          const r = await notificationService.sendToUser(doc.id, {
            type,
            title,
            body,
          });
          if (r.success) successCount++;
        }),
      );
      result = {
        success: true,
        successCount,
        target: "vip",
        total: vipSnapshot.size,
      };
    } else {
      // "all" — broadcast with optional TCG filter
      result = await notificationService.broadcast(
        { type, title, body },
        { tcgFilter },
      );
    }

    // Audit log
    await admin
      .firestore()
      .collection("adminNotificationLogs")
      .add({
        sentBy: req.user.uid,
        target,
        uid: uid || null,
        tcgFilter,
        type,
        title,
        body,
        result,
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Manual notification error:", error);
    res.status(500).json({ error: "Failed to send notification" });
  }
});

module.exports = router;
