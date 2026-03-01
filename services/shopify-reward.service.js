const admin = require("firebase-admin");
const shopifyAuthService = require("./shopify-auth.service");

// ============================================================================
// REWARDS CONFIG
// ============================================================================

const REWARDS_CONFIG = {
  POINTS_PER_DOLLAR: 1,
  SIGNUP_BONUS: 100,
  REDEMPTION_TIERS: [
    { points: 250, credit: 5.0 },
    { points: 500, credit: 10.0 },
    { points: 750, credit: 25.0 },
    { points: 1000, credit: 35.0 },
  ],
};

// ============================================================================
// HELPERS
// ============================================================================

async function syncPointsMetafield(shopifyCustomerId, points) {
  try {
    const mutation = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
            value
          }
          userErrors {
            field
            message
            code
          }
        }
      }
    `;

    const data = await shopifyAuthService.adminGraphQLRequest(mutation, {
      metafields: [
        {
          ownerId: shopifyCustomerId,
          namespace: "rewards",
          key: "points",
          value: String(Math.floor(points)), // Shopify integer metafields require string input
          type: "integer",
        },
      ],
    });

    const errors = data?.metafieldsSet?.userErrors ?? [];

    if (errors.length > 0) {
      console.warn(
        `[rewards:metafield] Sync warning for ${shopifyCustomerId}:`,
        errors[0].message,
      );
    } else {
      console.log(
        `[rewards:metafield] Synced ${points} pts → Shopify metafield for ${shopifyCustomerId}`,
      );
    }
  } catch (error) {
    // Non-fatal — log and continue
    console.warn(
      `[rewards:metafield] Sync failed for ${shopifyCustomerId} (non-fatal):`,
      error.message,
    );
  }
}

/**
 * Find Firebase user by email
 * Returns { uid } or null
 */
async function findUserByEmail(email) {
  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    return userRecord;
  } catch (error) {
    if (error.code === "auth/user-not-found") {
      return null;
    }
    throw error;
  }
}

/**
 * Get the customer's Shopify store credit account GID.
 * The storeCreditAccount API requires the customer GID.
 * Returns the storeCreditAccount id (gid://shopify/StoreCreditAccount/...)
 */
async function getStoreCreditAccountId(shopifyCustomerId) {
  const query = `
    query getStoreCreditAccount($customerId: ID!) {
      customer(id: $customerId) {
        storeCreditAccounts(first: 1) {
          edges {
            node {
              id
              balance {
                amount
                currencyCode
              }
            }
          }
        }
      }
    }
  `;

  const data = await shopifyAuthService.adminGraphQLRequest(query, {
    customerId: shopifyCustomerId,
  });

  const edges = data?.customer?.storeCreditAccounts?.edges ?? [];

  if (edges.length > 0) {
    return edges[0].node.id;
  }

  return null;
}

/**
 * Issue store credit to a Shopify customer via Admin GraphQL.
 * Shopify creates the storeCreditAccount automatically on first credit.
 */
async function issueShopifyStoreCredit(shopifyCustomerId, creditAmount) {
  const mutation = `
    mutation storeCreditAccountCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
      storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
        storeCreditAccountTransaction {
          id
          amount {
            amount
            currencyCode
          }
          account {
            id
            balance {
              amount
              currencyCode
            }
          }
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  // We need the storeCreditAccount GID first
  let storeCreditAccountId = await getStoreCreditAccountId(shopifyCustomerId);

  // If no store credit account exists, we need to create an initial credit
  // which Shopify does automatically — but the mutation needs the account id.
  // For first-time credit we use the storeCreditAccountCredit mutation with
  // the customer GID directly (Shopify 2024-01+).
  if (!storeCreditAccountId) {
    // Use a different mutation path: issue credit directly against the customer
    const createMutation = `
      mutation issueStoreCredit($customerId: ID!, $creditInput: StoreCreditAccountCreditInput!) {
        storeCreditAccountCredit(id: $customerId, creditInput: $creditInput) {
          storeCreditAccountTransaction {
            id
            amount {
              amount
              currencyCode
            }
            account {
              id
              balance {
                amount
                currencyCode
              }
            }
          }
          userErrors {
            field
            message
            code
          }
        }
      }
    `;

    const data = await shopifyAuthService.adminGraphQLRequest(createMutation, {
      customerId: shopifyCustomerId,
      creditInput: {
        amount: {
          amount: creditAmount.toFixed(2),
          currencyCode: "USD",
        },
        expiresOn: null,
      },
    });

    const result = data?.storeCreditAccountCredit;

    if (result?.userErrors?.length > 0) {
      throw new Error(
        `Shopify store credit error: ${result.userErrors[0].message}`,
      );
    }

    return result?.storeCreditAccountTransaction;
  }

  // Account exists — credit against the account GID
  const data = await shopifyAuthService.adminGraphQLRequest(mutation, {
    id: storeCreditAccountId,
    creditInput: {
      amount: {
        amount: creditAmount.toFixed(2),
        currencyCode: "USD",
      },
      expiresOn: null,
    },
  });

  const result = data?.storeCreditAccountCredit;

  if (result?.userErrors?.length > 0) {
    throw new Error(
      `Shopify store credit error: ${result.userErrors[0].message}`,
    );
  }

  return result?.storeCreditAccountTransaction;
}

// ============================================================================
// REWARDS SERVICE
// ============================================================================

class RewardsService {
  constructor() {
    this.db = null;
  }

  _getDb() {
    if (!this.db) {
      this.db = admin.firestore();
    }
    return this.db;
  }

  /**
   * Get current rewards config (tiers, earning rates).
   * Can be overridden by a Firestore document for dynamic admin control.
   */
  async getConfig() {
    try {
      const db = this._getDb();
      const doc = await db.collection("settings").doc("rewards").get();

      if (doc.exists) {
        // Merge Firestore overrides with defaults (Firestore wins)
        return { ...REWARDS_CONFIG, ...doc.data() };
      }

      return REWARDS_CONFIG;
    } catch (error) {
      console.error("getConfig error, returning defaults:", error.message);
      return REWARDS_CONFIG;
    }
  }

  /**
   * Award points from a completed Shopify order.
   * Idempotent — same orderId will never award twice.
   *
   * @param {string} email - Customer email from Shopify
   * @param {number} orderTotal - Order total in dollars
   * @param {string} orderId - Shopify order GID (used for dedup)
   * @param {string} orderName - Human-readable order name e.g. "#1234"
   * @returns {{ awarded: boolean, points: number, reason?: string }}
   */
  async awardOrderPoints(email, orderTotal, orderId, orderName) {
    const db = this._getDb();

    // 1. Find Firebase user by email
    const userRecord = await findUserByEmail(email);

    if (!userRecord) {
      console.log(`[rewards] No Firebase user found for email: ${email}`);
      return { awarded: false, reason: "no_firebase_user" };
    }

    const uid = userRecord.uid;
    const userRef = db.collection("users").doc(uid);
    const ledgerRef = userRef.collection("pointsLedger");

    // 2. Dedup check — has this order already been awarded?
    const existing = await ledgerRef
      .where("orderId", "==", orderId)
      .limit(1)
      .get();

    if (!existing.empty) {
      console.log(
        `[rewards] Order ${orderName} already awarded to ${email}. Skipping.`,
      );
      return { awarded: false, reason: "already_awarded" };
    }

    // 3. Calculate points
    const config = await this.getConfig();
    const pointsEarned = Math.floor(
      parseFloat(orderTotal) * config.POINTS_PER_DOLLAR,
    );

    if (pointsEarned <= 0) {
      return { awarded: false, reason: "zero_points" };
    }

    // 4. Fetch current balance for ledger snapshot
    const userSnap = await userRef.get();
    const currentPoints = userSnap.exists
      ? (userSnap.data()?.rewards?.points ?? 0)
      : 0;
    const currentLifetime = userSnap.exists
      ? (userSnap.data()?.rewards?.lifetimePoints ?? 0)
      : 0;

    const newBalance = currentPoints + pointsEarned;
    const newLifetime = currentLifetime + pointsEarned;

    // 5. Atomic batch write
    const batch = db.batch();

    // Update user rewards fields (dot notation — never clobbers storeCredit, etc.)
    batch.set(
      userRef,
      {
        "rewards.points": newBalance,
        "rewards.lifetimePoints": newLifetime,
        "rewards.lastEarnedAt": admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // Ledger entry
    const ledgerEntry = {
      type: "earn",
      source: "order",
      points: pointsEarned,
      balanceAfter: newBalance,
      orderId,
      orderName,
      orderTotal: parseFloat(orderTotal),
      description: `Earned ${pointsEarned} points from order ${orderName}`,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    batch.set(ledgerRef.doc(), ledgerEntry);

    await batch.commit();

    console.log(
      `[rewards] Awarded ${pointsEarned} points to ${email} for order ${orderName}`,
    );

    return { awarded: true, points: pointsEarned, newBalance };
  }

  /**
   * Award bonus points (signup, birthday, promo, manual, etc.)
   *
   * @param {string} userId - Firebase UID
   * @param {number} points - Number of points to award (must be positive)
   * @param {string} source - "signup" | "birthday" | "manual" | "promo" | "migration"
   * @param {string} description - Human-readable description
   */
  async awardBonusPoints(userId, points, source, description) {
    const db = this._getDb();

    if (!points || points <= 0) {
      throw new Error("Points must be a positive number");
    }

    const userRef = db.collection("users").doc(userId);
    const ledgerRef = userRef.collection("pointsLedger");

    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      throw new Error(`User ${userId} not found in Firestore`);
    }

    const currentPoints = userSnap.data()?.rewards?.points ?? 0;
    const currentLifetime = userSnap.data()?.rewards?.lifetimePoints ?? 0;

    const newBalance = currentPoints + points;
    const newLifetime = currentLifetime + points;

    const batch = db.batch();

    batch.set(
      userRef,
      {
        "rewards.points": newBalance,
        "rewards.lifetimePoints": newLifetime,
        "rewards.lastEarnedAt": admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    batch.set(ledgerRef.doc(), {
      type: "earn",
      source,
      points,
      balanceAfter: newBalance,
      description: description || `Awarded ${points} bonus points (${source})`,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    console.log(
      `[rewards] Awarded ${points} bonus points (${source}) to user ${userId}`,
    );

    return { awarded: true, points, newBalance };
  }

  /**
   * Redeem points for store credit.
   * Deducts points from Firestore and issues real store credit in Shopify.
   *
   * @param {string} userId - Firebase UID
   * @param {number} tierIndex - 0-3, index into REDEMPTION_TIERS
   */
  async redeemPoints(userId, tierIndex) {
    const db = this._getDb();
    const config = await this.getConfig();

    const tier = config.REDEMPTION_TIERS[tierIndex];

    if (!tier) {
      throw new Error(
        `Invalid tier index: ${tierIndex}. Must be 0-${config.REDEMPTION_TIERS.length - 1}`,
      );
    }

    const userRef = db.collection("users").doc(userId);
    const ledgerRef = userRef.collection("pointsLedger");

    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      throw new Error(`User ${userId} not found`);
    }

    const userData = userSnap.data();
    const currentPoints = userData?.rewards?.points ?? 0;
    const currentRedeemed = userData?.rewards?.totalRedeemed ?? 0;

    if (currentPoints < tier.points) {
      throw new Error(
        `Insufficient points. Need ${tier.points}, have ${currentPoints}`,
      );
    }

    // Require Shopify customer ID to issue store credit
    const shopifyCustomerId = userData?.shopifyCustomerId;

    if (!shopifyCustomerId) {
      throw new Error(
        "No Shopify customer account linked. Please sync your account first.",
      );
    }

    // Issue store credit in Shopify FIRST (fail fast before deducting points)
    const creditTransaction = await issueShopifyStoreCredit(
      shopifyCustomerId,
      tier.credit,
    );

    // Shopify credit issued — now deduct points from Firestore
    const newBalance = currentPoints - tier.points;
    const newTotalRedeemed = currentRedeemed + tier.points;

    const batch = db.batch();

    batch.set(
      userRef,
      {
        "rewards.points": newBalance,
        "rewards.totalRedeemed": newTotalRedeemed,
        "rewards.lastRedeemedAt": admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    batch.set(ledgerRef.doc(), {
      type: "redeem",
      source: "store_credit",
      points: -tier.points, // negative for redemption
      balanceAfter: newBalance,
      creditAmount: tier.credit,
      description: `Redeemed ${tier.points} points for $${tier.credit.toFixed(2)} store credit`,
      shopifyTransactionId: creditTransaction?.id ?? null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    console.log(
      `[rewards] User ${userId} redeemed ${tier.points} points for $${tier.credit.toFixed(2)} store credit`,
    );

    return {
      success: true,
      pointsDeducted: tier.points,
      creditIssued: tier.credit,
      newBalance,
      shopifyTransaction: creditTransaction,
    };
  }

  /**
   * Admin: manually adjust points (positive = award, negative = deduct)
   *
   * @param {string} userId - Firebase UID
   * @param {number} points - Points delta (can be negative)
   * @param {string} reason - Admin note
   * @param {string} adminId - Admin's Firebase UID (for audit trail)
   */
  async adminAdjustPoints(userId, points, reason, adminId) {
    const db = this._getDb();

    if (!points || points === 0) {
      throw new Error("Points adjustment cannot be zero");
    }

    const userRef = db.collection("users").doc(userId);
    const ledgerRef = userRef.collection("pointsLedger");

    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      throw new Error(`User ${userId} not found in Firestore`);
    }

    const currentPoints = userSnap.data()?.rewards?.points ?? 0;
    const currentLifetime = userSnap.data()?.rewards?.lifetimePoints ?? 0;

    const newBalance = Math.max(0, currentPoints + points); // Floor at 0
    const lifetimeDelta = points > 0 ? points : 0;
    const newLifetime = currentLifetime + lifetimeDelta;

    const batch = db.batch();

    const rewardsUpdate = {
      "rewards.points": newBalance,
      "rewards.lifetimePoints": newLifetime,
    };

    if (points > 0) {
      rewardsUpdate["rewards.lastEarnedAt"] =
        admin.firestore.FieldValue.serverTimestamp();
    }

    batch.set(userRef, rewardsUpdate, { merge: true });

    batch.set(ledgerRef.doc(), {
      type: "adjust",
      source: "manual",
      points,
      balanceAfter: newBalance,
      description:
        reason || `Manual adjustment: ${points > 0 ? "+" : ""}${points} points`,
      adjustedBy: adminId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    console.log(
      `[rewards] Admin ${adminId} adjusted ${points > 0 ? "+" : ""}${points} points for user ${userId}`,
    );

    return { adjusted: true, points, newBalance };
  }

  /**
   * Get a user's points ledger (paginated)
   *
   * @param {string} userId - Firebase UID
   * @param {number} limit - Max entries to return
   */
  async getPointsHistory(userId, limit = 20) {
    const db = this._getDb();

    const snapshot = await db
      .collection("users")
      .doc(userId)
      .collection("pointsLedger")
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
      // Serialize Timestamps for JSON transport
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString() ?? null,
    }));
  }

  /**
   * Get a user's current rewards balance summary
   *
   * @param {string} userId - Firebase UID
   */
  async getBalance(userId) {
    const db = this._getDb();

    const userSnap = await db.collection("users").doc(userId).get();

    if (!userSnap.exists) {
      throw new Error(`User ${userId} not found`);
    }

    const data = userSnap.data();
    const rewards = data?.rewards ?? {};

    return {
      points: rewards.points ?? 0,
      lifetimePoints: rewards.lifetimePoints ?? 0,
      totalRedeemed: rewards.totalRedeemed ?? 0,
      storeCredit: rewards.storeCredit ?? 0,
      numberOfOrders: rewards.numberOfOrders ?? 0,
      amountSpent: rewards.amountSpent ?? 0,
      lastEarnedAt: rewards.lastEarnedAt?.toDate?.()?.toISOString() ?? null,
      lastRedeemedAt: rewards.lastRedeemedAt?.toDate?.()?.toISOString() ?? null,
      lastSyncedAt: rewards.lastSyncedAt?.toDate?.()?.toISOString() ?? null,
    };
  }
}

module.exports = new RewardsService();
module.exports.REWARDS_CONFIG = REWARDS_CONFIG;
