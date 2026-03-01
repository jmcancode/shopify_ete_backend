const shopifyAuthService = require("./shopify-auth.service");

// 5-minute in-memory cache
let cachedProducts = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

const SLIM_QUERY = `
  query GetProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      edges {
        cursor
        node {
          id
          title
          handle
          vendor
          productType
          tags
          featuredImage { url }
          variants(first: 1) {
            edges {
              node {
                id
                price { amount }
                compareAtPrice { amount }
                availableForSale
              }
            }
          }
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;

class ShopifyStorefrontService {
  /**
   * Fetch ALL products with auto-pagination, cached for 5 min.
   * Returns raw edges array.
   */
  async getAllProducts() {
    const now = Date.now();
    if (cachedProducts && now - cacheTimestamp < CACHE_TTL_MS) {
      return cachedProducts;
    }

    const allEdges = [];
    let cursor = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const response = await shopifyAuthService.storefrontRequest(SLIM_QUERY, {
        first: 250,
        after: cursor,
      });

      const products = response.data.products;
      allEdges.push(...products.edges);
      hasNextPage = products.pageInfo.hasNextPage;
      cursor =
        products.edges.length > 0
          ? products.edges[products.edges.length - 1].cursor
          : null;
    }

    cachedProducts = allEdges;
    cacheTimestamp = now;
    console.log(`✅ Cached ${allEdges.length} products`);
    return allEdges;
  }

  async getProducts(options = {}) {
    const { first = 20, after = null, query = null } = options;

    const graphqlQuery = `
      query GetProducts($first: Int!, $after: String, $query: String) {
        products(first: $first, after: $after, query: $query) {
          edges {
            cursor
            node {
              id title handle description vendor productType tags
              featuredImage { url altText }
              images(first: 10) { edges { node { url altText } } }
              variants(first: 10) {
                edges {
                  node {
                    id title
                    price { amount currencyCode }
                    compareAtPrice { amount currencyCode }
                    availableForSale
                    image { url }
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage hasPreviousPage }
        }
      }
    `;

    const data = await shopifyAuthService.storefrontRequest(graphqlQuery, {
      first,
      after,
      query,
    });

    return data.data;
  }

  async getProductByHandle(handle) {
    const graphqlQuery = `
    query GetProduct($handle: String!) {
      product(handle: $handle) {
        id title handle description vendor productType tags
        featuredImage { url }
        images(first: 10) { nodes { url } }
        variants(first: 10) {
          nodes {
            id title
            price { amount currencyCode }
            compareAtPrice { amount currencyCode }
            availableForSale
            image { url }
          }
        }
      }
    }
  `;

    const data = await shopifyAuthService.storefrontRequest(graphqlQuery, {
      handle,
    });

    if (!data.data?.product) return null;

    const product = data.data.product;

    return {
      id: product.id,
      title: product.title,
      handle: product.handle,
      description: product.description,
      vendor: product.vendor,
      productType: product.productType,
      tags: product.tags,
      featuredImage: product.featuredImage?.url || "",
      images: product.images.nodes.map((img) => img.url),
      variants: product.variants.nodes.map((node) => ({
        id: node.id,
        title: node.title,
        price: parseFloat(node.price.amount),
        compareAtPrice: node.compareAtPrice
          ? parseFloat(node.compareAtPrice.amount)
          : null,
        available: node.availableForSale,
        image: node.image?.url,
      })),
    };
  }

  async getCollections(first = 20) {
    const graphqlQuery = `
      query GetCollections($first: Int!) {
        collections(first: $first) {
          edges {
            node {
              id title handle description
              image { url }
            }
          }
        }
      }
    `;

    const data = await shopifyAuthService.storefrontRequest(graphqlQuery, {
      first,
    });
    return data.collections.edges.map((edge) => edge.node);
  }

  /**
   * createCheckout — uses cartCreate (checkoutCreate is deprecated).
   *
   * @param {Array}  lineItems   - [{ variantId, quantity }]
   * @param {string|null} buyerEmail - pre-fills Shopify checkout contact field.
   *                                   Pass null for guest checkout.
   */
  async createCheckout(lineItems, buyerEmail = null) {
    const graphqlQuery = `
      mutation cartCreate($input: CartInput!) {
        cartCreate(input: $input) {
          cart {
            id
            checkoutUrl
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const input = {
      lines: lineItems.map((item) => ({
        merchandiseId: item.variantId,
        quantity: item.quantity,
      })),
    };

    // Only attach buyerIdentity when we have a validated email string
    if (
      buyerEmail &&
      typeof buyerEmail === "string" &&
      buyerEmail.includes("@")
    ) {
      input.buyerIdentity = { email: buyerEmail };
    }

    const response = await shopifyAuthService.storefrontRequest(graphqlQuery, {
      input,
    });

    const cartCreate = response.data.cartCreate;

    if (cartCreate.userErrors && cartCreate.userErrors.length > 0) {
      throw new Error(cartCreate.userErrors[0].message);
    }

    return {
      checkoutId: cartCreate.cart.id,
      checkoutUrl: cartCreate.cart.checkoutUrl,
    };
  }
}

module.exports = new ShopifyStorefrontService();
