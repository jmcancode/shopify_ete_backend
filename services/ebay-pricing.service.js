const axios = require("axios");
const ebayAuthService = require("./ebay-auth.service");

class EbayPricingService {
  /**
   * Search active Buy It Now listings for market comps
   * @param {string} query - e.g. "PSA 10 Charizard Evolving Skies 215"
   * @param {number} limit - number of results (default 10)
   */
  async getActiveListings(query, limit = 10) {
    const token = await ebayAuthService.getAccessToken();
    const apiBase = ebayAuthService.getApiBase();

    try {
      const response = await axios.get(
        `${apiBase}/buy/browse/v1/item_summary/search`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
            "Content-Type": "application/json",
          },
          params: {
            q: query,
            category_ids: "183454",
            filter: [
              "buyingOptions:{FIXED_PRICE}",
              "conditions:{2750}",
              "price:[10..5000]",
            ].join(","),
            limit: limit * 3, // Fetch extra to account for post-filter removal
            sort: "price",
          },
        },
      );

      const items = response.data.itemSummaries || [];

      // Post-filter: remove obvious junk listings
      const filtered = items.filter((item) => {
        const title = item.title.toLowerCase();
        const price = parseFloat(item.price?.value || 0);

        const isJunk =
          title.includes("keychain") ||
          title.includes("proxy") ||
          title.includes("reprint") ||
          title.includes("mystery") ||
          title.includes("digital") ||
          title.includes("code card") ||
          title.includes("lot of") ||
          title.includes("bundle") ||
          item.condition === "Ungraded";

        return !isJunk && price >= 10;
      });

      console.log(
        `eBay: ${items.length} raw → ${filtered.length} filtered for: "${query}"`,
      );

      return filtered.slice(0, limit).map((item) => ({
        itemId: item.itemId,
        title: item.title,
        price: parseFloat(item.price?.value || 0),
        currency: item.price?.currency || "USD",
        condition: item.condition,
        listingUrl: item.itemWebUrl,
        imageUrl: item.image?.imageUrl || null,
        seller: item.seller?.username || null,
        shippingCost: parseFloat(
          item.shippingOptions?.[0]?.shippingCost?.value || 0,
        ),
      }));
    } catch (error) {
      console.error(
        "❌ eBay Browse API error:",
        JSON.stringify(error.response?.data || error.message, null, 2),
      );
      throw error;
    }
  }

  calculateMarketSummary(listings) {
    if (!listings.length) {
      return { count: 0, lowest: null, average: null, median: null };
    }

    const prices = listings.map((l) => l.price).sort((a, b) => a - b);

    // Remove statistical outliers (beyond 2x the median)
    const mid = Math.floor(prices.length / 2);
    const median =
      prices.length % 2 === 0
        ? (prices[mid - 1] + prices[mid]) / 2
        : prices[mid];

    const cleaned = prices.filter(
      (p) => p <= median * 2.5 && p >= median * 0.3,
    );

    if (!cleaned.length)
      return { count: 0, lowest: null, average: null, median: null };

    const sum = cleaned.reduce((acc, p) => acc + p, 0);

    return {
      count: cleaned.length,
      lowest: cleaned[0],
      highest: cleaned[cleaned.length - 1],
      average: parseFloat((sum / cleaned.length).toFixed(2)),
      median: parseFloat(median.toFixed(2)),
      rawCount: prices.length,
    };
  }

  /**
   * Calculate market summary from active listings
   */
  calculateMarketSummary(listings) {
    if (!listings.length) {
      return { count: 0, lowest: null, average: null, median: null };
    }

    const prices = listings.map((l) => l.price).sort((a, b) => a - b);
    const sum = prices.reduce((acc, p) => acc + p, 0);
    const mid = Math.floor(prices.length / 2);

    return {
      count: prices.length,
      lowest: prices[0],
      highest: prices[prices.length - 1],
      average: parseFloat((sum / prices.length).toFixed(2)),
      median:
        prices.length % 2 === 0
          ? parseFloat(((prices[mid - 1] + prices[mid]) / 2).toFixed(2))
          : prices[mid],
    };
  }

  buildSearchQuery(cardData) {
    const { grader, grade, cardName, set, cardNumber } = cardData;

    // eBay searches better with grader+grade first, then card identity
    const parts = [];

    if (grader && grade) parts.push(`${grader} ${grade}`);
    if (cardName) parts.push(cardName);
    if (set) parts.push(set);
    if (cardNumber) parts.push(cardNumber);

    return parts.join(" ");
  }
}

module.exports = new EbayPricingService();
