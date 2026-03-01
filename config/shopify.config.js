require("dotenv").config();

const shopifyConfig = {
  storeDomain: process.env.SHOPIFY_STORE_DOMAIN,
  apiVersion: process.env.SHOPIFY_API_VERSION || "2026-01",

  admin: {
    clientId: process.env.ADMIN_CLIENT_ID,
    clientSecret: process.env.ADMIN_CLIENT_SECRET,
    accessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
  },

  storefront: {
    accessToken: process.env.STOREFRONT_ACCESS_TOKEN,
  },

  get storefrontApiUrl() {
    return `https://${this.storeDomain}/api/${this.apiVersion}/graphql.json`;
  },

  get adminApiUrl() {
    return `https://${this.storeDomain}/admin/api/${this.apiVersion}`;
  },
};

const requiredVars = [
  "SHOPIFY_STORE_DOMAIN",
  "ADMIN_CLIENT_ID",
  "ADMIN_CLIENT_SECRET",
  "STOREFRONT_ACCESS_TOKEN",
];

const missing = requiredVars.filter((v) => !process.env[v]);

if (missing.length > 0) {
  console.error(`❌ Missing: ${missing.join(", ")}`);
  throw new Error(`Missing env vars: ${missing.join(", ")}`);
}

module.exports = shopifyConfig;
