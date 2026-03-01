/**
 * migrate-froonze.js
 *
 * Migrates Froonze loyalty CSV into Firestore rewards fields.
 *
 * Strategy:
 *  - Read CSV, group by email
 *  - For each row, look up Firebase Auth user by email
 *  - If found → merge rewards.* fields into users/{uid} doc
 *  - Write one "migration" ledger entry to users/{uid}/pointsLedger
 *  - If NOT found → write to pendingPointsQueue/{email} for future signup
 *  - Batched writes (max 500 ops/batch) to minimize Firestore costs
 *
 * Firestore write cost estimate:
 *  - 7,404 users with points × 2 writes = ~14,808 writes
 *  - 5,261 zero-point users skipped entirely
 *  - Total: ~14,808 writes ≈ $0.03 at paid tier
 *
 * Usage:
 *   node migrate-froonze.js --csv ./mobrostc--2026-02-15-1771175589.csv [--dry-run] [--skip-zero]
 *
 * Flags:
 *   --dry-run     Print what would be written, no Firestore writes
 *   --skip-zero   Skip customers with 0 points (recommended — saves writes)
 *   --batch-size  Firestore ops per batch commit (default: 400, max: 500)
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const csv = require("csv-parse/sync");
const admin = require("firebase-admin");

// ─── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const csvFlag = args.indexOf("--csv");
const CSV_PATH =
  csvFlag >= 0 ? args[csvFlag + 1] : "./mobrostc--2026-02-15-1771175589.csv";
const DRY_RUN = args.includes("--dry-run");
const SKIP_ZERO = args.includes("--skip-zero");
const batchFlag = args.indexOf("--batch-size");
const BATCH_SIZE = batchFlag >= 0 ? parseInt(args[batchFlag + 1]) : 400;

// ─── Init Firebase ────────────────────────────────────────────────────────────
const serviceAccount = require("./serviceAccountKey.js");
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Sleep to avoid hammering Firebase Auth rate limits */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lookup Firebase Auth user by email — returns uid or null */
async function getUidByEmail(email) {
  try {
    const user = await admin.auth().getUserByEmail(email);
    return user.uid;
  } catch (err) {
    if (err.code === "auth/user-not-found") return null;
    throw err;
  }
}

/** Parse VIP tier name from Froonze to our tier key */
function parseTier(tierName) {
  if (!tierName) return "rare";
  const t = tierName.toLowerCase().replace(/\s/g, "");
  if (t === "godmode") return "godmode";
  if (t === "mythic") return "mythic";
  if (t === "legendary") return "legendary";
  if (t === "epic") return "epic";
  return "rare";
}

/** Format large numbers for log output */
const fmt = (n) => n.toLocaleString();

// ─── Main ─────────────────────────────────────────────────────────────────────
async function migrate() {
  console.log("═══════════════════════════════════════════════");
  console.log("  MoBros Froonze → Firestore Migration");
  console.log("═══════════════════════════════════════════════");
  console.log(`  CSV:        ${CSV_PATH}`);
  console.log(`  Dry run:    ${DRY_RUN}`);
  console.log(`  Skip zero:  ${SKIP_ZERO}`);
  console.log(`  Batch size: ${BATCH_SIZE}`);
  console.log("═══════════════════════════════════════════════\n");

  // 1. Read CSV
  const raw = fs.readFileSync(path.resolve(CSV_PATH), "utf8");
  const rows = csv.parse(raw, { columns: true, skip_empty_lines: true });
  console.log(`✓ Loaded ${fmt(rows.length)} rows from CSV\n`);

  // 2. Stats trackers
  const stats = {
    total: rows.length,
    skippedZero: 0,
    noFirebaseUser: 0,
    pendingQueued: 0,
    matched: 0,
    errors: 0,
  };

  // 3. Separate into matched (have Firebase uid) vs pending (no account yet)
  //    We do Auth lookups in controlled batches to avoid rate limits.
  const matched = []; // { uid, row }
  const pending = []; // { row } — will go to pendingPointsQueue
  const errorLog = [];

  console.log("── Phase 1: Matching emails to Firebase Auth ──");
  const AUTH_CHUNK = 10; // lookups per chunk
  const AUTH_DELAY = 200; // ms between chunks

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const points = Math.floor(parseFloat(row["Loyalty points"] || "0"));
    const email = (row["Email"] || "").trim().toLowerCase();

    // Skip zero-point customers if flag set
    if (SKIP_ZERO && points === 0) {
      stats.skippedZero++;
      continue;
    }

    // Rate-limit Auth lookups
    if (i > 0 && i % AUTH_CHUNK === 0) {
      await sleep(AUTH_DELAY);
      if (i % 500 === 0) {
        process.stdout.write(`  ${fmt(i)}/${fmt(rows.length)} processed...\r`);
      }
    }

    try {
      const uid = await getUidByEmail(email);

      if (uid) {
        matched.push({ uid, row, points });
        stats.matched++;
      } else {
        pending.push({ row, points });
        stats.noFirebaseUser++;
        if (points > 0) stats.pendingQueued++;
      }
    } catch (err) {
      errorLog.push({ email, error: err.message });
      stats.errors++;
    }
  }

  console.log(`\n✓ Phase 1 complete`);
  console.log(`  Matched to Firebase:  ${fmt(stats.matched)}`);
  console.log(
    `  No Firebase account:  ${fmt(stats.noFirebaseUser)} (${fmt(stats.pendingQueued)} with points → pending queue)`,
  );
  console.log(`  Skipped (0 pts):      ${fmt(stats.skippedZero)}`);
  console.log(`  Errors:               ${stats.errors}\n`);

  if (DRY_RUN) {
    console.log("── DRY RUN: showing first 10 matched writes ──");
    matched.slice(0, 10).forEach(({ uid, row, points }) => {
      console.log(`  [WRITE] users/${uid}`);
      console.log(`         rewards.points = ${points}`);
      console.log(`         rewards.lifetimePoints = ${points}`);
      console.log(`         source: ${row["Email"]}`);
    });
    console.log("\n── DRY RUN: showing first 5 pending queue writes ──");
    pending
      .filter((p) => p.points > 0)
      .slice(0, 5)
      .forEach(({ row, points }) => {
        console.log(`  [PENDING] pendingPointsQueue/${row["Email"]}`);
        console.log(`            points = ${points}`);
      });
    console.log("\n✓ Dry run complete — no writes made");
    process.exit(0);
  }

  // ─── Phase 2: Write matched users to Firestore in batches ─────────────────
  console.log("── Phase 2: Writing matched users to Firestore ──");

  const now = admin.firestore.FieldValue.serverTimestamp();
  let batchOps = 0;
  let batchCount = 0;
  let batch = db.batch();
  let totalWritten = 0;

  const flushBatch = async () => {
    if (batchOps === 0) return;
    await batch.commit();
    totalWritten += batchOps;
    batchCount++;
    console.log(
      `  Committed batch ${batchCount} (${fmt(batchOps)} ops, ${fmt(totalWritten)} total)`,
    );
    batch = db.batch();
    batchOps = 0;
    await sleep(100); // brief pause between commits
  };

  for (const { uid, row, points } of matched) {
    const userRef = db.collection("users").doc(uid);
    const ledgerRef = db
      .collection("users")
      .doc(uid)
      .collection("pointsLedger")
      .doc();
    const shopifyId = row["Customer ID"]
      ? `gid://shopify/Customer/${row["Customer ID"]}`
      : null;

    // Write 1: merge rewards fields onto user doc
    // Uses merge:true — never clobbers existing fields like storeCredit, numberOfOrders
    batch.set(
      userRef,
      {
        rewards: {
          points: points,
          lifetimePoints: points, // Froonze only exports current balance, treat as lifetime
          lastSyncedAt: now,
        },
        // Backfill shopifyCustomerId if not already set
        ...(shopifyId ? { shopifyCustomerId: shopifyId } : {}),
        updatedAt: now,
      },
      { merge: true },
    );
    batchOps++;

    // Write 2: migration ledger entry
    batch.set(ledgerRef, {
      type: "migration",
      source: "froonze_import",
      points: points,
      balanceAfter: points,
      description: `Migrated ${points} points from Froonze loyalty program`,
      migratedAt: now,
      createdAt: now,
    });
    batchOps++;

    // Flush when approaching batch limit
    if (batchOps >= BATCH_SIZE) {
      await flushBatch();
    }
  }

  // Flush remaining matched users
  await flushBatch();
  console.log(`✓ Phase 2 complete — ${fmt(stats.matched)} users written\n`);

  // ─── Phase 3: Write pending queue (non-Firebase users with points) ─────────
  const pendingWithPoints = pending.filter((p) => p.points > 0);

  if (pendingWithPoints.length > 0) {
    console.log(
      `── Phase 3: Writing ${fmt(pendingWithPoints.length)} pending entries ──`,
    );

    batch = db.batch();
    batchOps = 0;

    for (const { row, points } of pendingWithPoints) {
      const email = (row["Email"] || "").trim().toLowerCase();
      const safeKey = email.replace(/[.#$[\]\/]/g, "_"); // Firestore key-safe
      const queueRef = db.collection("pendingPointsQueue").doc(safeKey);
      const shopifyId = row["Customer ID"]
        ? `gid://shopify/Customer/${row["Customer ID"]}`
        : null;

      batch.set(
        queueRef,
        {
          email,
          firstName: row["First name"] || "",
          lastName: row["Last name"] || "",
          shopifyCustomerId: shopifyId,
          points,
          tier: parseTier(row["VIP tier name"]),
          source: "froonze_import",
          status: "pending",
          createdAt: now,
        },
        { merge: true },
      );
      batchOps++;

      if (batchOps >= BATCH_SIZE) {
        await flushBatch();
      }
    }

    await flushBatch();
    console.log(
      `✓ Phase 3 complete — ${fmt(pendingWithPoints.length)} pending entries written\n`,
    );
  } else {
    console.log("── Phase 3: No pending entries to write ──\n");
  }

  // ─── Final report ──────────────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════");
  console.log("  Migration Complete");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Total CSV rows:        ${fmt(stats.total)}`);
  console.log(`  Skipped (0 pts):       ${fmt(stats.skippedZero)}`);
  console.log(`  Written to users/:     ${fmt(stats.matched)}`);
  console.log(`  Written to pending/:   ${fmt(pendingWithPoints.length)}`);
  console.log(
    `  No account + 0 pts:    ${fmt(stats.noFirebaseUser - stats.pendingQueued)}`,
  );
  console.log(`  Errors:                ${stats.errors}`);
  console.log(
    `  Total Firestore ops:   ${fmt(totalWritten + pendingWithPoints.length)}`,
  );
  console.log("═══════════════════════════════════════════════");

  if (errorLog.length > 0) {
    const errPath = "./migration-errors.json";
    fs.writeFileSync(errPath, JSON.stringify(errorLog, null, 2));
    console.log(`\n⚠ ${stats.errors} errors written to ${errPath}`);
  }

  process.exit(0);
}

migrate().catch((err) => {
  console.error("\n✗ Migration failed:", err);
  process.exit(1);
});
