const axios = require("axios");
const https = require("https");

// NOTE: Do NOT destructure from process.env here at module load time.
// dotenv.config() may not have run yet when this module is required.
// Credentials are read lazily inside scrydexFetch() instead.

// Create HTTPS agent with proper TLS configuration
// This helps resolve SSL/TLS version negotiation issues
const httpsAgent = new https.Agent({
  rejectUnauthorized: true, // Keep SSL verification enabled for security
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.3",
  keepAlive: true,
});

/**
 * Fetch data from Scrydex API
 * @param {string} endpoint - API endpoint (e.g., "/cards", "/cards?q=charizard")
 * @returns {Promise<Object>} API response data
 */
async function scrydexFetch(endpoint) {
  const baseURL = "https://api.scrydex.com/pokemon/v1";
  const url = `${baseURL.replace(/\/$/, "")}/${endpoint.replace(/^\//, "")}`;

  // Read credentials lazily — dotenv must be loaded before first call
  const apiKey = process.env.SCRYDEX_API_KEY;
  const teamId = process.env.SCRYDEX_TEAM_ID;

  console.log("🌐 Scrydex API Request:", url);

  if (!apiKey || !teamId) {
    throw new Error(
      `Missing Scrydex credentials — SCRYDEX_API_KEY: ${apiKey ? "✓" : "MISSING"}, SCRYDEX_TEAM_ID: ${teamId ? "✓" : "MISSING"}`,
    );
  }

  try {
    const response = await axios({
      method: "GET",
      url: url,
      headers: {
        "X-Api-Key": apiKey,
        "X-Team-ID": teamId,
        Accept: "application/json",
      },
      httpsAgent: httpsAgent,
      timeout: 15000, // 15 second timeout
      validateStatus: () => true, // Handle all status codes manually
    });

    console.log("📄 Response Status:", response.status);

    if (response.status >= 200 && response.status < 300) {
      console.log("✅ Successfully received response from Scrydex");
      return response.data;
    } else {
      const errorMsg = `Scrydex API error ${response.status}`;
      console.error("❌", errorMsg);
      console.error(
        "Response:",
        JSON.stringify(response.data).substring(0, 500),
      );
      throw new Error(errorMsg);
    }
  } catch (err) {
    if (err.response) {
      // Server responded with error status
      console.error("❌ Scrydex API Error:", err.response.status);
      console.error("Response data:", err.response.data);
      throw new Error(
        `Scrydex API error ${err.response.status}: ${JSON.stringify(
          err.response.data,
        )}`,
      );
    } else if (err.request) {
      // Request made but no response received
      console.error("❌ No response from Scrydex API:", err.message);
      console.error("Error code:", err.code);

      // Provide helpful error messages for common issues
      if (
        err.code === "EPROTO" ||
        err.code === "ERR_SSL_WRONG_VERSION_NUMBER"
      ) {
        console.error("\n💡 SSL/TLS Error - Possible solutions:");
        console.error("   1. Try from a different network (disable VPN)");
        console.error(
          "   2. Check if corporate firewall is doing SSL inspection",
        );
        console.error("   3. Verify DNS: nslookup api.scrydex.com");
        console.error("   4. Contact IT about whitelisting api.scrydex.com");
      }

      throw new Error(`No response from Scrydex API: ${err.message}`);
    } else {
      // Error setting up the request
      console.error("❌ Request setup error:", err.message);
      throw err;
    }
  }
}

module.exports = { scrydexFetch };
