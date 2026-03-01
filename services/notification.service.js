/**
 * notification.service.js
 *
 * FCM token is stored as a single field on users/{uid}:
 *   fcmToken:    string     — current token (overwritten on refresh)
 *   fcmPlatform: string     — "ios" | "android"
 *   fcmUpdatedAt: timestamp
 *
 * Notification inbox is stored in users/{uid}/notifications subcollection.
 *
 * IMPORTANT: Lazy getters (get db / get messaging) prevent the
 * "default Firebase app does not exist" crash — admin.firestore() and
 * admin.messaging() are only called at request time, never at module load.
 */

const admin = require("firebase-admin");

// ─── Notification Types ───────────────────────────────────────────────────────

const NOTIFICATION_TYPES = {
  ORDER_UPDATE: "order_update",
  LIVE_BREAK: "live_break",
  NEW_ARRIVALS: "new_arrivals",
  EXCLUSIVE_DEAL: "exclusive_deal",
  RESTOCK_ALERT: "restock_alert",
  PRICE_DROP: "price_drop",
  SOCIAL_ACTIVITY: "social_activity",
  GRADING_UPDATE: "grading_update",
  SUBMISSION_UPDATE: "submission_update",
  REWARDS: "rewards",
  SYSTEM: "system",
};

// Maps notification type → user preference key in preferences.notifications
// null = always send (system notifications ignore preferences)
const TYPE_TO_PREF_KEY = {
  [NOTIFICATION_TYPES.ORDER_UPDATE]: "orderUpdates",
  [NOTIFICATION_TYPES.LIVE_BREAK]: "breakReminders",
  [NOTIFICATION_TYPES.NEW_ARRIVALS]: "newArrivalsAlerts",
  [NOTIFICATION_TYPES.EXCLUSIVE_DEAL]: "exclusiveDeals",
  [NOTIFICATION_TYPES.RESTOCK_ALERT]: "restockAlerts",
  [NOTIFICATION_TYPES.PRICE_DROP]: "priceDrops",
  [NOTIFICATION_TYPES.SOCIAL_ACTIVITY]: "socialActivity",
  [NOTIFICATION_TYPES.GRADING_UPDATE]: "orderUpdates",
  [NOTIFICATION_TYPES.SUBMISSION_UPDATE]: "orderUpdates",
  [NOTIFICATION_TYPES.REWARDS]: "exclusiveDeals",
  [NOTIFICATION_TYPES.SYSTEM]: null,
};

// Maps notification type → Android channel ID (must match Notifee channels in App.tsx)
const TYPE_TO_CHANNEL = {
  [NOTIFICATION_TYPES.ORDER_UPDATE]: "orders",
  [NOTIFICATION_TYPES.LIVE_BREAK]: "breaks",
  [NOTIFICATION_TYPES.NEW_ARRIVALS]: "deals",
  [NOTIFICATION_TYPES.EXCLUSIVE_DEAL]: "deals",
  [NOTIFICATION_TYPES.RESTOCK_ALERT]: "deals",
  [NOTIFICATION_TYPES.PRICE_DROP]: "deals",
  [NOTIFICATION_TYPES.SOCIAL_ACTIVITY]: "social",
  [NOTIFICATION_TYPES.GRADING_UPDATE]: "orders",
  [NOTIFICATION_TYPES.SUBMISSION_UPDATE]: "orders",
  [NOTIFICATION_TYPES.REWARDS]: "deals",
  [NOTIFICATION_TYPES.SYSTEM]: "general",
};

// ─── Service ──────────────────────────────────────────────────────────────────

class NotificationService {
  // Lazy getters — called at request time, never at module load
  get db() {
    return admin.firestore();
  }
  get messaging() {
    return admin.messaging();
  }

  // ── Token helpers ─────────────────────────────────────────────────────────
  // Single fcmToken field on the user doc. No subcollection needed.

  /**
   * Read the current FCM token from users/{uid}.fcmToken
   * Returns null if missing — caller should handle gracefully.
   */
  async _getToken(uid) {
    const userDoc = await this.db.collection("users").doc(uid).get();
    const token = userDoc.data()?.fcmToken || null;
    console.log(
      `🎯 Token lookup uid=${uid}:`,
      token ? token.substring(0, 20) + "..." : "NULL — no token saved",
    );
    return token;
  }

  /**
   * Remove the FCM token on logout so stale tokens are never used.
   */
  async clearToken(uid) {
    await this.db.collection("users").doc(uid).update({
      fcmToken: admin.firestore.FieldValue.delete(),
      fcmPlatform: admin.firestore.FieldValue.delete(),
      fcmUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`🗑️ FCM token cleared for uid=${uid}`);
    return { success: true };
  }

  // ── Preference check ──────────────────────────────────────────────────────

  /**
   * Returns true if the user wants this notification type.
   * Defaults to true when the preferences structure doesn't exist yet —
   * new users should receive notifications until they explicitly opt out.
   */
  async _userHasPrefEnabled(uid, notificationType) {
    const prefKey = TYPE_TO_PREF_KEY[notificationType];
    if (prefKey === null) return true; // SYSTEM always sends

    const userDoc = await this.db.collection("users").doc(uid).get();
    if (!userDoc.exists) return false;

    const prefs = userDoc.data()?.preferences?.notifications;

    // No preferences set yet → default all to enabled
    if (!prefs) return true;

    if (prefs.pushNotifications === false) return false;
    return prefs[prefKey] !== false;
  }

  // ── Send to single user ───────────────────────────────────────────────────

  async sendToUser(uid, notification) {
    const {
      type = NOTIFICATION_TYPES.SYSTEM,
      title,
      body,
      data = {},
    } = notification;

    const isEnabled = await this._userHasPrefEnabled(uid, type);
    console.log(`🔔 Pref check uid=${uid} type=${type} enabled=${isEnabled}`);
    if (!isEnabled) return { success: false, reason: "preference_disabled" };

    const token = await this._getToken(uid);
    if (!token) return { success: false, reason: "no_token" };

    const result = await this._sendMessage(
      token,
      { type, title, body, data },
      uid,
    );
    console.log(`📨 FCM result for uid=${uid}:`, JSON.stringify(result));

    if (result.success) {
      await this._saveToInbox(uid, { type, title, body, data });
    }

    return result;
  }

  // ── Broadcast to all users ────────────────────────────────────────────────

  async broadcast(notification, options = {}) {
    const {
      type = NOTIFICATION_TYPES.SYSTEM,
      title,
      body,
      data = {},
    } = notification;
    const { tcgFilter = null } = options;
    const prefKey = TYPE_TO_PREF_KEY[type];

    let query = this.db.collection("users");
    if (tcgFilter) {
      query = query.where(
        "preferences.favoriteCategories",
        "array-contains",
        tcgFilter,
      );
    }

    const snapshot = await query.get();
    console.log(
      `📢 Broadcasting "${title}" to ${snapshot.size} users (tcgFilter=${tcgFilter})`,
    );

    let successCount = 0;
    let skippedCount = 0;

    await Promise.allSettled(
      snapshot.docs.map(async (userDoc) => {
        const uid = userDoc.id;
        const userData = userDoc.data();
        const prefs = userData?.preferences?.notifications;
        const token = userData?.fcmToken;

        // No token — user hasn't registered for notifications
        if (!token) {
          skippedCount++;
          return;
        }

        // Check preference — default to enabled if prefs don't exist yet
        if (prefKey !== null && prefs) {
          if (prefs.pushNotifications === false || prefs[prefKey] === false) {
            skippedCount++;
            return;
          }
        }

        const result = await this._sendMessage(
          token,
          { type, title, body, data },
          uid,
        );
        if (result.success) {
          successCount++;
          await this._saveToInbox(uid, { type, title, body, data });
        } else {
          skippedCount++;
        }
      }),
    );

    console.log(
      `✅ Broadcast complete — sent: ${successCount}, skipped: ${skippedCount}`,
    );
    return { success: true, successCount, skippedCount };
  }

  // ── Convenience methods ───────────────────────────────────────────────────

  async sendOrderUpdate(uid, orderDetails) {
    return this.sendToUser(uid, {
      type: NOTIFICATION_TYPES.ORDER_UPDATE,
      title: "Order Update 📦",
      body: orderDetails.message,
      data: { orderId: orderDetails.orderId || "", screen: "Orders" },
    });
  }

  async sendLiveBreakAlert(breakDetails) {
    return this.broadcast({
      type: NOTIFICATION_TYPES.LIVE_BREAK,
      title: "🔴 Going Live!",
      body: `${breakDetails.title} is starting now`,
      data: {
        breakId: breakDetails.id || "",
        screen: "LiveBreaks",
        tiktokUrl: breakDetails.tiktokUrl || "",
      },
    });
  }

  async sendNewArrivalsAlert(productDetails, tcgFilter = null) {
    return this.broadcast(
      {
        type: NOTIFICATION_TYPES.NEW_ARRIVALS,
        title: "New Arrivals ✨",
        body: productDetails.message,
        data: { productId: productDetails.id || "", screen: "Inventory" },
      },
      { tcgFilter },
    );
  }

  async sendGradingUpdate(uid, submissionDetails) {
    return this.sendToUser(uid, {
      type: NOTIFICATION_TYPES.GRADING_UPDATE,
      title: "Grading Update 🎯",
      body: submissionDetails.message,
      data: {
        submissionId: submissionDetails.id || "",
        screen: "GradingSubmissions",
      },
    });
  }

  async sendRewardsUpdate(uid, pointsDetails) {
    return this.sendToUser(uid, {
      type: NOTIFICATION_TYPES.REWARDS,
      title: "Mo'Rewards 🏆",
      body: pointsDetails.message,
      data: { screen: "Profile" },
    });
  }

  // ── Private: FCM send ─────────────────────────────────────────────────────

  async _sendMessage(token, notification, uid = null) {
    const { type, title, body, data } = notification;

    try {
      const response = await this.messaging.send({
        token,
        notification: { title, body },
        data: this._stringifyData({ ...data, type }),
        android: {
          priority: "high",
          notification: {
            channelId: TYPE_TO_CHANNEL[type] || "general",
            color: "#EAB308",
            sound: "default",
          },
        },
        apns: {
          payload: {
            aps: { sound: "default", badge: 1 },
          },
        },
      });

      console.log(`✅ FCM accepted — messageId: ${response}`);
      return { success: true, messageId: response };
    } catch (error) {
      console.error(`❌ FCM send failed:`, error.code, error.message);

      // Token is stale — clear it so it doesn't block future sends
      if (
        error.code === "messaging/invalid-registration-token" ||
        error.code === "messaging/registration-token-not-registered"
      ) {
        if (uid) {
          console.log(`🗑️ Clearing stale token for uid=${uid}`);
          await this.clearToken(uid).catch(() => {});
        }
      }

      return { success: false, error: error.code };
    }
  }

  // ── Private: Inbox ────────────────────────────────────────────────────────
  // Saves a copy to users/{uid}/notifications for the in-app inbox.

  async _saveToInbox(uid, notification) {
    try {
      await this.db
        .collection("users")
        .doc(uid)
        .collection("notifications")
        .add({
          ...notification,
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    } catch (error) {
      // Don't let inbox save failure block the FCM send result
      console.error(
        `⚠️ Failed to save inbox notification for uid=${uid}:`,
        error.message,
      );
    }
  }

  // ── Private: Helpers ──────────────────────────────────────────────────────

  // FCM data payload values must all be strings
  _stringifyData(data) {
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = String(value ?? "");
    }
    return result;
  }
}

module.exports = new NotificationService();
module.exports.NOTIFICATION_TYPES = NOTIFICATION_TYPES;
