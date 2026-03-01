const axios = require("axios");

const isSandbox = process.env.EBAY_ENV === "sandbox";

const EBAY_CONFIG = {
  sandbox: {
    clientId: process.env.SANDBOX_EBAY_CLIENT_ID,
    clientSecret: process.env.SANDBOX_EBAY_CLIENT_SECRET,
    tokenUrl: "https://api.sandbox.ebay.com/identity/v1/oauth2/token",
    apiBase: "https://api.sandbox.ebay.com",
  },
  production: {
    clientId: process.env.PRODUCTION_EBAY_CLIENT_ID,
    clientSecret: process.env.PRODUCTION_EBAY_CLIENT_SECRET,
    tokenUrl: "https://api.ebay.com/identity/v1/oauth2/token",
    apiBase: "https://api.ebay.com",
  },
};

const config = isSandbox ? EBAY_CONFIG.sandbox : EBAY_CONFIG.production;

class EbayAuthService {
  constructor() {
    this.accessToken = null;
    this.tokenExpiry = null;
    this.config = config;
  }

  async getAccessToken() {
    if (this.accessToken && this.tokenExpiry && this.tokenExpiry > new Date()) {
      return this.accessToken;
    }

    const { clientId, clientSecret, tokenUrl } = this.config;

    if (!clientId || !clientSecret) {
      throw new Error(
        `Missing eBay credentials for ${isSandbox ? "SANDBOX" : "PRODUCTION"} environment. Check your .env file.`,
      );
    }

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
      "base64",
    );

    try {
      console.log(
        `🔄 Generating eBay access token [${isSandbox ? "SANDBOX" : "PRODUCTION"}]...`,
      );

      const response = await axios.post(
        tokenUrl,
        new URLSearchParams({
          grant_type: "client_credentials",
          scope: "https://api.ebay.com/oauth/api_scope",
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${credentials}`,
          },
        },
      );

      this.accessToken = response.data.access_token;
      this.tokenExpiry = new Date(Date.now() + response.data.expires_in * 1000);

      console.log(
        `✅ eBay access token generated [expires in ${response.data.expires_in}s]`,
      );
      console.log("DEBUG clientId:", clientId);
      console.log("DEBUG clientSecret length:", clientSecret?.length);
      console.log("DEBUG secret last 4:", clientSecret?.slice(-4));
      return this.accessToken;
    } catch (error) {
      console.error(
        "❌ eBay token error:",
        error.response?.data || error.message,
      );
      throw new Error(
        `Failed to generate eBay token: ${JSON.stringify(error.response?.data || error.message)}`,
      );
    }
  }

  getApiBase() {
    return this.config.apiBase;
  }
}

module.exports = new EbayAuthService();
