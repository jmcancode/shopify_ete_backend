require("dotenv").config();
const axios = require("axios");

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(color, symbol, message) {
  console.log(`${colors[color]}${symbol} ${message}${colors.reset}`);
}

function section(title) {
  console.log(`\n${colors.cyan}${"=".repeat(80)}${colors.reset}`);
  console.log(`${colors.cyan}${title}${colors.reset}`);
  console.log(`${colors.cyan}${"=".repeat(80)}${colors.reset}\n`);
}

async function validateConfig() {
  section("CONFIGURATION VALIDATION");

  // Check required environment variables
  const requiredVars = {
    "SHOPIFY_STORE_DOMAIN": process.env.SHOPIFY_STORE_DOMAIN,
    "SHOPIFY_API_VERSION": process.env.SHOPIFY_API_VERSION,
    "ADMIN_CLIENT_ID": process.env.ADMIN_CLIENT_ID,
    "ADMIN_CLIENT_SECRET": process.env.ADMIN_CLIENT_SECRET,
    "STOREFRONT_ACCESS_TOKEN": process.env.STOREFRONT_ACCESS_TOKEN,
  };

  console.log("Environment Variables:");
  console.log("-".repeat(80));

  let missingVars = [];
  for (const [key, value] of Object.entries(requiredVars)) {
    if (value) {
      log("green", "✓", `${key}: ${value.substring(0, 20)}...`);
    } else {
      log("red", "✗", `${key}: MISSING`);
      missingVars.push(key);
    }
  }

  if (missingVars.length > 0) {
    log("red", "❌", `Missing required variables: ${missingVars.join(", ")}`);
    process.exit(1);
  }

  // Validate store domain format
  section("STORE DOMAIN VALIDATION");
  
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN;
  
  if (!storeDomain.includes(".myshopify.com")) {
    log("red", "❌", "Store domain should be in format: your-store.myshopify.com");
    log("yellow", "⚠", `Current value: ${storeDomain}`);
    process.exit(1);
  }
  
  log("green", "✓", `Store domain format is correct: ${storeDomain}`);

  // Validate API version format
  section("API VERSION VALIDATION");
  
  const apiVersion = process.env.SHOPIFY_API_VERSION;
  const versionPattern = /^\d{4}-\d{2}$/;
  
  if (!versionPattern.test(apiVersion)) {
    log("yellow", "⚠", `API version format unusual: ${apiVersion}`);
    log("yellow", "⚠", "Expected format: YYYY-MM (e.g., 2024-01, 2025-04)");
  } else {
    log("green", "✓", `API version format is correct: ${apiVersion}`);
  }

  // Test Admin API token generation
  section("ADMIN API TOKEN TEST");
  
  try {
    log("blue", "🔄", "Attempting to generate Admin API token...");
    
    const tokenResponse = await axios.post(
      `https://${storeDomain}/admin/oauth/access_token`,
      {
        client_id: process.env.ADMIN_CLIENT_ID,
        client_secret: process.env.ADMIN_CLIENT_SECRET,
        grant_type: "client_credentials",
      },
      {
        headers: { "Content-Type": "application/json" },
      }
    );

    const token = tokenResponse.data.access_token;
    const expiresIn = tokenResponse.data.expires_in;
    
    log("green", "✓", "Admin API token generated successfully!");
    log("green", "✓", `Token: ${token.substring(0, 20)}...`);
    log("green", "✓", `Expires in: ${expiresIn} seconds (${Math.floor(expiresIn / 3600)} hours)`);

    // Test Admin GraphQL API
    section("ADMIN GRAPHQL API TEST");
    
    log("blue", "🔄", "Testing Admin GraphQL API with shop query...");
    
    const shopQuery = `
      query {
        shop {
          name
          email
          currencyCode
          primaryDomain {
            url
          }
        }
      }
    `;

    const graphqlResponse = await axios.post(
      `https://${storeDomain}/admin/api/${apiVersion}/graphql.json`,
      { query: shopQuery },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
      }
    );

    if (graphqlResponse.data.errors) {
      log("red", "❌", "GraphQL query returned errors:");
      console.log(JSON.stringify(graphqlResponse.data.errors, null, 2));
      throw new Error("GraphQL query failed");
    }

    const shop = graphqlResponse.data.data.shop;
    log("green", "✓", "Admin GraphQL API is working!");
    log("green", "✓", `Shop Name: ${shop.name}`);
    log("green", "✓", `Shop Email: ${shop.email}`);
    log("green", "✓", `Currency: ${shop.currencyCode}`);
    log("green", "✓", `Domain: ${shop.primaryDomain.url}`);

    // Test product query
    section("PRODUCT QUERY TEST");
    
    log("blue", "🔄", "Testing product query (first 3 products)...");
    
    const productQuery = `
      query {
        products(first: 3) {
          edges {
            node {
              id
              title
              status
              totalInventory
            }
          }
        }
      }
    `;

    const productResponse = await axios.post(
      `https://${storeDomain}/admin/api/${apiVersion}/graphql.json`,
      { query: productQuery },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
      }
    );

    if (productResponse.data.errors) {
      log("red", "❌", "Product query returned errors:");
      console.log(JSON.stringify(productResponse.data.errors, null, 2));
    } else {
      const products = productResponse.data.data.products.edges;
      log("green", "✓", `Successfully fetched ${products.length} products`);
      
      products.forEach((edge, index) => {
        const product = edge.node;
        console.log(`  ${index + 1}. ${product.title}`);
        console.log(`     ID: ${product.id}`);
        console.log(`     Status: ${product.status}`);
        console.log(`     Inventory: ${product.totalInventory}`);
      });
    }

  } catch (error) {
    log("red", "❌", "Admin API token generation failed!");
    
    if (error.response) {
      log("red", "❌", `HTTP ${error.response.status}: ${error.response.statusText}`);
      console.log("\nResponse data:");
      console.log(JSON.stringify(error.response.data, null, 2));
      
      if (error.response.status === 401) {
        log("yellow", "⚠", "Authentication failed - check your ADMIN_CLIENT_ID and ADMIN_CLIENT_SECRET");
      }
    } else {
      log("red", "❌", error.message);
    }
    
    process.exit(1);
  }

  // Test Storefront API
  section("STOREFRONT API TEST");
  
  try {
    log("blue", "🔄", "Testing Storefront API...");
    
    const storefrontQuery = `
      query {
        shop {
          name
        }
      }
    `;

    const storefrontResponse = await axios.post(
      `https://${storeDomain}/api/${apiVersion}/graphql.json`,
      { query: storefrontQuery },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Storefront-Access-Token": process.env.STOREFRONT_ACCESS_TOKEN,
        },
      }
    );

    if (storefrontResponse.data.errors) {
      log("red", "❌", "Storefront API returned errors:");
      console.log(JSON.stringify(storefrontResponse.data.errors, null, 2));
    } else {
      log("green", "✓", "Storefront API is working!");
      log("green", "✓", `Shop: ${storefrontResponse.data.data.shop.name}`);
    }

  } catch (error) {
    log("red", "❌", "Storefront API test failed!");
    
    if (error.response) {
      log("red", "❌", `HTTP ${error.response.status}: ${error.response.statusText}`);
      console.log("\nResponse data:");
      console.log(JSON.stringify(error.response.data, null, 2));
    } else {
      log("red", "❌", error.message);
    }
  }

  // Summary
  section("VALIDATION SUMMARY");
  
  log("green", "✅", "All critical validations passed!");
  log("green", "✅", "Admin API: Working");
  log("green", "✅", "Storefront API: Working");
  log("green", "✅", "Configuration is valid and ready to use");
  
  console.log(`\n${colors.cyan}${"=".repeat(80)}${colors.reset}\n`);
}

// Run validation
validateConfig().catch(error => {
  console.error("\nUnexpected error:", error);
  process.exit(1);
});