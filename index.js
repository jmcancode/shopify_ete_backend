require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const http = require("http");
const { initBroadcast } = require("./routes/broadcast.routes.js");

const shopifyProductsRoutes = require("./routes/shopify-products.routes.js");
const shopifyCheckoutRoutes = require("./routes/shopify-checkout.routes.js");
const testShopifyRoutes = require("./routes/test-shopify.routes");
const shopifyCustomerRoutes = require("./routes/shopify-customer.routes.js");
const rewardsRoutes = require("./routes/shopify-rewards.routes.js");
const notificationsRoutes = require("./routes/notification.routes.js");
const cardPriceCheckRoutes = require("./routes/card-price-check.routes");
const notificationTriggersRoutes = require("./routes/notification-triggers.routes.js");
const pricingRoutes = require("./routes/pricing.js");
const pricingSearchRoute = require("./routes/pricing-search.route.js");
const shopifyBulkRoutes = require("./routes/Shopifyproductbulk.routes.js");

// Initialize Express
const app = express();
const PORT = process.env.PORT || 4200;
const httpServer = http.createServer(app);
initBroadcast(httpServer);
// ── Firebase Admin SDK ───────────────────────────────────────────────────────
const serviceAccount = require("./serviceAccountKey.js");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const auth = admin.auth();
db.settings({ ignoreUndefinedProperties: true });

// ============================================================================
// MIDDLEWARE
// ============================================================================

// Verify Firebase Auth Token
// ============================================================================
// UPDATED MIDDLEWARE - Replace your existing middleware with this
// ============================================================================

// Verify Firebase Auth Token
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ error: "Unauthorized", message: "No token provided" });
    }

    const token = authHeader.split("Bearer ")[1];
    const decodedToken = await auth.verifyIdToken(token);

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
    };

    next();
  } catch (error) {
    console.error("Auth error:", error);
    res
      .status(401)
      .json({ error: "Unauthorized", message: "Invalid or expired token" });
  }
};

// Verify Admin (check Firestore roles)
const verifyAdmin = async (req, res, next) => {
  try {
    // Check Firestore user document for isAdmin role
    const userDoc = await db.collection("users").doc(req.user.uid).get();

    if (!userDoc.exists) {
      return res
        .status(403)
        .json({ error: "Forbidden", message: "User profile not found" });
    }

    const userData = userDoc.data();
    const isAdmin = userData.roles?.isAdmin === true;

    if (!isAdmin) {
      return res
        .status(403)
        .json({ error: "Forbidden", message: "Admin access required" });
    }

    // Set admin flag and displayName for downstream use
    req.user.admin = true;
    req.user.displayName = userData.displayName || userData.firstName || null;

    next();
  } catch (error) {
    console.error("Admin verification error:", error);
    res
      .status(403)
      .json({ error: "Forbidden", message: "Admin verification failed" });
  }
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api/shopify", shopifyProductsRoutes);
app.use("/api/shopify", shopifyCheckoutRoutes);
app.use("/api/shopify", testShopifyRoutes);
app.use("/api/shopify", shopifyCustomerRoutes);
app.use("/api/shopify/bulk", verifyToken, verifyAdmin, shopifyBulkRoutes);
app.use("/api/rewards", rewardsRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/card-price-check", cardPriceCheckRoutes);
app.use("/api/notify", notificationTriggersRoutes);
app.use("/api/pricing", pricingRoutes);
app.use("/api/pricing", pricingSearchRoute);

// ── Mux routes mounted later (after verifyToken/verifyAdmin are defined) ─────
const muxRoutes = require("./routes/mux.routes.js");
app.use("/api/mux", muxRoutes(verifyToken, verifyAdmin));
// ============================================================================
// GRADING ENDPOINTS
// ============================================================================

// Submit grading request (user already uploads images to Firebase Storage from mobile app)
app.post("/api/grading/submit", verifyToken, async (req, res) => {
  try {
    const {
      cardName,
      cardSet,
      cardNumber,
      estimatedValue,
      condition,
      specialNotes,
      frontImageUrl,
      backImageUrl,
    } = req.body;

    // Validate required fields
    if (
      !cardName ||
      !cardSet ||
      !cardNumber ||
      !frontImageUrl ||
      !backImageUrl
    ) {
      return res.status(400).json({
        error: "Bad Request",
        message:
          "Missing required fields: cardName, cardSet, cardNumber, frontImageUrl, backImageUrl",
      });
    }

    const submission = {
      userId: req.user.uid,
      cardName,
      cardSet,
      cardNumber,
      estimatedValue: estimatedValue || 0,
      condition: condition || "Unknown",
      specialNotes: specialNotes || "",
      frontImageUrl,
      backImageUrl,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("submissions").add(submission);

    res.status(201).json({
      success: true,
      data: {
        id: docRef.id,
        ...submission,
      },
    });
  } catch (error) {
    console.error("Submit error:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: "Failed to create submission",
    });
  }
});

// Get user's submissions
app.get("/api/grading/submissions", verifyToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 20;
    const offset = (page - 1) * pageSize;

    const snapshot = await db
      .collection("submissions")
      .where("userId", "==", req.user.uid)
      .orderBy("createdAt", "desc")
      .limit(pageSize)
      .offset(offset)
      .get();

    const submissions = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json({
      success: true,
      data: submissions,
      page,
      pageSize,
    });
  } catch (error) {
    console.error("Get submissions error:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: "Failed to retrieve submissions",
    });
  }
});

// Get specific submission
app.get("/api/grading/submissions/:id", verifyToken, async (req, res) => {
  try {
    const doc = await db.collection("submissions").doc(req.params.id).get();

    if (!doc.exists) {
      return res
        .status(404)
        .json({ error: "Not Found", message: "Submission not found" });
    }

    const submission = doc.data();

    // Verify ownership
    if (submission.userId !== req.user.uid) {
      return res
        .status(403)
        .json({ error: "Forbidden", message: "Access denied" });
    }

    res.json({
      success: true,
      data: {
        id: doc.id,
        ...submission,
      },
    });
  } catch (error) {
    console.error("Get submission error:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: "Failed to retrieve submission",
    });
  }
});

// ============================================================================
// ADMIN ENDPOINTS
// ============================================================================

// Get all submissions (admin only)
app.get(
  "/api/admin/submissions",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const pageSize = parseInt(req.query.pageSize) || 50;
      const status = req.query.status;
      const offset = (page - 1) * pageSize;

      let query = db.collection("submissions").orderBy("createdAt", "desc");

      if (status) {
        query = query.where("status", "==", status);
      }

      const snapshot = await query.limit(pageSize).offset(offset).get();

      const submissions = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));

      res.json({
        success: true,
        data: submissions,
        page,
        pageSize,
      });
    } catch (error) {
      console.error("Admin get submissions error:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to retrieve submissions",
      });
    }
  },
);

// Update submission status (admin only)
app.patch(
  "/api/admin/submissions/:id/status",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { status } = req.body;

      if (!status) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "Status is required" });
      }

      const validStatuses = [
        "pending",
        "received",
        "grading",
        "complete",
        "shipped",
      ];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          error: "Bad Request",
          message: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        });
      }

      await db.collection("submissions").doc(req.params.id).update({
        status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.json({ success: true, message: "Status updated successfully" });
    } catch (error) {
      console.error("Update status error:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to update status",
      });
    }
  },
);

// Add grading results (admin only)
app.patch(
  "/api/admin/submissions/:id/grade",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { grade, gradedBy, notes } = req.body;

      if (!grade || !gradedBy || !notes) {
        return res.status(400).json({
          error: "Bad Request",
          message: "grade, gradedBy, and notes are required",
        });
      }

      if (typeof grade !== "number" || grade < 0 || grade > 10) {
        return res.status(400).json({
          error: "Bad Request",
          message: "grade must be a number between 0 and 10",
        });
      }

      await db
        .collection("submissions")
        .doc(req.params.id)
        .update({
          gradingResults: {
            grade,
            gradedBy,
            gradedAt: admin.firestore.FieldValue.serverTimestamp(),
            notes,
          },
          status: "complete",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      res.json({
        success: true,
        message: "Grading results added successfully",
      });
    } catch (error) {
      console.error("Add grade error:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to add grading results",
      });
    }
  },
);

// ============================================================================
// MESSAGING/NOTIFICATIONS ENDPOINTS
// ============================================================================

// Send push notification only (admin only)
app.post(
  "/api/notifications/push",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { title, message, type, targetAudience } = req.body;

      if (!title || !message) {
        return res.status(400).json({
          error: "Bad Request",
          message: "title and message are required",
        });
      }

      const notification = {
        title,
        message,
        type: type || "general",
        targetAudience: targetAudience || "all",
        sentBy: req.user.uid,
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        channel: "push",
      };

      // Save notification to Firestore
      const docRef = await db.collection("notifications").add(notification);

      // TODO: Send push notification to mobile devices
      // const pushResult = await sendPushNotification(title, message, targetAudience);

      res.json({
        success: true,
        data: {
          id: docRef.id,
          // pushSent: pushResult.success
        },
      });
    } catch (error) {
      console.error("Send push notification error:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to send push notification",
      });
    }
  },
);

// Send Discord notification only (admin only)
app.post(
  "/api/notifications/discord",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { title, message, channelName } = req.body;

      if (!title || !message || !channelName) {
        return res.status(400).json({
          error: "Bad Request",
          message: "title, message, and channelName are required",
        });
      }

      const notification = {
        title,
        message,
        channelName,
        sentBy: req.user.uid,
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        channel: "discord",
      };

      // Save notification to Firestore
      const docRef = await db.collection("notifications").add(notification);

      // Send Discord notification
      const discordResult = await sendDiscordNotification(
        title,
        message,
        channelName,
      );

      if (!discordResult.success) {
        return res.status(500).json({
          error: "Discord Error",
          message: discordResult.error || "Failed to send Discord notification",
        });
      }

      res.json({
        success: true,
        data: {
          id: docRef.id,
          discordSent: true,
        },
      });
    } catch (error) {
      console.error("Send Discord notification error:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to send Discord notification",
      });
    }
  },
);

// Send to both push and Discord (admin only)
app.post(
  "/api/notifications/broadcast",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { title, message, type, targetAudience, discordChannels } =
        req.body;

      if (!title || !message) {
        return res.status(400).json({
          error: "Bad Request",
          message: "title and message are required",
        });
      }

      const notification = {
        title,
        message,
        type: type || "general",
        targetAudience: targetAudience || "all",
        discordChannels: discordChannels || [],
        sentBy: req.user.uid,
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        channel: "broadcast",
      };

      // Save notification to Firestore
      const docRef = await db.collection("notifications").add(notification);

      // Send to Discord channels
      const discordResults = [];
      if (discordChannels && discordChannels.length > 0) {
        for (const channelName of discordChannels) {
          const result = await sendDiscordNotification(
            title,
            message,
            channelName,
          );
          discordResults.push({
            channel: channelName,
            success: result.success,
          });
        }
      }

      // TODO: Send push notification
      // const pushResult = await sendPushNotification(title, message, targetAudience);

      res.json({
        success: true,
        data: {
          id: docRef.id,
          discordResults,
          // pushSent: pushResult.success
        },
      });
    } catch (error) {
      console.error("Send broadcast error:", error);
      res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to send broadcast",
      });
    }
  },
);

// Get all Discord channels (admin only)
app.get(
  "/api/admin/discord/channels",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const doc = await db.collection("settings").doc("discord").get();

      if (!doc.exists) {
        return res.json({
          success: true,
          data: [],
        });
      }

      const channels = doc.data().channels || [];

      res.json({
        success: true,
        data: channels,
      });
    } catch (error) {
      console.error("Get Discord channels error:", error);
      res.status(500).json({ error: "Failed to get Discord channels" });
    }
  },
);

// Add or update Discord channel webhook (admin only)
app.post(
  "/api/admin/discord/channels",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { channelName, webhookUrl, enabled } = req.body;

      if (!channelName || !webhookUrl) {
        return res.status(400).json({
          error: "Bad Request",
          message: "channelName and webhookUrl are required",
        });
      }

      // Validate webhook URL format
      if (!webhookUrl.startsWith("https://discord.com/api/webhooks/")) {
        return res.status(400).json({
          error: "Bad Request",
          message: "Invalid Discord webhook URL",
        });
      }

      const doc = await db.collection("settings").doc("discord").get();
      const currentChannels = doc.exists ? doc.data().channels || [] : [];

      // Check if channel already exists
      const existingIndex = currentChannels.findIndex(
        (ch) => ch.channelName === channelName,
      );

      const channelData = {
        channelName,
        webhookUrl,
        enabled: enabled !== false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: req.user.uid,
      };

      if (existingIndex >= 0) {
        // Update existing
        currentChannels[existingIndex] = channelData;
      } else {
        // Add new
        currentChannels.push(channelData);
      }

      await db.collection("settings").doc("discord").set(
        {
          channels: currentChannels,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      res.json({
        success: true,
        message: `Discord channel ${existingIndex >= 0 ? "updated" : "added"}`,
      });
    } catch (error) {
      console.error("Update Discord channel error:", error);
      res.status(500).json({ error: "Failed to update Discord channel" });
    }
  },
);

// Delete Discord channel (admin only)
app.delete(
  "/api/admin/discord/channels/:channelName",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { channelName } = req.params;

      const doc = await db.collection("settings").doc("discord").get();

      if (!doc.exists) {
        return res
          .status(404)
          .json({ error: "No Discord channels configured" });
      }

      const currentChannels = doc.data().channels || [];
      const filteredChannels = currentChannels.filter(
        (ch) => ch.channelName !== channelName,
      );

      if (filteredChannels.length === currentChannels.length) {
        return res.status(404).json({ error: "Channel not found" });
      }

      await db.collection("settings").doc("discord").update({
        channels: filteredChannels,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.json({
        success: true,
        message: "Discord channel deleted",
      });
    } catch (error) {
      console.error("Delete Discord channel error:", error);
      res.status(500).json({ error: "Failed to delete Discord channel" });
    }
  },
);

// Helper function to send Discord notification
async function sendDiscordNotification(title, message, channelName) {
  try {
    // Get channels from Firestore
    const settingsDoc = await db.collection("settings").doc("discord").get();

    if (!settingsDoc.exists) {
      console.log("No Discord settings configured");
      return { success: false, error: "No Discord settings configured" };
    }

    const channels = settingsDoc.data().channels || [];
    const channel = channels.find((ch) => ch.channelName === channelName);

    if (!channel) {
      console.log(`Discord channel ${channelName} not found`);
      return { success: false, error: `Channel ${channelName} not found` };
    }

    if (!channel.enabled) {
      console.log(`Discord channel ${channelName} is disabled`);
      return { success: false, error: `Channel ${channelName} is disabled` };
    }

    const response = await fetch(channel.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: title,
            description: message,
            color: 0x3b82f6, // Blue
            timestamp: new Date().toISOString(),
            footer: {
              text: "Elite Trainer Exchange",
            },
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Discord API error:", response.status, errorText);
      return { success: false, error: errorText };
    }

    return { success: true };
  } catch (error) {
    console.error("Discord notification error:", error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// SELL TO US / BUY RATES ENDPOINTS
// ============================================================================
// Add these endpoints to your server.js file BEFORE the HEALTH CHECK section

// Get buy rates (public)
app.get("/api/sell/rates", async (req, res) => {
  try {
    const doc = await db.collection("settings").doc("buyRates").get();

    if (!doc.exists) {
      // Return defaults if not set
      return res.json({
        success: true,
        data: {
          "one-piece": 0.7,
          "raw-singles": 0.7,
          "vintage-booster": 0.7,
          "modern-booster": 0.7,
          "graded-card": 0.7,
          etb: 0.7,
          "pokemon-singles": 0.7,
          default: 0.7,
        },
      });
    }

    res.json({
      success: true,
      data: doc.data(),
    });
  } catch (error) {
    console.error("Get buy rates error:", error);
    res.status(500).json({ error: "Failed to fetch buy rates" });
  }
});

// Update buy rates (admin only)
app.put("/api/sell/rates", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const rates = req.body;

    // Validate rates
    const validKeys = [
      "one-piece",
      "raw-singles",
      "vintage-booster",
      "modern-booster",
      "graded-card",
      "etb",
      "pokemon-singles",
      "default",
    ];

    for (const key of validKeys) {
      if (rates[key] !== undefined) {
        const value = parseFloat(rates[key]);
        if (isNaN(value) || value < 0 || value > 1) {
          return res.status(400).json({
            error: "Bad Request",
            message: `${key} must be a number between 0 and 1`,
          });
        }
      }
    }

    await db
      .collection("settings")
      .doc("buyRates")
      .set(
        {
          ...rates,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedBy: req.user.uid,
        },
        { merge: true },
      );

    res.json({
      success: true,
      message: "Buy rates updated successfully",
    });
  } catch (error) {
    console.error("Update buy rates error:", error);
    res.status(500).json({ error: "Failed to update buy rates" });
  }
});

// Get all sell submissions (admin only)
app.get("/api/sell/submissions", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const snapshot = await db
      .collection("sellSubmissions")
      .orderBy("createdAt", "desc")
      .get();

    const submissions = [];
    snapshot.forEach((doc) => {
      submissions.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    res.json({
      success: true,
      data: submissions,
    });
  } catch (error) {
    console.error("Get submissions error:", error);
    res.status(500).json({ error: "Failed to fetch submissions" });
  }
});

// Get single submission
app.get("/api/sell/submissions/:id", verifyToken, async (req, res) => {
  try {
    const doc = await db.collection("sellSubmissions").doc(req.params.id).get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Submission not found" });
    }

    const submission = doc.data();

    // Check permissions: admin or owner
    const isAdmin = req.user.admin === true;
    const isOwner = submission.userId === req.user.uid;

    if (!isAdmin && !isOwner) {
      return res.status(403).json({ error: "Access denied" });
    }

    res.json({
      success: true,
      data: {
        id: doc.id,
        ...submission,
      },
    });
  } catch (error) {
    console.error("Get submission error:", error);
    res.status(500).json({ error: "Failed to fetch submission" });
  }
});

// Update submission status (admin only)
app.patch(
  "/api/sell/submissions/:id/status",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { status, reviewNotes } = req.body;

      const validStatuses = ["in-review", "approved", "declined", "draft"];

      if (status && !validStatuses.includes(status)) {
        return res.status(400).json({
          error: "Bad Request",
          message: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        });
      }

      const updateData = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (status) updateData.status = status;
      if (reviewNotes !== undefined) updateData.reviewNotes = reviewNotes;

      await db
        .collection("sellSubmissions")
        .doc(req.params.id)
        .update(updateData);

      res.json({
        success: true,
        message: "Submission updated successfully",
      });
    } catch (error) {
      console.error("Update submission error:", error);
      res.status(500).json({ error: "Failed to update submission" });
    }
  },
);

// Delete submission (admin only)
app.delete(
  "/api/sell/submissions/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      await db.collection("sellSubmissions").doc(req.params.id).delete();

      res.json({
        success: true,
        message: "Submission deleted successfully",
      });
    } catch (error) {
      console.error("Delete submission error:", error);
      res.status(500).json({ error: "Failed to delete submission" });
    }
  },
);

// Get home visit requests (admin only)
app.get("/api/sell/home-visits", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const snapshot = await db
      .collection("homeVisitRequests")
      .orderBy("createdAt", "desc")
      .get();

    const requests = [];
    snapshot.forEach((doc) => {
      requests.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    res.json({
      success: true,
      data: requests,
    });
  } catch (error) {
    console.error("Get home visits error:", error);
    res.status(500).json({ error: "Failed to fetch home visit requests" });
  }
});

// Update home visit request status (admin only)
app.patch(
  "/api/sell/home-visits/:id/status",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { status } = req.body;

      const validStatuses = [
        "pending",
        "contacted",
        "scheduled",
        "completed",
        "cancelled",
      ];

      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          error: "Bad Request",
          message: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        });
      }

      await db.collection("homeVisitRequests").doc(req.params.id).update({
        status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.json({
        success: true,
        message: "Home visit status updated successfully",
      });
    } catch (error) {
      console.error("Update home visit error:", error);
      res.status(500).json({ error: "Failed to update home visit status" });
    }
  },
);

// ============================================================================
// CARDS DATABASE SEARCH (for autocomplete in submission forms)
// ============================================================================

// Search cards (public - for autocomplete)
app.get("/api/cards/search", async (req, res) => {
  try {
    const { query, set, limit = 10 } = req.query;

    if (!query || query.trim().length < 2) {
      return res.json({
        success: true,
        data: [],
      });
    }

    const searchTerm = query.toLowerCase();

    // Get cards from database
    const snapshot = await db.collection("cards").limit(100).get();

    const results = [];
    snapshot.forEach((doc) => {
      const card = doc.data();
      const cardName = (card.name || "").toLowerCase();

      // Simple search: check if card name contains search term
      if (cardName.includes(searchTerm)) {
        // Filter by set if provided
        if (!set || card.set === set) {
          results.push({
            id: doc.id,
            name: card.name,
            set: card.set,
            number: card.number,
            rarity: card.rarity,
            price: card.price || 0,
          });
        }
      }
    });

    // Sort by relevance (exact matches first)
    results.sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aExact = aName === searchTerm ? 0 : 1;
      const bExact = bName === searchTerm ? 0 : 1;
      return aExact - bExact;
    });

    res.json({
      success: true,
      data: results.slice(0, parseInt(limit)),
    });
  } catch (error) {
    console.error("Search cards error:", error);
    res.status(500).json({ error: "Failed to search cards" });
  }
});

// Get all sets (for dropdown)
app.get("/api/cards/sets", async (req, res) => {
  try {
    const snapshot = await db.collection("sets").get();

    const sets = [];
    snapshot.forEach((doc) => {
      sets.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    res.json({
      success: true,
      data: sets,
    });
  } catch (error) {
    console.error("Get sets error:", error);
    res.status(500).json({ error: "Failed to fetch sets" });
  }
});

// ============================================================================
// BUY LIST ENDPOINTS
// ============================================================================

// Get all buy list items
app.get("/api/buylist", async (req, res) => {
  try {
    const snapshot = await db.collection("buylist").get();
    const items = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Sort by createdAt in memory
    items.sort((a, b) => {
      if (!a.createdAt || !b.createdAt) return 0;
      return b.createdAt.toMillis() - a.createdAt.toMillis();
    });

    res.json({ success: true, data: items });
  } catch (error) {
    console.error("Get buylist error:", error);
    res.status(500).json({ error: "Failed to fetch buy list" });
  }
});

// Get single buy list item
app.get("/api/buylist/:id", async (req, res) => {
  try {
    const doc = await db.collection("buylist").doc(req.params.id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: "Item not found" });
    }
    res.json({ success: true, data: { id: doc.id, ...doc.data() } });
  } catch (error) {
    console.error("Get buylist item error:", error);
    res.status(500).json({ error: "Failed to fetch item" });
  }
});

// Create buy list item (admin only)
app.post("/api/buylist", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const {
      cardName,
      set,
      cardType,
      price,
      quantity,
      condition,
      grader,
      gradeValue,
      notes,
      imageUrl,
    } = req.body;

    if (!cardName || !set || !price) {
      return res.status(400).json({
        error: "Bad Request",
        message: "cardName, set, and price are required",
      });
    }

    const item = {
      cardName,
      set,
      cardType: cardType || "Single Card",
      price: parseFloat(price),
      quantity: quantity || 1,
      condition: condition || "NM",
      grader: grader || "",
      gradeValue: gradeValue || "",
      notes: notes || "",
      imageUrl: imageUrl || "",
      active: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: req.user.uid,
    };

    const docRef = await db.collection("buylist").add(item);

    res.status(201).json({
      success: true,
      data: { id: docRef.id, ...item },
    });
  } catch (error) {
    console.error("Create buylist error:", error);
    res.status(500).json({ error: "Failed to create buy list item" });
  }
});

// Update buy list item (admin only)
app.patch("/api/buylist/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const {
      cardName,
      set,
      cardType,
      price,
      quantity,
      condition,
      grader,
      gradeValue,
      notes,
      imageUrl,
      active,
    } = req.body;

    const updates = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (cardName !== undefined) updates.cardName = cardName;
    if (set !== undefined) updates.set = set;
    if (cardType !== undefined) updates.cardType = cardType;
    if (price !== undefined) updates.price = parseFloat(price);
    if (quantity !== undefined) updates.quantity = quantity;
    if (condition !== undefined) updates.condition = condition;
    if (grader !== undefined) updates.grader = grader;
    if (gradeValue !== undefined) updates.gradeValue = gradeValue;
    if (notes !== undefined) updates.notes = notes;
    if (imageUrl !== undefined) updates.imageUrl = imageUrl;
    if (active !== undefined) updates.active = active;

    await db.collection("buylist").doc(req.params.id).update(updates);

    res.json({ success: true, message: "Buy list item updated" });
  } catch (error) {
    console.error("Update buylist error:", error);
    res.status(500).json({ error: "Failed to update item" });
  }
});

// Delete buy list item (admin only)
app.delete("/api/buylist/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    await db.collection("buylist").doc(req.params.id).delete();
    res.json({ success: true, message: "Buy list item deleted" });
  } catch (error) {
    console.error("Delete buylist error:", error);
    res.status(500).json({ error: "Failed to delete item" });
  }
});

// Bulk import cards from Excel (admin only)
app.post("/api/buylist/import", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { cards } = req.body;

    if (!Array.isArray(cards)) {
      return res.status(400).json({ error: "cards must be an array" });
    }

    const batch = db.batch();
    const results = [];

    for (const card of cards) {
      // Skip empty rows
      if (!card.cardName || card.cardName.trim() === "") {
        continue;
      }

      const docRef = db.collection("buylist").doc();
      const item = {
        cardName: card.cardName || "",
        set: card.set || "",
        cardType: card.cardType || "Single Card",
        price: parseFloat(card.price || 0),
        quantity: parseInt(card.quantity || 1),
        condition: card.condition || "NM",
        grader: card.grader || "",
        gradeValue: card.gradeValue || "",
        notes: card.notes || "",
        imageUrl: card.imageUrl || "",
        active: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: req.user.uid,
      };

      batch.set(docRef, item);
      results.push({ id: docRef.id, ...item });
    }

    await batch.commit();

    res.json({
      success: true,
      message: `${results.length} items imported`,
      data: results,
    });
  } catch (error) {
    console.error("Import buylist error:", error);
    res.status(500).json({
      error: "Failed to import items",
      details: error.message,
    });
  }
});

// ============================================================================
// SHOWS ENDPOINTS
// ============================================================================

// Update your server.js - GET /api/shows endpoint
app.get("/api/shows", async (req, res) => {
  try {
    const snapshot = await db
      .collection("shows")
      .orderBy("startDate", "desc")
      .get();

    const shows = snapshot.docs.map((doc) => ({
      id: doc.id,
      name: doc.data().name,
      venue: doc.data().venue,
      city: doc.data().city,
      state: doc.data().state,
      latitude: doc.data().latitude || "",
      longitude: doc.data().longitude || "",
      date: doc.data().date,
      startDate: doc.data().startDate,
      endDate: doc.data().endDate,
      startTime: doc.data().startTime,
      endTime: doc.data().endTime,
      ticketUrl: doc.data().ticketUrl,
      eventUrl: doc.data().eventUrl,
      boothNumber: doc.data().boothNumber,
      lookingToBuy: doc.data().lookingToBuy || [],
      notes: doc.data().notes,
      showNotes: doc.data().showNotes,
      featured: doc.data().featured || false,
      budgets: doc.data().budgets || { table: 0, travel: 0, inventory: 0 },
      expenses: doc.data().expenses || {
        table: 0,
        travel: 0,
        inventory: 0,
        other: 0,
      },
      plannedInventory: doc.data().plannedInventory,
      createdAt: doc.data().createdAt,
      updatedAt: doc.data().updatedAt,
      createdBy: doc.data().createdBy,
    }));

    res.json({
      success: true,
      data: shows,
    });
  } catch (error) {
    console.error("Error fetching shows:", error);
    res.status(500).json({
      error: "Failed to fetch shows",
      details: error.message,
    });
  }
});

// Update POST /api/shows endpoint
app.post("/api/shows", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const {
      name,
      venue,
      city,
      state,
      latitude,
      longitude,
      date,
      startDate,
      endDate,
      startTime,
      endTime,
      ticketUrl,
      eventUrl,
      boothNumber,
      lookingToBuy,
      notes,
      featured,
      budgets,
      expenses,
      plannedInventory,
      showNotes,
    } = req.body;

    if (!name || !startDate || !endDate) {
      return res
        .status(400)
        .json({ error: "Name, start date, and end date are required" });
    }

    // Convert date strings to Firestore Timestamps
    let startTimestamp = null;
    let endTimestamp = null;

    if (startDate) {
      const start = new Date(startDate);
      if (!isNaN(start.getTime())) {
        startTimestamp = admin.firestore.Timestamp.fromDate(start);
      }
    }

    if (endDate) {
      const end = new Date(endDate);
      if (!isNaN(end.getTime())) {
        endTimestamp = admin.firestore.Timestamp.fromDate(end);
      }
    }

    const newShow = {
      name: name || "",
      venue: venue || "",
      city: city || "",
      state: state || "",
      latitude: latitude || "",
      longitude: longitude || "",
      date: date || "",
      startDate: startTimestamp,
      endDate: endTimestamp,
      startTime: startTime || "09:00",
      endTime: endTime || "17:00",
      ticketUrl: ticketUrl || "",
      eventUrl: eventUrl || "",
      boothNumber: boothNumber || "",
      lookingToBuy: lookingToBuy || [],
      notes: notes || "",
      featured: featured || false,
      budgets: budgets || { table: 0, travel: 0, inventory: 0 },
      expenses: expenses || { table: 0, travel: 0, inventory: 0, other: 0 },
      plannedInventory: plannedInventory || "",
      showNotes: showNotes || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: req.user.uid,
    };

    const docRef = await db.collection("shows").add(newShow);

    res.status(201).json({
      success: true,
      data: { id: docRef.id, ...newShow },
    });
  } catch (error) {
    console.error("Error creating show:", error);
    res.status(500).json({
      error: "Failed to create show",
      details: error.message,
    });
  }
});

// Update PATCH /api/shows/:id endpoint
app.patch("/api/shows/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body };

    // Convert date strings to Firestore Timestamps if present
    if (updateData.startDate) {
      const start = new Date(updateData.startDate);
      if (!isNaN(start.getTime())) {
        updateData.startDate = admin.firestore.Timestamp.fromDate(start);
      }
    }

    if (updateData.endDate) {
      const end = new Date(updateData.endDate);
      if (!isNaN(end.getTime())) {
        updateData.endDate = admin.firestore.Timestamp.fromDate(end);
      }
    }

    // Add latitude and longitude if present
    if (updateData.latitude !== undefined) {
      updateData.latitude = updateData.latitude || "";
    }
    if (updateData.longitude !== undefined) {
      updateData.longitude = updateData.longitude || "";
    }

    updateData.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await db.collection("shows").doc(id).update(updateData);

    res.json({
      success: true,
      message: "Show updated successfully",
    });
  } catch (error) {
    console.error("Error updating show:", error);
    res.status(500).json({
      error: "Failed to update show",
      details: error.message,
    });
  }
});

// Update the import endpoint too
app.post("/api/shows/import", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { shows } = req.body;

    if (!Array.isArray(shows)) {
      return res.status(400).json({ error: "shows must be an array" });
    }

    const batch = db.batch();
    const results = [];

    for (const show of shows) {
      if (!show.name || show.name.trim() === "") {
        continue;
      }

      const docRef = db.collection("shows").doc();

      let startDate = null;
      let endDate = null;

      if (show.startDate) {
        const start = new Date(show.startDate);
        if (!isNaN(start.getTime())) {
          startDate = admin.firestore.Timestamp.fromDate(start);
        }
      }

      if (show.endDate) {
        const end = new Date(show.endDate);
        if (!isNaN(end.getTime())) {
          endDate = admin.firestore.Timestamp.fromDate(end);
        }
      }

      const item = {
        name: show.name || "",
        venue: show.venue || "",
        city: show.city || "",
        state: show.state || "",
        latitude: show.latitude || "",
        longitude: show.longitude || "",
        date: show.date || "",
        startDate: startDate,
        endDate: endDate,
        startTime: show.startTime || "09:00",
        endTime: show.endTime || "17:00",
        ticketUrl: show.ticketUrl || "",
        eventUrl: show.eventUrl || "",
        boothNumber: show.boothNumber || "",
        lookingToBuy: show.lookingToBuy || [],
        notes: show.notes || "",
        featured: show.featured || false,
        budgets: show.budgets || { table: 0, travel: 0, inventory: 0 },
        expenses: show.expenses || {
          table: 0,
          travel: 0,
          inventory: 0,
          other: 0,
        },
        plannedInventory: show.plannedInventory || "",
        showNotes: show.showNotes || "",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: req.user.uid,
      };

      batch.set(docRef, item);
      results.push({ id: docRef.id, ...item });
    }

    await batch.commit();

    res.json({
      success: true,
      message: `${results.length} shows imported`,
      data: results,
    });
  } catch (error) {
    console.error("Import shows error:", error);
    res.status(500).json({
      error: "Failed to import shows",
      details: error.message,
    });
  }
});

// ============================================================================
// CUSTOMER SUPPORT TICKETS ENDPOINTS
// ============================================================================

// Get all tickets (admin only)
app.get("/api/support/tickets", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection("customerTickets").get();

    const tickets = [];
    snapshot.forEach((doc) => {
      tickets.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    // Sort by most recent
    tickets.sort((a, b) => {
      const dateA = a.createdAt?._seconds || 0;
      const dateB = b.createdAt?._seconds || 0;
      return dateB - dateA;
    });

    res.json({
      success: true,
      data: tickets,
    });
  } catch (error) {
    console.error("Get tickets error:", error);
    res.status(500).json({ error: "Failed to fetch tickets" });
  }
});

// Get tickets for current user
app.get("/api/support/my-tickets", verifyToken, async (req, res) => {
  try {
    const snapshot = await db
      .collection("customerTickets")
      .where("userId", "==", req.user.uid)
      .get();

    const tickets = [];
    snapshot.forEach((doc) => {
      tickets.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    // Sort by most recent
    tickets.sort((a, b) => {
      const dateA = a.createdAt?._seconds || 0;
      const dateB = b.createdAt?._seconds || 0;
      return dateB - dateA;
    });

    res.json({
      success: true,
      data: tickets,
    });
  } catch (error) {
    console.error("Get user tickets error:", error);
    res.status(500).json({ error: "Failed to fetch tickets" });
  }
});

// Get single ticket by ID
app.get("/api/support/tickets/:ticketId", verifyToken, async (req, res) => {
  try {
    const { ticketId } = req.params;
    const doc = await db.collection("customerTickets").doc(ticketId).get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Ticket not found" });
    }

    const ticket = { id: doc.id, ...doc.data() };

    // Check permissions: admin or ticket owner
    const isAdmin = req.user.admin === true;
    const isOwner = ticket.userId === req.user.uid;

    if (!isAdmin && !isOwner) {
      return res.status(403).json({ error: "Access denied" });
    }

    res.json({
      success: true,
      data: ticket,
    });
  } catch (error) {
    console.error("Get ticket error:", error);
    res.status(500).json({ error: "Failed to fetch ticket" });
  }
});

// Create new ticket (user)
app.post("/api/support/tickets", verifyToken, async (req, res) => {
  try {
    const {
      category,
      subject,
      description,
      orderNumber,
      attachments = [],
    } = req.body;

    // Validation
    if (!category || !subject || !description) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Category, subject, and description are required",
      });
    }

    const ticketNumber = `TICKET-${Date.now().toString().slice(-6)}${Math.floor(
      Math.random() * 1000,
    )
      .toString()
      .padStart(3, "0")}`;

    const ticketData = {
      ticketNumber,
      userId: req.user.uid,
      userEmail: req.user.email,
      userName: req.user.displayName || "Customer",
      category,
      priority: "medium",
      status: "open",
      subject,
      description,
      orderNumber: orderNumber || null,
      attachments,
      responses: [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("customerTickets").add(ticketData);

    res.status(201).json({
      success: true,
      data: {
        id: docRef.id,
        ...ticketData,
      },
    });
  } catch (error) {
    console.error("Create ticket error:", error);
    res.status(500).json({ error: "Failed to create ticket" });
  }
});

// Update ticket status (admin only)
app.patch(
  "/api/support/tickets/:ticketId/status",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { ticketId } = req.params;
      const { status } = req.body;

      const validStatuses = [
        "open",
        "in-progress",
        "waiting-customer",
        "resolved",
        "closed",
      ];

      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          error: "Bad Request",
          message: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        });
      }

      const updateData = {
        status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Add timestamp for specific statuses
      if (status === "resolved") {
        updateData.resolvedAt = admin.firestore.FieldValue.serverTimestamp();
      } else if (status === "closed") {
        updateData.closedAt = admin.firestore.FieldValue.serverTimestamp();
      }

      await db.collection("customerTickets").doc(ticketId).update(updateData);

      res.json({
        success: true,
        message: "Status updated successfully",
      });
    } catch (error) {
      console.error("Update status error:", error);
      res.status(500).json({ error: "Failed to update status" });
    }
  },
);

// Update ticket priority (admin only)
app.patch(
  "/api/support/tickets/:ticketId/priority",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { ticketId } = req.params;
      const { priority } = req.body;

      const validPriorities = ["low", "medium", "high", "urgent"];

      if (!validPriorities.includes(priority)) {
        return res.status(400).json({
          error: "Bad Request",
          message: `Invalid priority. Must be one of: ${validPriorities.join(", ")}`,
        });
      }

      await db.collection("customerTickets").doc(ticketId).update({
        priority,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.json({
        success: true,
        message: "Priority updated successfully",
      });
    } catch (error) {
      console.error("Update priority error:", error);
      res.status(500).json({ error: "Failed to update priority" });
    }
  },
);

// Assign ticket to admin (admin only)
app.patch(
  "/api/support/tickets/:ticketId/assign",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { ticketId } = req.params;
      const { assignedTo, assignedToName } = req.body;

      await db
        .collection("customerTickets")
        .doc(ticketId)
        .update({
          assignedTo: assignedTo || null,
          assignedToName: assignedToName || null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      res.json({
        success: true,
        message: "Ticket assigned successfully",
      });
    } catch (error) {
      console.error("Assign ticket error:", error);
      res.status(500).json({ error: "Failed to assign ticket" });
    }
  },
);

// Add response to ticket
app.post(
  "/api/support/tickets/:ticketId/responses",
  verifyToken,
  async (req, res) => {
    try {
      const { ticketId } = req.params;
      const { message, attachments = [] } = req.body;

      if (!message || !message.trim()) {
        return res.status(400).json({
          error: "Bad Request",
          message: "Message is required",
        });
      }

      // Get ticket to verify access
      const ticketDoc = await db
        .collection("customerTickets")
        .doc(ticketId)
        .get();

      if (!ticketDoc.exists) {
        return res.status(404).json({ error: "Ticket not found" });
      }

      const ticket = ticketDoc.data();
      const isAdmin = req.user.admin === true;
      const isOwner = ticket.userId === req.user.uid;

      if (!isAdmin && !isOwner) {
        return res.status(403).json({ error: "Access denied" });
      }

      const response = {
        id: `response_${Date.now()}`,
        userId: req.user.uid,
        userName: req.user.displayName || req.user.email,
        isAdmin,
        message: message.trim(),
        attachments,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      await db
        .collection("customerTickets")
        .doc(ticketId)
        .update({
          responses: admin.firestore.FieldValue.arrayUnion(response),
          lastResponseBy: isAdmin ? "admin" : "user",
          lastResponseAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      res.status(201).json({
        success: true,
        data: response,
      });
    } catch (error) {
      console.error("Add response error:", error);
      res.status(500).json({ error: "Failed to add response" });
    }
  },
);

// Update ticket (admin only - for notes/resolution)
app.patch(
  "/api/support/tickets/:ticketId",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { ticketId } = req.params;
      const { internalNotes, resolution } = req.body;

      const updateData = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (internalNotes !== undefined) {
        updateData.internalNotes = internalNotes;
      }

      if (resolution !== undefined) {
        updateData.resolution = resolution;
      }

      await db.collection("customerTickets").doc(ticketId).update(updateData);

      res.json({
        success: true,
        message: "Ticket updated successfully",
      });
    } catch (error) {
      console.error("Update ticket error:", error);
      res.status(500).json({ error: "Failed to update ticket" });
    }
  },
);

// Delete ticket (admin only)
app.delete(
  "/api/support/tickets/:ticketId",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { ticketId } = req.params;
      await db.collection("customerTickets").doc(ticketId).delete();

      res.json({
        success: true,
        message: "Ticket deleted successfully",
      });
    } catch (error) {
      console.error("Delete ticket error:", error);
      res.status(500).json({ error: "Failed to delete ticket" });
    }
  },
);

// Get ticket statistics (admin only)
app.get("/api/support/stats", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection("customerTickets").get();

    const stats = {
      total: snapshot.size,
      byStatus: {
        open: 0,
        "in-progress": 0,
        "waiting-customer": 0,
        resolved: 0,
        closed: 0,
      },
      byCategory: {},
      byPriority: {
        low: 0,
        medium: 0,
        high: 0,
        urgent: 0,
      },
    };

    snapshot.forEach((doc) => {
      const data = doc.data();

      if (data.status) {
        stats.byStatus[data.status] = (stats.byStatus[data.status] || 0) + 1;
      }

      if (data.category) {
        stats.byCategory[data.category] =
          (stats.byCategory[data.category] || 0) + 1;
      }

      if (data.priority) {
        stats.byPriority[data.priority] =
          (stats.byPriority[data.priority] || 0) + 1;
      }
    });

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error("Get stats error:", error);
    res.status(500).json({ error: "Failed to fetch statistics" });
  }
});

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "mobros-backend",
  });
});

// Test Firestore connection
app.get("/api/test-firestore", async (req, res) => {
  try {
    console.log("Attempting to READ from Firestore...");
    console.log("Project ID:", admin.instanceId().app.options.projectId);

    // Try to read the existing buylist collection
    const snapshot = await db.collection("buylist").limit(1).get();

    console.log("Read successful! Found", snapshot.size, "documents");

    if (snapshot.empty) {
      return res.json({
        success: true,
        message: "Firestore connected! Collection is empty",
        canRead: true,
        canWrite: false,
      });
    }

    const doc = snapshot.docs[0];

    res.json({
      success: true,
      message: "Firestore READ is working!",
      canRead: true,
      data: {
        id: doc.id,
        ...doc.data(),
      },
    });
  } catch (error) {
    console.error("Read error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      code: error.code,
    });
  }
});

// 404 handler (MUST BE LAST)
app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    message: `Route ${req.method} ${req.path} not found`,
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: "Internal Server Error",
    message:
      process.env.NODE_ENV === "development"
        ? err.message
        : "An error occurred",
  });
});

// Start server
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

module.exports = app;
module.exports.verifyToken = verifyToken;
module.exports.verifyAdmin = verifyAdmin;
module.exports.initBroadcast = initBroadcast;
