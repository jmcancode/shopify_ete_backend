const express = require("express");
const router = express.Router();
const shopifyStorefront = require("../services/shopify-storefront.service");

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalize a raw Shopify product edge node into the slim shape
 * the mobile app grid needs. Keeps payload ~80% smaller than full products.
 */
function toSlimProduct(node) {
  const firstVariant = node.variants?.edges?.[0]?.node ?? null;
  const tags = node.tags ?? [];

  return {
    id: node.id,
    title: node.title,
    handle: node.handle,
    vendor: node.vendor ?? "",
    productType: node.productType ?? "",
    tags,
    category: deriveCategoryFromTags(tags, node.productType),
    brand: deriveBrand(node.vendor),
    image: node.featuredImage?.url ?? null,
    price: firstVariant ? parseFloat(firstVariant.price.amount) : 0,
    compareAtPrice: firstVariant?.compareAtPrice
      ? parseFloat(firstVariant.compareAtPrice.amount)
      : null,
    inStock: firstVariant?.availableForSale ?? false,
    variantId: firstVariant?.id ?? null,
    isNew: tags.some((t) => t.toLowerCase() === "new-arrival"),
    // ← ADD THIS: ProductDetails needs a variants array
    variants:
      node.variants?.edges?.map((e) => ({
        id: e.node.id,
        title: e.node.title,
        price: parseFloat(e.node.price.amount),
        compareAtPrice: e.node.compareAtPrice
          ? parseFloat(e.node.compareAtPrice.amount)
          : null,
        available: e.node.availableForSale,
        image: e.node.image?.url ?? null,
      })) ?? [],
  };
}

function deriveCategoryFromTags(tags = [], productType = "") {
  const lower = tags.map((t) => t.toLowerCase());
  const type = (productType ?? "").toLowerCase();

  if (lower.includes("live-rip") || lower.includes("live rip"))
    return "live rip";
  if (lower.includes("mobros-exclusive") || lower.includes("mobros exclusive"))
    return "mobros exclusive";
  if (lower.includes("graded")) return "graded";
  if (lower.includes("singles")) return "singles";
  if (lower.includes("supplies")) return "supplies";
  if (lower.includes("accessories")) return "accessories";
  if (lower.includes("one-piece") || lower.includes("one piece"))
    return "sealed one piece";
  if (lower.includes("lorcana")) return "sealed lorcana";
  if (lower.includes("pokemon") || lower.includes("pokémon"))
    return "sealed pokemon";
  if (type.includes("singles")) return "singles";
  if (type.includes("sealed")) return "sealed pokemon";
  return "other";
}

function deriveBrand(vendor = "") {
  const v = (vendor ?? "").toLowerCase();
  if (v.includes("pokemon") || v.includes("pokémon")) return "pokemon";
  if (v.includes("one piece")) return "onepiece";
  if (v.includes("lorcana")) return "lorcana";
  if (v.includes("labubu")) return "labubu";
  return vendor ?? "";
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/shopify/products
 *
 * Returns slim product list optimised for grid rendering.
 * Uses the storefront service's in-memory cache (5 min TTL).
 * Response is ~80% smaller than the full product payload.
 */
router.get("/products", async (req, res) => {
  try {
    // getAllProducts() auto-paginates and caches all 832 products in memory.
    // Subsequent requests within 5 min return instantly from cache.
    const edges = await shopifyStorefront.getAllProducts();

    const products = edges
      .map((edge) => toSlimProduct(edge.node))
      .filter((p) => p.inStock); // only send in-stock to the app

    res.json({
      success: true,
      data: {
        products: { edges: products.map((p) => ({ node: p })) },
        pageInfo: { hasNextPage: false, hasPreviousPage: false },
      },
    });
  } catch (error) {
    console.error("Get products error:", error);
    res.status(500).json({
      error: "Failed to fetch products",
      message: error.message,
    });
  }
});

/**
 * GET /api/shopify/products/:handle
 * Full product detail for the product detail screen.
 */
router.get("/products/:handle", async (req, res) => {
  try {
    const product = await shopifyStorefront.getProductByHandle(
      req.params.handle,
    );

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json({ success: true, data: product });
  } catch (error) {
    console.error("Get product error:", error);
    res.status(500).json({
      error: "Failed to fetch product",
      message: error.message,
    });
  }
});

/**
 * GET /api/shopify/collections
 */
router.get("/collections", async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const collections = await shopifyStorefront.getCollections(parseInt(limit));
    res.json({ success: true, data: collections });
  } catch (error) {
    console.error("Get collections error:", error);
    res.status(500).json({
      error: "Failed to fetch collections",
      message: error.message,
    });
  }
});

module.exports = router;
