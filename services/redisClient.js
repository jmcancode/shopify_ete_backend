const { createClient } = require("redis");

const redis = createClient({
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD,
  socket: {
    host: process.env.REDIS_HOST || "localhost",
    port: Number(process.env.REDIS_PORT || 1313),
  },
});

redis.on("error", (err) => {
  console.error("❌ Redis Client Error:", err);
});

redis.on("connect", () => {
  console.log("🔄 Redis connecting...");
});

redis.on("ready", () => {
  console.log("✔️  Redis ready");
});

let initPromise = null;

async function init() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!redis.isOpen) {
      await redis.connect();
      console.log("✔️  Redis connected");
    }
  })();

  return initPromise;
}

// Start initialization immediately
init().catch((err) => {
  console.error("❌ Redis initialization failed:", err);
});

// Helper to ensure Redis is ready
async function ensureConnected() {
  await init();
  if (!redis.isOpen) {
    throw new Error("Redis is not connected");
  }
}

// Optional helpers
const redisGet = async (key) => {
  try {
    await ensureConnected();
    return await redis.get(key);
  } catch (err) {
    console.error("❌ redisGet failed:", err);
    return null;
  }
};

const redisSet = async (key, value, ttl = 86400) => {
  try {
    await ensureConnected();
    await redis.set(key, value, { EX: ttl });
  } catch (err) {
    console.error("❌ redisSet failed:", err);
  }
};

module.exports = {
  redis,
  redisGet,
  redisSet,
  init,
  ensureConnected,
};
