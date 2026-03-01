const axios = require("axios");
const shopifyConfig = require("../config/shopify.config");

class ShopifyAuthService {
  constructor() {
    this.adminAccessToken = null;
    this.adminTokenExpiry = null;
  }

  /**
   * Generate Admin API token using client credentials
   */
  async getAdminAccessToken() {
    if (
      this.adminAccessToken &&
      this.adminTokenExpiry &&
      this.adminTokenExpiry > new Date()
    ) {
      return this.adminAccessToken;
    }

    try {
      console.log("ðŸ”„ Generating Admin API token...");

      const response = await axios.post(
        `https://${shopifyConfig.storeDomain}/admin/oauth/access_token`,
        {
          client_id: shopifyConfig.admin.clientId,
          client_secret: shopifyConfig.admin.clientSecret,
          grant_type: "client_credentials",
        },
        {
          headers: { "Content-Type": "application/json" },
        },
      );

      this.adminAccessToken = response.data.access_token;
      this.adminTokenExpiry = new Date();
      this.adminTokenExpiry.setSeconds(
        this.adminTokenExpiry.getSeconds() +
          (response.data.expires_in || 86400),
      );

      console.log("âœ… Admin API token generated");
      return this.adminAccessToken;
    } catch (error) {
      console.error(
        "âŒ Admin token error:",
        error.response?.data || error.message,
      );
      throw new Error("Failed to generate Admin API token");
    }
  }

  /**
   * Make Storefront API request (GraphQL)
   * Uses static private token from Headless channel
   */
  // In /backend/services/shopify-auth.service.js
  async storefrontRequest(query, variables = {}) {
    try {
      const response = await axios({
        url: `https://${shopifyConfig.storeDomain}/api/${shopifyConfig.apiVersion}/graphql.json`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Storefront-Access-Token":
            shopifyConfig.storefrontAccessToken,
        },
        data: {
          query,
          variables,
        },
      });

      if (response.data.errors) {
        console.error(
          "Storefront API Error:",
          JSON.stringify(response.data.errors, null, 2),
        );
        throw new Error(
          `Storefront API Error: ${JSON.stringify(response.data.errors)}`,
        );
      }

      return response.data;
    } catch (error) {
      console.error("Storefront request failed:", {
        message: error.message,
        responseData: JSON.stringify(error.response?.data, null, 2), // CHANGED THIS LINE
        responseStatus: error.response?.status,
      });
      throw error;
    }
  }

  /**
   * Make Admin API request (GraphQL)
   */
  async adminGraphQLRequest(query, variables = {}) {
    const token = await this.getAdminAccessToken();

    try {
      const response = await axios.post(
        `${shopifyConfig.adminApiUrl}/graphql.json`,
        { query, variables },
        {
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": token,
          },
        },
      );

      if (response.data.errors) {
        console.error("Admin GraphQL Errors:", response.data.errors);
        throw new Error(`Admin Error: ${response.data.errors[0].message}`);
      }

      return response.data.data;
    } catch (error) {
      console.error("Admin API Error:", error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Make Admin API request (REST)
   */
  async adminRequest(endpoint, method = "GET", data = null) {
    const token = await this.getAdminAccessToken();

    try {
      const response = await axios({
        method,
        url: `${shopifyConfig.adminApiUrl}${endpoint}`,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        data,
      });

      return response.data;
    } catch (error) {
      console.error("Admin API Error:", error.response?.data || error.message);
      throw error;
    }
  }
}

module.exports = new ShopifyAuthService();
