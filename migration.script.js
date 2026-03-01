/**
 * Froonze → MoBros Rewards Migration Script
 *
 * Reads the Froonze CSV export and migrates points to Firestore for
 * any customer who has a matching Firebase Auth account.
 *
 * CSV format:
 *   First name, Last name, Email, Customer ID, Loyalty points, VIP tier name
 *
 * Usage:
 *   node migration.script.js --csv ./froonze_export.csv [--dry-run] [--batch-size 50]
 *
 * Options:
 *   --csv <path>        Path to the Froonze CSV export (required)
 *   --dry-run           Preview what would happen without writing to Firestore
 *   --batch-size <n>    Firestore batch size (default 50, max 500)
 *   --skip-zero         Skip customers with 0 points (default: true)
 *   --report <path>     Write a JSON migration report to this path
 */

require("dotenv").config();
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

// ============================================================================
// CONFIG
// ============================================================================

const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
};
const hasFlag = (flag) => args.includes(flag);

const CSV_PATH = getArg("--csv");
const DRY_RUN = hasFlag("--dry-run");
const BATCH_SIZE = Math.min(parseInt(getArg("--batch-size") || "50"), 500);
const SKIP_ZERO = !hasFlag("--include-zero"); // skip zero-point rows by default
const REPORT_PATH = getArg("--report");

if (!CSV_PATH) {
  console.error("❌ --csv <path> is required");
  console.error(
    "   Usage: node migration.script.js --csv ./froonze_export.csv [--dry-run]",
  );
  process.exit(1);
}

if (!fs.existsSync(CSV_PATH)) {
  console.error(`❌ CSV file not found: ${CSV_PATH}`);
  process.exit(1);
}

// ============================================================================
// FIREBASE INIT
// ============================================================================

let serviceAccount;
try {
  serviceAccount = require("./serviceAccountKey.js");
} catch {
  try {
    serviceAccount = require("./serviceAccountKey.json");
  } catch {
    console.error(
      "❌ Could not load serviceAccountKey.js or serviceAccountKey.json",
    );
    process.exit(1);
  }
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

// ============================================================================
// CSV PARSER
// ============================================================================

/**
 * Parse a single CSV line respecting quoted fields.
 */
function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }

  fields.push(current.trim());
  return fields;
}

/**
 * Read and parse the Froonze CSV.
 * Returns an array of { firstName, lastName, email, shopifyCustomerId, points, tier }
 */
async function readCsv(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let isHeader = true;
    let headers = [];

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      if (!line.trim()) return;

      if (isHeader) {
        headers = parseCsvLine(line).map((h) =>
          h.toLowerCase().replace(/\s+/g, "_"),
        );
        isHeader = false;
        return;
      }

      const fields = parseCsvLine(line);
      const row = {};

      headers.forEach((header, idx) => {
        row[header] = fields[idx] ?? "";
      });

      // Normalize to expected shape regardless of CSV column ordering
      rows.push({
        firstName: row["first_name"] || row["firstname"] || "",
        lastName: row["last_name"] || row["lastname"] || "",
        email: (row["email"] || "").toLowerCase().trim(),
        shopifyCustomerId: row["customer_id"] || "",
        points: Math.floor(parseFloat(row["loyalty_points"] || "0")),
        tier: row["vip_tier_name"] || "",
      });
    });

    rl.on("close", () => resolve(rows));
    rl.on("error", reject);
  });
}

// ============================================================================
// LOOKUP HELPERS
// ============================================================================

/**
 * Find a Firebase UID by email via Firebase Auth.
 * Returns uid string or null.
 */
async function findUidByEmail(email) {
  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    return userRecord.uid;
  } catch (error) {
    if (error.code === "auth/user-not-found") {
      return null;
    }
    throw error;
  }
}

/**
 * Check if a user already has a migration ledger entry.
 * Prevents running the migration twice.
 */
async function alreadyMigrated(uid) {
  const snap = await db
    .collection("users")
    .doc(uid)
    .collection("pointsLedger")
    .where("source", "==", "migration")
    .limit(1)
    .get();

  return !snap.empty;
}

// ============================================================================
// MIGRATION STATS
// ============================================================================

const stats = {
  totalRows: 0,
  skippedZeroPoints: 0,
  skippedNoFirebaseAccount: 0,
  skippedAlreadyMigrated: 0,
  skippedErrors: 0,
  migrated: 0,
  totalPointsMigrated: 0,
  results: [], // detailed per-user results for the report
};

// ============================================================================
// CORE MIGRATION FUNCTION
// ============================================================================

/**
 * Migrate a single user's Froonze points to Firestore.
 * Uses dot-notation set with merge to avoid clobbering any existing data.
 */
async function migrateUser(uid, row) {
  const userRef = db.collection("users").doc(uid);
  const ledgerRef = userRef.collection("pointsLedger");

  // Read current balance so we can add on top (don't overwrite if partially migrated)
  const userSnap = await userRef.get();
  const currentPoints = userSnap.exists
    ? (userSnap.data()?.rewards?.points ?? 0)
    : 0;
  const currentLifetime = userSnap.exists
    ? (userSnap.data()?.rewards?.lifetimePoints ?? 0)
    : 0;

  const newBalance = currentPoints + row.points;
  const newLifetime = currentLifetime + row.points;

  const batch = db.batch();

  // Update rewards fields (dot notation to preserve storeCredit, etc.)
  batch.set(
    userRef,
    {
      "rewards.points": newBalance,
      "rewards.lifetimePoints": newLifetime,
      "rewards.lastEarnedAt": admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  // Ledger entry with source: "migration" for dedup and audit
  batch.set(ledgerRef.doc(), {
    type: "earn",
    source: "migration",
    points: row.points,
    balanceAfter: newBalance,
    froonzeTier: row.tier || null,
    froonzeShopifyCustomerId: row.shopifyCustomerId || null,
    description: `Migrated ${row.points} points from Froonze loyalty program`,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("\n🚀 MoBros Froonze → Rewards Migration");
  console.log("======================================");
  console.log(`📄 CSV:         ${path.resolve(CSV_PATH)}`);
  console.log(`🔢 Batch size:  ${BATCH_SIZE}`);
  console.log(`⏭  Skip zero:   ${SKIP_ZERO}`);
  console.log(
    `🌵 Dry run:     ${DRY_RUN ? "YES — no writes will occur" : "NO"}`,
  );
  console.log("");

  // 1. Parse CSV
  console.log("📖 Reading CSV...");
  const rows = await readCsv(CSV_PATH);
  stats.totalRows = rows.length;
  console.log(`   Found ${rows.length.toLocaleString()} rows\n`);

  // 2. Process in chunks to avoid Firebase rate limits
  let processed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    processed++;

    // Progress indicator every 100 rows
    if (processed % 100 === 0) {
      const pct = ((processed / rows.length) * 100).toFixed(1);
      process.stdout.write(
        `\r   Processing ${processed.toLocaleString()} / ${rows.length.toLocaleString()} (${pct}%)...`,
      );
    }

    // Skip rows with invalid email
    if (!row.email || !row.email.includes("@")) {
      stats.skippedErrors++;
      stats.results.push({
        email: row.email || "(empty)",
        status: "skipped_invalid_email",
      });
      continue;
    }

    // Skip zero-point rows (configurable)
    if (SKIP_ZERO && row.points <= 0) {
      stats.skippedZeroPoints++;
      continue;
    }

    try {
      // Find Firebase UID
      const uid = await findUidByEmail(row.email);

      if (!uid) {
        stats.skippedNoFirebaseAccount++;
        stats.results.push({
          email: row.email,
          status: "no_firebase_account",
          points: row.points,
          tier: row.tier,
        });
        continue;
      }

      // Check dedup
      const migrated = await alreadyMigrated(uid);

      if (migrated) {
        stats.skippedAlreadyMigrated++;
        stats.results.push({
          email: row.email,
          uid,
          status: "already_migrated",
          points: row.points,
        });
        continue;
      }

      // Execute migration
      if (!DRY_RUN) {
        await migrateUser(uid, row);
      }

      stats.migrated++;
      stats.totalPointsMigrated += row.points;

      stats.results.push({
        email: row.email,
        uid,
        status: DRY_RUN ? "would_migrate" : "migrated",
        points: row.points,
        tier: row.tier,
      });

      // Small delay every BATCH_SIZE records to avoid Firestore write rate limits
      if (stats.migrated % BATCH_SIZE === 0) {
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (error) {
      stats.skippedErrors++;
      stats.results.push({
        email: row.email,
        status: "error",
        error: error.message,
        points: row.points,
      });
      console.error(`\n   ❌ Error processing ${row.email}: ${error.message}`);
    }
  }

  // Clear progress line
  process.stdout.write("\r" + " ".repeat(80) + "\r");

  // ============================================================================
  // REPORT
  // ============================================================================

  console.log("\n✅ Migration Complete");
  console.log("====================");
  console.log(
    `Total CSV rows:             ${stats.totalRows.toLocaleString()}`,
  );
  console.log(
    `Migrated:                   ${stats.migrated.toLocaleString()}${DRY_RUN ? " (dry run — not written)" : ""}`,
  );
  console.log(
    `Total points migrated:      ${stats.totalPointsMigrated.toLocaleString()}`,
  );
  console.log(
    `Skipped — 0 points:         ${stats.skippedZeroPoints.toLocaleString()}`,
  );
  console.log(
    `Skipped — no Firebase acct: ${stats.skippedNoFirebaseAccount.toLocaleString()}`,
  );
  console.log(
    `Skipped — already migrated: ${stats.skippedAlreadyMigrated.toLocaleString()}`,
  );
  console.log(`Skipped — errors:           ${stats.skippedErrors}`);
  console.log("");

  // Breakdown of skipped (no Firebase) by tier — useful to see who's missing
  const noAccountByTier = {};
  stats.results
    .filter((r) => r.status === "no_firebase_account")
    .forEach((r) => {
      const tier = r.tier || "(no tier)";
      noAccountByTier[tier] = (noAccountByTier[tier] || 0) + 1;
    });

  if (Object.keys(noAccountByTier).length > 0) {
    console.log("No Firebase account — breakdown by tier:");
    Object.entries(noAccountByTier)
      .sort(([, a], [, b]) => b - a)
      .forEach(([tier, count]) => {
        console.log(`   ${tier.padEnd(15)} ${count.toLocaleString()}`);
      });
    console.log("");
  }

  // Write JSON report
  if (REPORT_PATH) {
    const report = {
      runAt: new Date().toISOString(),
      dryRun: DRY_RUN,
      csvPath: path.resolve(CSV_PATH),
      stats: {
        totalRows: stats.totalRows,
        migrated: stats.migrated,
        totalPointsMigrated: stats.totalPointsMigrated,
        skippedZeroPoints: stats.skippedZeroPoints,
        skippedNoFirebaseAccount: stats.skippedNoFirebaseAccount,
        skippedAlreadyMigrated: stats.skippedAlreadyMigrated,
        skippedErrors: stats.skippedErrors,
      },
      results: stats.results,
    };

    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf-8");
    console.log(`📄 Report written to: ${REPORT_PATH}`);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error("\n💥 Migration failed:", error);
  process.exit(1);
});
