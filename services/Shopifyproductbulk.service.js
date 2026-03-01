/**
 * shopify-product-bulk.service.js
 *
 * Bulk product management for the MoBros admin panel.
 *
 * Responsibilities:
 *  - Validation against getCategoryFromProductType() rules in api.ts
 *  - Building correct Shopify Admin REST payloads (Format variants, tags, vendor)
 *  - Rate-limited writes to Shopify (2/sec sustained)
 *  - Full catalog fetching with issue detection
 *
 * Depends on:  shopify-auth.service.js  (adminRequest)
 * Used by:     shopify-product-bulk.routes.js
 */

"use strict";

const shopifyAuthService = require("./shopify-auth.service");

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// Mirrors getCategoryFromProductType() in api.ts EXACTLY.
// Update here whenever the app function changes.
// ─────────────────────────────────────────────────────────────────────────────

const APP_CATEGORY_TAGS = [
  "live rip", // checked 1st
  "mobros exclusive", // checked 2nd
  "sealed pokemon", // checked 3rd
  "sealed one piece", // checked 4th
  "sealed lorcana", // checked 5th
  "graded", // checked 6th — also triggered by: psa, bgs, cgc
  "singles", // checked 7th — also triggered by: single
  "supplies", // checked 8th — also triggered by: supply
  "accessories", // checked 9th — also triggered by: accessory
];

const VALID_VENDORS = [
  "Pokemon",
  "One Piece",
  "Lorcana",
  "MoBrosTC",
  "ULTRA PRO",
  "ULTIMATE GUARD",
  "GAMEGENIC",
  "Dueling Guard",
];

const VALID_VARIANT_TYPES = ["sealed-only", "live+sealed", "live-only"];
const VALID_STATUSES = ["active", "draft", "archived"];

const WRITE_DELAY_MS = 500; // 2 writes/sec — safe under Shopify's 40/sec burst limit

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate one product object before sending to Shopify.
 *
 * Required fields:
 *   handle         — must match an existing Shopify product handle
 *   title          — clean, max 70 chars, no (SEALED) prefix
 *   vendor         — one of VALID_VENDORS
 *   appCategoryTag — exact phrase from APP_CATEGORY_TAGS
 *   variantType    — 'sealed-only' | 'live+sealed' | 'live-only'
 *   sealedPrice    — required when variantType includes sealed
 *   livePrice      — required when variantType includes live
 *
 * @param {Object} product
 * @returns {{ valid: boolean, errors: string[], warnings: string[], handle: string }}
 */
function validateProduct(product) {
  const errors = [];
  const warnings = [];

  if (!product.handle?.trim()) {
    errors.push(
      "handle is required — must match the existing Shopify product handle exactly",
    );
  }

  if (!product.title?.trim()) {
    errors.push("title is required");
  } else {
    if (product.title.startsWith("(SEALED)")) {
      errors.push(
        "title must not start with (SEALED) — remove it, this damages SEO",
      );
    }
    if (product.title.length > 70) {
      warnings.push(
        `title is ${product.title.length} chars — Google truncates at 70`,
      );
    }
    if (/\s{2,}/.test(product.title)) {
      warnings.push("title has double spaces — clean before uploading");
    }
  }

  if (!product.appCategoryTag) {
    errors.push(
      "appCategoryTag is required — without it the product falls through to the wrong " +
        `app section. Must be one of: ${APP_CATEGORY_TAGS.join(", ")}`,
    );
  } else if (
    !APP_CATEGORY_TAGS.includes(product.appCategoryTag.toLowerCase())
  ) {
    errors.push(
      `appCategoryTag "${product.appCategoryTag}" is not valid. ` +
        `Must be exactly one of: ${APP_CATEGORY_TAGS.join(", ")}`,
    );
  }

  if (!product.vendor) {
    warnings.push(
      "vendor is blank — product will not appear in brand sections",
    );
  } else if (!VALID_VENDORS.includes(product.vendor)) {
    warnings.push(
      `vendor "${product.vendor}" is not a recognized vendor — check spelling`,
    );
  }

  if (!product.variantType) {
    errors.push(
      "variantType is required: sealed-only | live+sealed | live-only",
    );
  } else if (!VALID_VARIANT_TYPES.includes(product.variantType)) {
    errors.push(
      `variantType "${product.variantType}" is invalid. Must be: ${VALID_VARIANT_TYPES.join(", ")}`,
    );
  } else {
    const needsSealed = ["sealed-only", "live+sealed"].includes(
      product.variantType,
    );
    const needsLive = ["live-only", "live+sealed"].includes(
      product.variantType,
    );

    if (
      needsSealed &&
      (product.sealedPrice == null || product.sealedPrice === "")
    ) {
      errors.push("sealedPrice is required for sealed-only and live+sealed");
    } else if (needsSealed && isNaN(parseFloat(product.sealedPrice))) {
      errors.push("sealedPrice must be a number");
    }

    if (needsLive && (product.livePrice == null || product.livePrice === "")) {
      errors.push("livePrice is required for live+sealed and live-only");
    } else if (needsLive && isNaN(parseFloat(product.livePrice))) {
      errors.push("livePrice must be a number");
    }
  }

  if (product.status && !VALID_STATUSES.includes(product.status)) {
    errors.push(
      `status "${product.status}" must be: ${VALID_STATUSES.join(", ")}`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    handle: product.handle,
    title: product.title,
  };
}

/**
 * Validate an array of products.
 * @returns {{ valid, total, passCount, failCount, warningCount, results, invalidHandles }}
 */
function validateAll(products) {
  const results = products.map((p, i) => ({ index: i, ...validateProduct(p) }));
  return {
    valid: results.every((r) => r.valid),
    total: products.length,
    passCount: results.filter((r) => r.valid).length,
    failCount: results.filter((r) => !r.valid).length,
    warningCount: results.filter((r) => r.warnings.length > 0).length,
    results,
    invalidHandles: results.filter((r) => !r.valid).map((r) => r.handle),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TAG BUILDER
// Preserves all existing Shopify tags, injects the app category phrase,
// and adds 'Live Rip' / 'Shipped Sealed' display tags based on variantType.
// ─────────────────────────────────────────────────────────────────────────────

function buildTags(existingTagsStr, appCategoryTag, variantType, extraTags) {
  const tagSet = new Set(
    (existingTagsStr || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  );

  // App category phrase (lowercase — what getCategoryFromProductType searches for)
  if (appCategoryTag) {
    tagSet.add(appCategoryTag.toLowerCase());
  }

  // Human-readable display tags for Shopify collections / mobile filtering
  if (variantType === "live+sealed" || variantType === "live-only") {
    tagSet.add("Live Rip");
  }
  if (variantType === "live+sealed" || variantType === "sealed-only") {
    tagSet.add("Shipped Sealed");
  }

  if (extraTags) {
    extraTags.split(",").forEach((t) => {
      const clean = t.trim();
      if (clean) tagSet.add(clean);
    });
  }

  return Array.from(tagSet).join(", ");
}

// ─────────────────────────────────────────────────────────────────────────────
// VARIANT BUILDER
// Option1 Name = 'Format' / Values = 'Rip Live' | 'Shipped Sealed'
// Preserves existing variant IDs so Shopify updates in place.
// ─────────────────────────────────────────────────────────────────────────────

function skuFromHandle(handle, suffix) {
  return (
    handle
      .replace(/[^a-z0-9]/gi, "-")
      .replace(/-+/g, "-")
      .slice(0, 32)
      .replace(/-$/, "")
      .toUpperCase() +
    "-" +
    suffix
  );
}

function buildVariants(product, existingVariants = []) {
  const {
    variantType,
    sealedPrice,
    livePrice,
    sealedQty,
    liveQty,
    sealedSku,
    liveSku,
    handle,
  } = product;

  const findEx = (val) =>
    existingVariants.find(
      (v) => (v.option1 || v.title || "").toLowerCase() === val.toLowerCase(),
    );

  const makeVariant = (optionValue, price, sku, qty, ex) => ({
    ...(ex?.id && { id: ex.id }),
    option1: optionValue,
    price: String(parseFloat(price).toFixed(2)),
    sku:
      sku ||
      ex?.sku ||
      skuFromHandle(handle, optionValue === "Rip Live" ? "LIVE" : "SEAL"),
    inventory_quantity: qty ?? ex?.inventory_quantity ?? 0,
    requires_shipping: true,
    taxable: true,
  });

  if (variantType === "sealed-only") {
    return [
      makeVariant(
        "Shipped Sealed",
        sealedPrice,
        sealedSku,
        sealedQty,
        findEx("Shipped Sealed"),
      ),
    ];
  }
  if (variantType === "live-only") {
    return [
      makeVariant("Rip Live", livePrice, liveSku, liveQty, findEx("Rip Live")),
    ];
  }
  if (variantType === "live+sealed") {
    return [
      makeVariant("Rip Live", livePrice, liveSku, liveQty, findEx("Rip Live")),
      makeVariant(
        "Shipped Sealed",
        sealedPrice,
        sealedSku,
        sealedQty,
        findEx("Shipped Sealed"),
      ),
    ];
  }

  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYLOAD BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the full Shopify Admin REST PUT body for one product.
 *
 * @param {Object} cleanProduct    — Validated product from the admin form
 * @param {Object} existingProduct — Current product data from Shopify
 * @returns {{ id, product }}
 */
function buildPayload(cleanProduct, existingProduct) {
  const tags = buildTags(
    existingProduct.tags,
    cleanProduct.appCategoryTag,
    cleanProduct.variantType,
    cleanProduct.extraTags,
  );
  const variants = buildVariants(cleanProduct, existingProduct.variants || []);

  return {
    id: existingProduct.id,
    product: {
      title: cleanProduct.title,
      vendor: cleanProduct.vendor,
      product_type:
        cleanProduct.productType || existingProduct.product_type || "",
      tags,
      status: cleanProduct.status || existingProduct.status || "active",
      options: [{ name: "Format" }],
      variants,
      ...(cleanProduct.bodyHtml !== undefined && {
        body_html: cleanProduct.bodyHtml,
      }),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SHOPIFY READS
// ─────────────────────────────────────────────────────────────────────────────

async function fetchProductByHandle(handle) {
  try {
    const data = await shopifyAuthService.adminRequest(
      `/products.json?handle=${encodeURIComponent(handle)}&fields=id,title,handle,vendor,product_type,tags,status,variants,options`,
    );
    return data?.products?.[0] || null;
  } catch (err) {
    console.error(
      `[BulkService] fetchProductByHandle(${handle}):`,
      err.message,
    );
    throw err;
  }
}

/**
 * Fetch the full product catalog, paginated at 250/page.
 *
 * @param {Function} [onPage] — Called after each page: (products[], pageNum) => void
 * @returns {Object[]} All products
 */
async function fetchAllProducts(onPage) {
  const all = [];
  const fields =
    "id,title,handle,vendor,product_type,tags,status,variants,options";
  let sinceId = null;
  let pageNum = 1;

  console.log("[BulkService] Fetching catalog...");

  while (true) {
    const endpoint = sinceId
      ? `/products.json?limit=250&since_id=${sinceId}&fields=${fields}`
      : `/products.json?limit=250&fields=${fields}`;

    const data = await shopifyAuthService.adminRequest(endpoint);
    const page = data?.products || [];

    if (page.length === 0) break;
    all.push(...page);

    if (onPage) onPage(page, pageNum);
    if (page.length < 250) break;

    sinceId = page[page.length - 1].id;
    pageNum++;
    await sleep(WRITE_DELAY_MS);
  }

  console.log(`[BulkService] Catalog: ${all.length} products`);
  return all;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHOPIFY WRITES
// ─────────────────────────────────────────────────────────────────────────────

async function writeProduct(payload) {
  return shopifyAuthService.adminRequest(
    `/products/${payload.id}.json`,
    "PUT",
    { product: payload.product },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BULK UPDATE ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate → fetch current state → build payloads → write to Shopify.
 *
 * @param {Object[]} products
 * @param {Object}   options
 * @param {boolean}  [options.dryRun=false]
 * @param {Function} [options.onProgress]  — ({ done, total, handle, success, pct }) => void
 * @param {Function} [options.onError]     — ({ handle, error }) => void
 * @returns {{ success, dryRun, total, processed, failed, results, validation }}
 */
async function bulkUpdateProducts(products, options = {}) {
  const { dryRun = false, onProgress, onError } = options;

  const validation = validateAll(products);
  if (!validation.valid) {
    return {
      success: false,
      aborted: true,
      reason: "Validation failed — no writes performed",
      validation,
    };
  }

  const total = products.length;
  let processed = 0,
    failed = 0;
  const results = [];

  console.log(
    `[BulkService] ${dryRun ? "DRY RUN" : "UPDATE"}: ${total} products`,
  );

  for (const product of products) {
    const { handle } = product;
    try {
      const existing = await fetchProductByHandle(handle);
      if (!existing)
        throw new Error(
          `Handle "${handle}" not found. Use CSV import for new products.`,
        );

      const payload = buildPayload(product, existing);

      if (!dryRun) {
        const updated = await writeProduct(payload);
        results.push({
          handle,
          success: true,
          productId: existing.id,
          title: updated?.product?.title,
        });
        console.log(`[BulkService] ✅ ${handle}`);
      } else {
        results.push({
          handle,
          success: true,
          dryRun: true,
          payload: payload.product,
        });
      }

      processed++;
    } catch (err) {
      failed++;
      const msg = err.response?.data?.errors
        ? JSON.stringify(err.response.data.errors)
        : err.message;
      console.error(`[BulkService] ❌ ${handle} — ${msg}`);
      results.push({ handle, success: false, error: msg });
      if (onError) onError({ handle, error: msg });
    }

    const done = processed + failed;
    if (onProgress)
      onProgress({
        done,
        total,
        handle,
        success: results[results.length - 1].success,
        pct: Math.round((done / total) * 100),
      });

    if (!dryRun && done < total) await sleep(WRITE_DELAY_MS);
  }

  return {
    success: failed === 0,
    dryRun,
    total,
    processed,
    failed,
    results,
    validation,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CATALOG ENRICHMENT
// Derive what the app would do with existing product data — used to flag issues.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirror getCategoryFromProductType() against existing Shopify data.
 * Returns null if no match — that product will fall through to the app default.
 */
function deriveAppCategory(productType, tagsStr) {
  const joined = `${productType || ""} ${tagsStr || ""}`.toLowerCase();

  if (joined.includes("live rip")) return "live rip";
  if (
    joined.includes("mobros exclusive") ||
    joined.includes("mobros exclusives") ||
    joined.includes("banger bags")
  )
    return "mobros exclusive";
  if (joined.includes("sealed pokemon") || joined.includes("sealed pokémon"))
    return "sealed pokemon";
  if (joined.includes("sealed one piece")) return "sealed one piece";
  if (joined.includes("sealed lorcana")) return "sealed lorcana";
  if (
    joined.includes("graded") ||
    joined.includes("psa") ||
    joined.includes("bgs") ||
    joined.includes("cgc")
  )
    return "graded";
  if (joined.includes("single")) return "singles";
  if (joined.includes("suppl")) return "supplies";
  if (joined.includes("accessor") || joined.includes("tcg accessories"))
    return "accessories";

  // Fallback derivation from game tag
  if (joined.includes("pokemon")) return "sealed pokemon";
  if (joined.includes("one piece")) return "sealed one piece";
  if (joined.includes("lorcana")) return "sealed lorcana";

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  validateProduct,
  validateAll,
  buildPayload,
  buildTags,
  buildVariants,
  bulkUpdateProducts,
  fetchAllProducts,
  fetchProductByHandle,
  deriveAppCategory,
  APP_CATEGORY_TAGS,
  VALID_VENDORS,
  VALID_VARIANT_TYPES,
  VALID_STATUSES,
};
