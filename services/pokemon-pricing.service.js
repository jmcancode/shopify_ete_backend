const axios = require("axios");

const BASE_URL = "https://www.pokemonpricetracker.com";

class PokemonPricingService {
  constructor() {
    this.apiKey = process.env.POKEMON_PRICE_TRACK_API_KEY;
    if (!this.apiKey) {
      console.warn("⚠️  POKEMON_PRICE_TRACK_API_KEY not set");
    } else {
      console.log("✅ Pokemon Pricing Service initialized");
    }
  }

  get headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  async getCardPrices(name, setId = null, number = null) {
    const params = {
      search: name,
      includeEbay: true,
      includeGraded: true,
      limit: 1,
    };

    if (setId) params.setId = setId;
    if (number) params.number = number;

    console.log("PPT request params:", JSON.stringify(params, null, 2));
    console.log("PPT API key:", this.apiKey?.substring(0, 15));

    try {
      const response = await axios.get(`${BASE_URL}/api/v2/cards`, {
        headers: this.headers,
        params,
      });

      console.log("PPT raw response:", JSON.stringify(response.data, null, 2));

      const cards = response.data?.data || response.data || [];
      const results = Array.isArray(cards) ? cards : [cards];

      if (!results.length) return null;

      return this.formatCardPricing(results[0]);
    } catch (error) {
      console.error("PPT status:", error.response?.status);
      console.error(
        "PPT full error:",
        JSON.stringify(error.response?.data, null, 2),
      );
      throw error;
    }
  }

  async parseTitle(title) {
    try {
      const response = await axios.post(
        `${BASE_URL}/api/v2/parse-title`,
        {
          title,
          options: {
            fuzzyMatching: true,
            maxSuggestions: 3,
            includeConfidence: true,
          },
        },
        { headers: this.headers },
      );

      return response.data;
    } catch (error) {
      console.error(
        "❌ Parse title error:",
        error.response?.data || error.message,
      );
      throw error;
    }
  }

  async getGradedMarketValue(
    cardName,
    grade = "psa10",
    setId = null,
    number = null,
  ) {
    const pricing = await this.getCardPrices(cardName, setId, number);

    console.log("PPT formatted pricing:", JSON.stringify(pricing, null, 2));

    if (!pricing) return null;

    const gradeKey = grade.toLowerCase().replace(/\s/g, "");
    const gradedPrice =
      pricing.gradedPrices?.[gradeKey] ||
      pricing.ebay?.grades?.[gradeKey] ||
      null;

    console.log("PPT gradeKey:", gradeKey, "gradedPrice:", gradedPrice);

    return {
      cardName: pricing.name,
      setName: pricing.setName,
      cardNumber: pricing.number,
      imageUrl: pricing.imageUrl,
      marketValue: gradedPrice,
      grade: grade.toUpperCase(),
      rawMarketPrice: pricing.tcgplayer?.market || null,
      lastUpdated: pricing.lastUpdated,
      source: "pokemonpricetracker",
    };
  }

  formatCardPricing(card) {
    const ebay = card.ebay?.salesByGrade || {};

    return {
      id: card.id,
      name: card.name,
      setName: card.setName,
      setId: card.setId,
      number: card.cardNumber,
      rarity: card.rarity,
      imageUrl: card.imageUrl,
      tcgplayer: {
        market: card.prices?.market || null,
        low: card.prices?.low || null,
      },
      ebay: {
        average: card.ebay?.totalValue || null,
      },
      gradedPrices: {
        psa10:
          ebay.psa10?.smartMarketPrice?.price ||
          ebay.psa10?.averagePrice ||
          null,
        psa9:
          ebay.psa9?.smartMarketPrice?.price || ebay.psa9?.averagePrice || null,
        psa8:
          ebay.psa8?.smartMarketPrice?.price || ebay.psa8?.averagePrice || null,
      },
      lastUpdated: card.ebay?.updatedAt || card.updatedAt || null,
    };
  }
}

module.exports = new PokemonPricingService();
