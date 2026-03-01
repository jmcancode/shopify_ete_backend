/**
 * shopify-product-bulk.routes.js
 *
 * Admin endpoints for bulk product management.
 *
 * Mount in server.js / app.js:
 *   const bulkRoutes = require('./shopify-product-bulk.routes');
 *   app.use('/api/shopify/bulk', verifyToken, verifyAdmin, bulkRoutes);
 *
 * Endpoints:
 *   POST /api/shopify/bulk/preview         — validate + preview changes, no writes
 *   POST /api/shopify/bulk/update          — write to Shopify, returns jobId for SSE
 *   GET  /api/shopify/bulk/progress/:jobId — SSE stream for live job progress
 *   GET  /api/shopify/bulk/catalog         — full catalog with issue detection
 *   GET  /api/shopify/bulk/schema          — valid field values for front-end dropdowns
 *   POST /api/shopify/bulk/validate        — fast client-side validation (no Shopify calls)
 */

"use strict";

const express = require("express");
const router = express.Router();
const bulkService = require("../services/Shopifyproductbulk.service");

// In-memory job store for SSE progress tracking.
// Works fine for single-dyno Heroku. Swap for Redis if you scale multi-dyno.
const jobs = new Map(); // jobId → { status, done, total, failed, events[], listeners Set }

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shopify/bulk/preview
//
// Validates the product array and builds the Shopify payloads without writing.
// Returns a diff the admin can review before confirming.
//
// Body: { products: [{ handle, title, vendor, appCategoryTag, variantType,
//                      sealedPrice, livePrice, extraTags, status, ... }] }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/preview", async (req, res) => {
  try {
    const { products } = req.body;

    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({
        error: "products array is required and must not be empty",
        example: {
          products: [
            {
              handle: "pokemon-surging-sparks-booster-box",
              title: "Pokémon Surging Sparks Booster Box",
              vendor: "Pokemon",
              appCategoryTag: "sealed pokemon",
              variantType: "live+sealed",
              sealedPrice: 149.99,
              livePrice: 129.99,
            },
          ],
        },
      });
    }

    // Fast validation first — no Shopify calls
    const validation = bulkService.validateAll(products);
    if (!validation.valid) {
      return res.status(422).json({
        success: false,
        message: `${validation.failCount} product(s) failed validation — fix errors before previewing`,
        validation,
      });
    }

    // Dry run — fetches current Shopify state and builds payloads, does NOT write
    const preview = await bulkService.bulkUpdateProducts(products, {
      dryRun: true,
    });

    res.json({
      success: true,
      message: `Preview ready — ${products.length} product(s) queued for update`,
      validation,
      preview: {
        total: preview.total,
        results: preview.results, // each has: handle, payload (what would be sent)
      },
    });
  } catch (err) {
    console.error("[BulkRoutes] /preview error:", err.message);
    res.status(500).json({ error: "Preview failed", message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shopify/bulk/update
//
// Validates, then kicks off a background job to write to Shopify.
// Returns a jobId immediately — client connects to /progress/:jobId for updates.
//
// Body: same shape as /preview
// ─────────────────────────────────────────────────────────────────────────────
router.post("/update", async (req, res) => {
  try {
    const { products } = req.body;

    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: "products array is required" });
    }

    // Validate before starting — abort if anything fails
    const validation = bulkService.validateAll(products);
    if (!validation.valid) {
      return res.status(422).json({
        success: false,
        message: `${validation.failCount} product(s) failed validation — no writes performed`,
        validation,
      });
    }

    // Create job and return immediately
    const jobId = `bulk_${Date.now()}`;
    jobs.set(jobId, {
      status: "running",
      total: products.length,
      done: 0,
      failed: 0,
      events: [], // buffered so late SSE connections get full history
      listeners: new Set(),
    });

    res.json({
      success: true,
      jobId,
      total: products.length,
      message: `Job started — connect to /api/shopify/bulk/progress/${jobId} for live updates`,
    });

    // ── Background: run the actual writes ────────────────────────────────────
    const broadcast = (jobId, event) => {
      const job = jobs.get(jobId);
      if (!job) return;
      job.events.push(event);
      job.listeners.forEach((send) => send(event));
    };

    bulkService
      .bulkUpdateProducts(products, {
        onProgress: ({ done, total, handle, success, pct }) => {
          const job = jobs.get(jobId);
          if (job) {
            job.done = done;
          }
          broadcast(jobId, {
            type: "progress",
            done,
            total,
            handle,
            success,
            pct,
          });
        },
        onError: ({ handle, error }) => {
          const job = jobs.get(jobId);
          if (job) job.failed++;
          broadcast(jobId, { type: "error_item", handle, error });
        },
      })
      .then((result) => {
        const job = jobs.get(jobId);
        if (job) job.status = result.success ? "done" : "done_with_errors";

        broadcast(jobId, {
          type: "done",
          success: result.success,
          total: result.total,
          processed: result.processed,
          failed: result.failed,
          results: result.results,
        });

        // Auto-clean job after 5 minutes
        setTimeout(() => jobs.delete(jobId), 5 * 60 * 1000);
      })
      .catch((err) => {
        const job = jobs.get(jobId);
        if (job) job.status = "error";
        broadcast(jobId, { type: "error", message: err.message });
      });
  } catch (err) {
    console.error("[BulkRoutes] /update error:", err.message);
    res.status(500).json({ error: "Update failed", message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shopify/bulk/progress/:jobId
//
// Server-Sent Events — client subscribes here for live progress.
// Replays buffered events if the client connects after the job started.
//
// Event types:
//   { type: 'progress',   done, total, handle, success, pct }
//   { type: 'error_item', handle, error }
//   { type: 'done',       success, total, processed, failed, results }
//   { type: 'error',      message }
// ─────────────────────────────────────────────────────────────────────────────
router.get("/progress/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job)
    return res.status(404).json({ error: `Job ${req.params.jobId} not found` });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Heroku / Nginx buffering fix
  res.flushHeaders();

  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  // Replay all buffered events (handles late connections)
  job.events.forEach(send);

  // If already finished, close the connection immediately
  if (["done", "done_with_errors", "error"].includes(job.status)) {
    res.end();
    return;
  }

  // Register as live listener
  job.listeners.add(send);
  req.on("close", () => job.listeners.delete(send));
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shopify/bulk/catalog
//
// Fetch the full product catalog from Shopify and enrich each product with:
//  - Auto-derived app category (what the app currently does with it)
//  - Issues list (what needs fixing)
//  - Current variant structure
//
// Query params: ?page=1&limit=50&filter=needs_work
// ─────────────────────────────────────────────────────────────────────────────
router.get("/catalog", async (req, res) => {
  try {
    const page = parseInt(req.query.page || "1");
    const limit = parseInt(req.query.limit || "50");
    const filter = req.query.filter || "all"; // 'all' | 'needs_work' | 'no_category' | 'default_variant'

    const allProducts = await bulkService.fetchAllProducts();

    // Enrich each product
    const enriched = allProducts.map((p) => {
      const currentCategory = bulkService.deriveAppCategory(
        p.product_type,
        p.tags,
      );
      const tagsLower = (p.tags || "").toLowerCase();
      const variantNames = (p.variants || []).map(
        (v) => v.option1 || v.title || "",
      );
      const isDefaultVariant = variantNames.every(
        (n) => !n || n === "Default Title",
      );

      const issues = [];
      if (!currentCategory) issues.push("no_app_category");
      if (isDefaultVariant) issues.push("default_title_variant");
      if (
        p.vendor === "MoBrosTC" &&
        (tagsLower.includes("pokemon") ||
          tagsLower.includes("one piece") ||
          tagsLower.includes("lorcana"))
      ) {
        issues.push("vendor_should_be_game_brand");
      }
      if ((p.title || "").startsWith("(SEALED)"))
        issues.push("sealed_prefix_in_title");

      return {
        id: p.id,
        handle: p.handle,
        title: p.title,
        vendor: p.vendor,
        productType: p.product_type,
        tags: p.tags,
        status: p.status,
        currentCategory, // what the app resolves this to right now
        variantSummary: variantNames.filter(Boolean),
        isDefaultVariant,
        issues,
        needsWork: issues.length > 0,
      };
    });

    // Apply filter
    const filtered =
      filter === "all"
        ? enriched
        : enriched.filter((p) => {
            if (filter === "needs_work") return p.needsWork;
            if (filter === "no_category")
              return p.issues.includes("no_app_category");
            if (filter === "default_variant")
              return p.issues.includes("default_title_variant");
            return true;
          });

    // Paginate
    const start = (page - 1) * limit;
    const paginated = filtered.slice(start, start + limit);

    // Summary
    const summary = {
      total: enriched.length,
      needsWork: enriched.filter((p) => p.needsWork).length,
      noAppCategory: enriched.filter((p) =>
        p.issues.includes("no_app_category"),
      ).length,
      defaultVariant: enriched.filter((p) =>
        p.issues.includes("default_title_variant"),
      ).length,
      vendorFix: enriched.filter((p) =>
        p.issues.includes("vendor_should_be_game_brand"),
      ).length,
      sealedPrefixTitle: enriched.filter((p) =>
        p.issues.includes("sealed_prefix_in_title"),
      ).length,
    };

    res.json({
      success: true,
      summary,
      pagination: {
        page,
        limit,
        total: filtered.length,
        totalPages: Math.ceil(filtered.length / limit),
        hasMore: start + limit < filtered.length,
      },
      products: paginated,
    });
  } catch (err) {
    console.error("[BulkRoutes] /catalog error:", err.message);
    res
      .status(500)
      .json({ error: "Failed to fetch catalog", message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/shopify/bulk/schema
//
// Returns all valid field values for the front-end to build dropdowns.
// No Shopify calls — static data based on app constants.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/schema", (req, res) => {
  res.json({
    success: true,
    appCategoryTags: bulkService.APP_CATEGORY_TAGS,
    vendors: bulkService.VALID_VENDORS,
    variantTypes: bulkService.VALID_VARIANT_TYPES,
    statuses: bulkService.VALID_STATUSES,
    variantTypeDescriptions: {
      "sealed-only":
        "1 variant: Shipped Sealed only — product is not available live",
      "live+sealed":
        "2 variants: Rip Live on stream + Shipped Sealed — each has its own price and SKU",
      "live-only":
        "1 variant: Rip Live only — product is not available to ship",
    },
    appCategoryDescriptions: {
      "live rip": "Checked 1st — products opened live on stream",
      "mobros exclusive":
        "Checked 2nd — MoBros-only drops (Banger Bags, exclusives)",
      "sealed pokemon": "Checked 3rd — all sealed Pokémon products",
      "sealed one piece": "Checked 4th — all sealed One Piece products",
      "sealed lorcana":
        "Checked 5th — all sealed Lorcana / Disney Lorcana products",
      graded: "Checked 6th — also triggered by tags: psa, bgs, cgc",
      singles: "Checked 7th — individual ungraded cards",
      supplies: "Checked 8th",
      accessories: "Checked 9th — sleeves, binders, playmats, deck boxes",
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shopify/bulk/validate
//
// Fast client-side validation — no Shopify API calls.
// Use this for real-time form feedback before the user hits Preview.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/validate", (req, res) => {
  const { products } = req.body;
  if (!Array.isArray(products)) {
    return res.status(400).json({ error: "products must be an array" });
  }
  const result = bulkService.validateAll(products);
  res.json({ success: result.valid, ...result });
});

module.exports = router;
