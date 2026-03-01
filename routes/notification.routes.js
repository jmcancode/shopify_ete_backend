/**
 * notifications.routes.js
 * Routes for FCM token management, notification delivery (admin + automated),
 * and user notification inbox CRUD.
 *
 * Mount at: /api/notifications
 */

const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");
const notificationService = require("../services/notification.service");
const { NOTIFICATION_TYPES } = require("../services/notification.service");

// ─── Auth Middleware ───────────────────────────────────────────────────────

const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
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

const verifyAdmin = async (req, res, next) => {
  try {
    const db = admin.firestore();
    const userDoc = await db.collection("users").doc(req.user.uid).get();
    if (!userDoc.exists) return res.status(403).json({ error: "Forbidden" });
    const isAdmin = userDoc.data()?.roles?.isAdmin === true;
    if (!isAdmin)
      return res
        .status(403)
        .json({ error: "Forbidden", message: "Admin access required" });
    req.user.admin = true;
    next();
  } catch (error) {
    res.status(403).json({ error: "Forbidden" });
  }
};

// ============================================================================
// FCM TOKEN MANAGEMENT
// ============================================================================

/**
 * POST /api/notifications/token
 * Register or refresh FCM token for the authenticated user.
 * Call on app launch and when FCM refreshes the token.
 *
 * Body: { token, platform, deviceName, appVersion }
 */
router.post("/token", verifyToken, async (req, res) => {
  try {
    const { token, platform, deviceName, appVersion } = req.body;

    if (!token) {
      return res.status(400).json({ error: "token is required" });
    }

    await notificationService.registerToken(req.user.uid, token, {
      platform,
      deviceName,
      appVersion,
    });

    res.json({ success: true, message: "FCM token registered" });
  } catch (error) {
    console.error("Register token error:", error);
    res.status(500).json({ error: "Failed to register token" });
  }
});

/**
 * DELETE /api/notifications/token
 * Deactivate FCM token on logout.
 *
 * Body: { token }
 */
router.delete("/token", verifyToken, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "token is required" });

    await notificationService.deactivateToken(req.user.uid, token);

    res.json({ success: true, message: "FCM token deactivated" });
  } catch (error) {
    console.error("Deactivate token error:", error);
    res.status(500).json({ error: "Failed to deactivate token" });
  }
});

// ============================================================================
// USER NOTIFICATION INBOX (CRUD)
// ============================================================================

/**
 * GET /api/notifications/inbox
 * Get the authenticated user's notification history.
 * Ordered by most recent, paginated.
 */
router.get("/inbox", verifyToken, async (req, res) => {
  try {
    const db = admin.firestore();
    const { limit = 20, unreadOnly = false } = req.query;

    let query = db
      .collection("users")
      .doc(req.user.uid)
      .collection("notifications")
      .orderBy("createdAt", "desc")
      .limit(parseInt(limit));

    if (unreadOnly === "true") {
      query = query.where("read", "==", false);
    }

    const snapshot = await query.get();
    const notifications = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Count unread
    const unreadSnapshot = await db
      .collection("users")
      .doc(req.user.uid)
      .collection("notifications")
      .where("read", "==", false)
      .get();

    res.json({
      success: true,
      data: notifications,
      unreadCount: unreadSnapshot.size,
    });
  } catch (error) {
    console.error("Get inbox error:", error);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

/**
 * PATCH /api/notifications/inbox/:id/read
 * Mark a single notification as read.
 */
router.patch("/inbox/:id/read", verifyToken, async (req, res) => {
  try {
    const db = admin.firestore();
    await db
      .collection("users")
      .doc(req.user.uid)
      .collection("notifications")
      .doc(req.params.id)
      .update({
        read: true,
        readAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    res.json({ success: true });
  } catch (error) {
    console.error("Mark read error:", error);
    res.status(500).json({ error: "Failed to mark as read" });
  }
});

/**
 * PATCH /api/notifications/inbox/read-all
 * Mark all notifications as read.
 */
router.patch("/inbox/read-all", verifyToken, async (req, res) => {
  try {
    const db = admin.firestore();
    const snapshot = await db
      .collection("users")
      .doc(req.user.uid)
      .collection("notifications")
      .where("read", "==", false)
      .get();

    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
      batch.update(doc.ref, {
        read: true,
        readAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();

    res.json({ success: true, updated: snapshot.size });
  } catch (error) {
    console.error("Mark all read error:", error);
    res.status(500).json({ error: "Failed to mark all as read" });
  }
});

/**
 * DELETE /api/notifications/inbox/:id
 * Delete a single notification from inbox.
 */
router.delete("/inbox/:id", verifyToken, async (req, res) => {
  try {
    const db = admin.firestore();
    await db
      .collection("users")
      .doc(req.user.uid)
      .collection("notifications")
      .doc(req.params.id)
      .delete();

    res.json({ success: true });
  } catch (error) {
    console.error("Delete notification error:", error);
    res.status(500).json({ error: "Failed to delete notification" });
  }
});

// ============================================================================
// USER PREFERENCES (CRUD)
// ============================================================================

/**
 * GET /api/notifications/preferences
 * Get the current user's notification preferences and favorite categories.
 */
router.get("/preferences", verifyToken, async (req, res) => {
  try {
    const db = admin.firestore();
    const userDoc = await db.collection("users").doc(req.user.uid).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const data = userDoc.data();
    res.json({
      success: true,
      data: {
        notifications: data?.preferences?.notifications || {},
        favoriteCategories: data?.preferences?.favoriteCategories || [],
        favorites: data?.favorites || {},
      },
    });
  } catch (error) {
    console.error("Get preferences error:", error);
    res.status(500).json({ error: "Failed to fetch preferences" });
  }
});

/**
 * PATCH /api/notifications/preferences
 * Update notification preferences and/or favorite categories.
 * Accepts partial updates — only fields included in body are changed.
 *
 * Body: {
 *   notifications: { pushNotifications, newArrivalsAlerts, breakReminders, ... },
 *   favoriteCategories: ["pokemon", "onepiece", ...]
 * }
 */
router.patch("/preferences", verifyToken, async (req, res) => {
  try {
    const db = admin.firestore();
    const { notifications, favoriteCategories } = req.body;

    const updateData = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Build nested update paths to avoid overwriting other preferences
    if (notifications && typeof notifications === "object") {
      const validNotifKeys = [
        "pushNotifications",
        "newArrivalsAlerts",
        "breakReminders",
        "exclusiveDeals",
        "orderUpdates",
        "restockAlerts",
        "socialActivity",
        "priceDrops",
      ];

      for (const key of validNotifKeys) {
        if (notifications[key] !== undefined) {
          updateData[`preferences.notifications.${key}`] = Boolean(
            notifications[key],
          );
        }
      }
    }

    if (Array.isArray(favoriteCategories)) {
      const validCategories = [
        "pokemon",
        "onepiece",
        "lorcana",
        "sports",
        "yugioh",
        "mtg",
      ];
      const filtered = favoriteCategories.filter((c) =>
        validCategories.includes(c),
      );
      updateData["preferences.favoriteCategories"] = filtered;
    }

    await db.collection("users").doc(req.user.uid).update(updateData);

    res.json({ success: true, message: "Preferences updated" });
  } catch (error) {
    console.error("Update preferences error:", error);
    res.status(500).json({ error: "Failed to update preferences" });
  }
});

// ============================================================================
// ADMIN — MANUAL NOTIFICATION SENDS
// ============================================================================

/**
 * POST /api/notifications/admin/send-user
 * Send a notification to a specific user (admin only).
 *
 * Body: { uid, type, title, body, data }
 */
router.post("/admin/send-user", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { uid, type, title, body, data = {} } = req.body;

    if (!uid || !title || !body) {
      return res
        .status(400)
        .json({ error: "uid, title, and body are required" });
    }

    const result = await notificationService.sendToUser(uid, {
      type: type || NOTIFICATION_TYPES.SYSTEM,
      title,
      body,
      data,
    });

    // Log to admin audit trail
    await admin.firestore().collection("adminNotificationLogs").add({
      sentBy: req.user.uid,
      targetUid: uid,
      type,
      title,
      body,
      result,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Admin send user error:", error);
    res.status(500).json({ error: "Failed to send notification" });
  }
});

/**
 * POST /api/notifications/admin/broadcast
 * Broadcast to all users (or TCG-filtered subset).
 * Respects each user's individual notification preferences.
 *
 * Body: {
 *   type,        // NOTIFICATION_TYPES key
 *   title,
 *   body,
 *   data,        // optional extra data payload
 *   tcgFilter,   // optional: "pokemon" | "onepiece" | "lorcana" | "sports"
 * }
 */
router.post("/admin/broadcast", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { type, title, body, data = {}, tcgFilter = null } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: "title and body are required" });
    }

    const result = await notificationService.broadcast(
      { type: type || NOTIFICATION_TYPES.SYSTEM, title, body, data },
      { tcgFilter },
    );

    await admin.firestore().collection("adminNotificationLogs").add({
      sentBy: req.user.uid,
      broadcastType: "all",
      tcgFilter,
      type,
      title,
      body,
      result,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Admin broadcast error:", error);
    res.status(500).json({ error: "Failed to broadcast notification" });
  }
});

/**
 * POST /api/notifications/admin/live-break
 * Trigger a live break alert to all users with breakReminders enabled.
 *
 * Body: { id, title, tiktokUrl, thumbnailUrl }
 */
router.post("/admin/live-break", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id, title, tiktokUrl, thumbnailUrl } = req.body;

    if (!title) return res.status(400).json({ error: "title is required" });

    const result = await notificationService.sendLiveBreakAlert({
      id: id || "",
      title,
      tiktokUrl: tiktokUrl || "",
      thumbnailUrl: thumbnailUrl || "",
    });

    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Live break alert error:", error);
    res.status(500).json({ error: "Failed to send live break alert" });
  }
});

/**
 * POST /api/notifications/admin/new-arrivals
 * Notify users of new product arrivals, optionally filtered by TCG.
 *
 * Body: { message, productId, tcgFilter }
 */
router.post(
  "/admin/new-arrivals",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { message, productId, tcgFilter } = req.body;

      if (!message)
        return res.status(400).json({ error: "message is required" });

      const result = await notificationService.sendNewArrivalsAlert(
        { message, id: productId || "" },
        tcgFilter || null,
      );

      res.json({ success: true, data: result });
    } catch (error) {
      console.error("New arrivals alert error:", error);
      res.status(500).json({ error: "Failed to send new arrivals alert" });
    }
  },
);

/**
 * GET /api/notifications/admin/logs
 * Get admin notification send history.
 */
router.get("/admin/logs", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = admin.firestore();
    const { limit = 50 } = req.query;

    const snapshot = await db
      .collection("adminNotificationLogs")
      .orderBy("sentAt", "desc")
      .limit(parseInt(limit))
      .get();

    const logs = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, data: logs });
  } catch (error) {
    console.error("Get logs error:", error);
    res.status(500).json({ error: "Failed to fetch logs" });
  }
});

/**
 * GET /api/notifications/types
 * Return all valid notification types (for admin UI dropdowns).
 */
router.get("/types", verifyToken, verifyAdmin, async (req, res) => {
  res.json({ success: true, data: NOTIFICATION_TYPES });
});

module.exports = router;
