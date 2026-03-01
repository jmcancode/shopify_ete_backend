require("dotenv").config();
const axios = require("axios");

// Shopify config from environment
const shopifyConfig = {
  storeDomain: process.env.SHOPIFY_STORE_DOMAIN,
  apiVersion: process.env.SHOPIFY_API_VERSION || "2026-01",
  clientId: process.env.ADMIN_CLIENT_ID,
  clientSecret: process.env.ADMIN_CLIENT_SECRET,
};

async function getAdminToken() {
  try {
    console.log("🔄 Generating Admin API token...\n");

    const response = await axios.post(
      `https://${shopifyConfig.storeDomain}/admin/oauth/access_token`,
      {
        client_id: shopifyConfig.clientId,
        client_secret: shopifyConfig.clientSecret,
        grant_type: "client_credentials",
      },
      {
        headers: { "Content-Type": "application/json" },
      },
    );

    console.log("✅ Admin API token generated\n");
    return response.data.access_token;
  } catch (error) {
    console.error("❌ Token error:", error.response?.data || error.message);
    throw error;
  }
}

async function fetchProducts(token) {
  const query = `
    query getProducts($first: Int!) {
      products(first: $first) {
        edges {
          node {
            id
            title
            handle
            description
            status
            vendor
            productType
            tags
            createdAt
            updatedAt
            totalInventory
            featuredImage {
              url
              altText
            }
            images(first: 3) {
              edges {
                node {
                  url
                  altText
                }
              }
            }
            variants(first: 5) {
              edges {
                node {
                  id
                  title
                  price
                  compareAtPrice
                  sku
                  inventoryQuantity
                  availableForSale
                }
              }
            }
            priceRangeV2 {
              minVariantPrice {
                amount
                currencyCode
              }
              maxVariantPrice {
                amount
                currencyCode
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          hasPreviousPage
        }
      }
    }
  `;

  try {
    console.log("🔄 Fetching products from Shopify Admin API...\n");

    const response = await axios.post(
      `https://${shopifyConfig.storeDomain}/admin/api/${shopifyConfig.apiVersion}/graphql.json`,
      {
        query,
        variables: { first: 10 },
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
      },
    );

    if (response.data.errors) {
      console.error(
        "❌ GraphQL Errors:",
        JSON.stringify(response.data.errors, null, 2),
      );
      throw new Error("GraphQL query failed");
    }

    return response.data.data;
  } catch (error) {
    console.error("❌ Fetch error:", error.response?.data || error.message);
    throw error;
  }
}

async function main() {
  try {
    console.log("=".repeat(80));
    console.log("SHOPIFY ADMIN API - PRODUCT DATA TEST");
    console.log("=".repeat(80));
    console.log(`Store: ${shopifyConfig.storeDomain}`);
    console.log(`API Version: ${shopifyConfig.apiVersion}`);
    console.log("=".repeat(80) + "\n");

    // Get token
    const token = await getAdminToken();

    // Fetch products
    const data = await fetchProducts(token);

    console.log("✅ Products fetched successfully!\n");
    console.log("=".repeat(80));
    console.log(`Total products returned: ${data.products.edges.length}`);
    console.log(`Has next page: ${data.products.pageInfo.hasNextPage}`);
    console.log("=".repeat(80) + "\n");

    // Display each product
    data.products.edges.forEach((edge, index) => {
      const product = edge.node;

      console.log(`\n[${index + 1}] ${product.title}`);
      console.log("-".repeat(80));
      console.log(`ID: ${product.id}`);
      console.log(`Handle: ${product.handle}`);
      console.log(`Status: ${product.status}`);
      console.log(`Vendor: ${product.vendor}`);
      console.log(`Type: ${product.productType}`);
      console.log(`Tags: ${product.tags.join(", ")}`);
      console.log(`Total Inventory: ${product.totalInventory}`);
      console.log(
        `Created: ${new Date(product.createdAt).toLocaleDateString()}`,
      );

      // Price range
      const minPrice = parseFloat(product.priceRangeV2.minVariantPrice.amount);
      const maxPrice = parseFloat(product.priceRangeV2.maxVariantPrice.amount);
      const currency = product.priceRangeV2.minVariantPrice.currencyCode;

      if (minPrice === maxPrice) {
        console.log(`Price: ${currency} $${minPrice.toFixed(2)}`);
      } else {
        console.log(
          `Price Range: ${currency} $${minPrice.toFixed(2)} - $${maxPrice.toFixed(2)}`,
        );
      }

      // Featured image
      if (product.featuredImage) {
        console.log(`Featured Image: ${product.featuredImage.url}`);
      }

      // Images count
      console.log(`Total Images: ${product.images.edges.length}`);

      // Variants
      console.log(`\nVariants (${product.variants.edges.length}):`);
      product.variants.edges.forEach((variantEdge, vIndex) => {
        const variant = variantEdge.node;
        console.log(`  ${vIndex + 1}. ${variant.title}`);
        console.log(`     Price: $${parseFloat(variant.price).toFixed(2)}`);
        if (variant.compareAtPrice) {
          console.log(
            `     Compare At: $${parseFloat(variant.compareAtPrice).toFixed(2)}`,
          );
        }
        console.log(`     SKU: ${variant.sku || "N/A"}`);
        console.log(`     Inventory: ${variant.inventoryQuantity}`);
        console.log(
          `     Available: ${variant.availableForSale ? "Yes" : "No"}`,
        );
      });

      // Description preview
      if (product.description) {
        const preview = product.description.substring(0, 150);
        console.log(
          `\nDescription: ${preview}${product.description.length > 150 ? "..." : ""}`,
        );
      }

      console.log("-".repeat(80));
    });

    console.log("\n" + "=".repeat(80));
    console.log("✅ TEST COMPLETE");
    console.log("=".repeat(80));

    // Output JSON for inspection
    console.log("\n\n📄 FULL JSON RESPONSE (first product):");
    console.log("=".repeat(80));
    console.log(JSON.stringify(data.products.edges[0], null, 2));
  } catch (error) {
    console.error("\n❌ Test failed:", error.message);
    process.exit(1);
  }
}

main();
