const shopifyAuthService = require("./shopify-auth.service");

class ShopifyCustomerService {
  /**
   * Create a new customer in Shopify
   */
  async createCustomer(userData) {
    const mutation = `
      mutation customerCreate($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer {
            id
            firstName
            lastName
            displayName
            defaultEmailAddress {
              emailAddress
            }
            phone
            tags
            numberOfOrders
            amountSpent {
              amount
              currencyCode
            }
            storeCreditAccounts(first: 5) {
              nodes {
                id
                balance {
                  amount
                  currencyCode
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      input: {
        email: userData.email,
        firstName: userData.firstName || "",
        lastName: userData.lastName || "",
        phone: userData.phone || "",
        tags: ["firebase-user"],
        emailMarketingConsent: {
          marketingState: userData.emailMarketing
            ? "SUBSCRIBED"
            : "UNSUBSCRIBED",
          marketingOptInLevel: userData.emailMarketing
            ? "SINGLE_OPT_IN"
            : "UNKNOWN",
        },
      },
    };

    const data = await shopifyAuthService.adminGraphQLRequest(
      mutation,
      variables,
    );

    if (data.customerCreate.userErrors.length > 0) {
      throw new Error(data.customerCreate.userErrors[0].message);
    }

    const customer = data.customerCreate.customer;
    console.log(
      "📦 Created Shopify customer:",
      JSON.stringify(customer, null, 2),
    );

    return this.normalizeCustomer(customer);
  }

  /**
   * Get customer by email
   */
  async getCustomerByEmail(email) {
    const query = `
      query CustomerByEmail($query: String!) {
        customers(first: 1, query: $query) {
          nodes {
            id
            firstName
            lastName
            displayName
            defaultEmailAddress {
              emailAddress
            }
            phone
            tags
            numberOfOrders
            amountSpent {
              amount
              currencyCode
            }
            storeCreditAccounts(first: 5) {
              nodes {
                id
                balance {
                  amount
                  currencyCode
                }
              }
            }
            createdAt
            updatedAt
          }
        }
      }
    `;

    const variables = {
      query: `email:${email}`,
    };

    const data = await shopifyAuthService.adminGraphQLRequest(query, variables);

    const nodes = data.customers?.nodes ?? [];
    if (nodes.length === 0) {
      console.log("🔍 No Shopify customer found for:", email);
      return null;
    }

    const customer = nodes[0];
    console.log(
      "🔍 Found Shopify customer:",
      JSON.stringify(customer, null, 2),
    );

    return this.normalizeCustomer(customer);
  }

  /**
   * Get customer by Shopify ID
   */
  async getCustomerById(shopifyCustomerId) {
    const query = `
      query getCustomer($id: ID!) {
        customer(id: $id) {
          id
          firstName
          lastName
          displayName
          defaultEmailAddress {
            emailAddress
          }
          phone
          tags
          numberOfOrders
          amountSpent {
            amount
            currencyCode
          }
          storeCreditAccounts(first: 5) {
            nodes {
              id
              balance {
                amount
                currencyCode
              }
            }
          }
          createdAt
          updatedAt
          addresses {
            id
            address1
            address2
            city
            province
            country
            zip
            phone
          }
          orders(first: 10) {
            edges {
              node {
                id
                name
                createdAt
                totalPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
    `;

    const variables = { id: shopifyCustomerId };
    const data = await shopifyAuthService.adminGraphQLRequest(query, variables);

    if (!data.customer) {
      console.log("🔍 No Shopify customer found for ID:", shopifyCustomerId);
      return null;
    }

    console.log(
      "🔍 Shopify customer by ID:",
      JSON.stringify(data.customer, null, 2),
    );

    return this.normalizeCustomer(data.customer);
  }

  /**
   * Update customer in Shopify
   */
  async updateCustomer(shopifyCustomerId, updates) {
    const mutation = `
      mutation customerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer {
            id
            firstName
            lastName
            displayName
            defaultEmailAddress {
              emailAddress
            }
            phone
            tags
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      input: {
        id: shopifyCustomerId,
        ...updates,
      },
    };

    const data = await shopifyAuthService.adminGraphQLRequest(
      mutation,
      variables,
    );

    if (data.customerUpdate.userErrors.length > 0) {
      throw new Error(data.customerUpdate.userErrors[0].message);
    }

    return this.normalizeCustomer(data.customerUpdate.customer);
  }

  /**
   * Sync Firebase user with Shopify customer
   * Creates customer if doesn't exist, returns existing if found
   */
  async syncCustomer(firebaseUserData) {
    try {
      let shopifyCustomer = await this.getCustomerByEmail(
        firebaseUserData.email,
      );

      let isNew = false;

      if (!shopifyCustomer) {
        console.log(
          "📝 Creating new Shopify customer for:",
          firebaseUserData.email,
        );
        shopifyCustomer = await this.createCustomer(firebaseUserData);
        isNew = true;
      } else {
        console.log(
          "✅ Shopify customer already exists:",
          firebaseUserData.email,
        );
      }

      const lifetimeSpend = parseFloat(
        shopifyCustomer.amountSpent?.amount || "0",
      );

      const result = {
        isNew,
        shopifyCustomerId: shopifyCustomer.id,
        email: shopifyCustomer.email,
        firstName: shopifyCustomer.firstName,
        lastName: shopifyCustomer.lastName,
        displayName: shopifyCustomer.displayName,
        numberOfOrders: shopifyCustomer.numberOfOrders,
        amountSpent: shopifyCustomer.amountSpent,
        storeCredit: shopifyCustomer.storeCredit,
        tags: shopifyCustomer.tags,
        createdAt: shopifyCustomer.createdAt,
      };

      console.log("🔗 Sync result:", JSON.stringify(result, null, 2));

      return result;
    } catch (error) {
      console.error("❌ Error syncing customer:", error);
      throw error;
    }
  }

  /**
   * Normalize customer data from different query shapes
   */
  normalizeCustomer(customer) {
    if (!customer) return null;

    // Sum all store credit account balances
    const storeCreditBalance = (
      customer.storeCreditAccounts?.nodes || []
    ).reduce((total, account) => {
      return total + parseFloat(account.balance?.amount || "0");
    }, 0);

    return {
      id: customer.id,
      email: customer.defaultEmailAddress?.emailAddress || customer.email || "",
      firstName: customer.firstName || "",
      lastName: customer.lastName || "",
      displayName: customer.displayName || "",
      phone: customer.phone || "",
      tags: customer.tags || [],
      numberOfOrders: customer.numberOfOrders || 0,
      amountSpent: customer.amountSpent || {
        amount: "0.00",
        currencyCode: "USD",
      },
      storeCredit: storeCreditBalance,
      createdAt: customer.createdAt || null,
      updatedAt: customer.updatedAt || null,
      addresses: customer.addresses || [],
      orders: customer.orders?.edges?.map((e) => e.node) || [],
    };
  }
}

module.exports = new ShopifyCustomerService();
