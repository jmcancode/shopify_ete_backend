"use strict";

// routes/Broadcast.routes.js
// Thin re-export — all logic lives in services/broadcast.service.js
const { initBroadcast } = require("../services/broadcast.service");

module.exports = { initBroadcast };
