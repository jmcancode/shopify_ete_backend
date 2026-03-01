"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// services/broadcast.service.js
//
// Architecture: Mobile → WHIP (WebRTC HTTP Ingest) → Mux directly.
//
// Server role:
//   1. Auth gate (verify Firebase admin token via Socket.io middleware)
//   2. Broker the Mux WHIP endpoint URL to the mobile client
//   3. Manage Firestore lifecycle (live → ended) and heartbeat
//
// Why WHIP instead of FFmpeg relay:
//   The old approach opened raw UDP RTP ports and spawned FFmpeg to relay
//   media to Mux. The mobile client sent WebRTC SDP offers over the socket,
//   but the server never handled them — FFmpeg received no data and the
//   stream was permanently stuck in "idle".
//
//   Mux natively supports WHIP. The mobile client POSTs its WebRTC SDP
//   offer directly to Mux's WHIP endpoint. No server-side media handling.
// ─────────────────────────────────────────────────────────────────────────────

const { Server } = require("socket.io");
const admin = require("firebase-admin");

// socketId → { breakId, startedAt }
const activeSessions = new Map();

function initBroadcast(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: "*" },
    path: "/broadcast",
    transports: ["websocket", "polling"],
  });

  // ── Auth middleware ──────────────────────────────────────────────────────
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("AUTH_REQUIRED"));

    try {
      const decoded = await admin.auth().verifyIdToken(token);
      const userSnap = await admin
        .firestore()
        .collection("users")
        .doc(decoded.uid)
        .get();

      if (!userSnap.exists || userSnap.data()?.roles?.isAdmin !== true) {
        return next(new Error("ADMIN_REQUIRED"));
      }

      socket.uid = decoded.uid;
      next();
    } catch {
      next(new Error("INVALID_TOKEN"));
    }
  });

  // ── Connection handler ───────────────────────────────────────────────────
  io.on("connection", (socket) => {
    console.log(
      `[Broadcast] ✅ Admin connected  socket=${socket.id}  uid=${socket.uid}`,
    );

    // ── EVENT: go_live ───────────────────────────────────────────────────
    // Payload: { breakId, streamKey }
    // Response: emits whip_ready → { breakId, whipEndpoint }
    // Mobile client POSTs its WebRTC SDP offer to whipEndpoint directly.
    socket.on("go_live", async (payload) => {
      console.log(
        `[Broadcast] go_live  socket=${socket.id}  breakId=${payload?.breakId}  hasKey=${!!payload?.streamKey}`,
      );

      const { breakId, streamKey } = payload ?? {};

      if (!breakId || !streamKey) {
        console.warn(
          `[Broadcast] ⚠️  Missing params  breakId=${breakId}  streamKey=${!!streamKey}`,
        );
        return socket.emit("broadcast_error", {
          code: "MISSING_PARAMS",
          detail: !breakId ? "breakId required" : "streamKey required",
        });
      }

      if (activeSessions.has(socket.id)) {
        return socket.emit("broadcast_error", { code: "ALREADY_LIVE" });
      }

      activeSessions.set(socket.id, { breakId, startedAt: Date.now() });

      // Mux WHIP ingest endpoint — mobile client sends SDP offer here directly
      const whipEndpoint = `https://global-live.mux.com/app/${streamKey}/whip`;

      // Update Firestore
      try {
        await admin.firestore().collection("liveBreaks").doc(breakId).update({
          status: "live",
          startedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`[Broadcast] Firestore → live  break=${breakId}`);
      } catch (e) {
        console.error("[Broadcast] Firestore update error:", e.message);
      }

      socket.emit("whip_ready", { breakId, whipEndpoint });
      console.log(`[Broadcast] 📡 WHIP ready  break=${breakId}`);
    });

    // ── EVENT: stream_confirmed ───────────────────────────────────────────
    // Mobile emits once WHIP SDP exchange with Mux is complete.
    // Server responds with live_started to trigger the live UI state.
    socket.on("stream_confirmed", async ({ breakId }) => {
      console.log(`[Broadcast] ✅ Stream confirmed  break=${breakId}`);
      socket.emit("live_started", { breakId });
    });

    // ── EVENT: end_stream ────────────────────────────────────────────────
    socket.on("end_stream", () => killSession(socket, "manual"));

    // ── EVENT: heartbeat ─────────────────────────────────────────────────
    // Sent every ~10s from mobile to keep viewerCount fresh in Firestore.
    socket.on("heartbeat", async ({ breakId, viewerCount = 0 }) => {
      if (!breakId) return;
      try {
        await admin.firestore().collection("liveBreaks").doc(breakId).update({
          viewerCount,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch {
        /* non-fatal */
      }
    });

    // ── Disconnect ────────────────────────────────────────────────────────
    socket.on("disconnect", (reason) => {
      console.log(
        `[Broadcast] Disconnected  socket=${socket.id}  reason=${reason}`,
      );
      killSession(socket, reason);
    });

    // Catch unknown events — helps surface event name mismatches from mobile
    socket.onAny((event) => {
      const known = [
        "go_live",
        "end_stream",
        "heartbeat",
        "stream_confirmed",
        "disconnect",
      ];
      if (!known.includes(event)) {
        console.log(
          `[Broadcast] ⚠️  Unknown event="${event}"  socket=${socket.id}`,
        );
      }
    });
  });

  // ── Kill session helper ──────────────────────────────────────────────────
  async function killSession(socket, reason) {
    const session = activeSessions.get(socket.id);
    if (!session) return;

    const { breakId } = session;
    activeSessions.delete(socket.id);

    if (breakId) {
      try {
        await admin.firestore().collection("liveBreaks").doc(breakId).update({
          status: "ended",
          endedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) {
        console.error("[Broadcast] Firestore end-stream error:", e.message);
      }
    }

    socket.emit("stream_ended", { breakId, reason });
    console.log(
      `[Broadcast] ⏹  Stream ended  break=${breakId}  reason=${reason}`,
    );
  }

  console.log("[Broadcast] Socket.io server ready on path /broadcast");
  return io;
}

module.exports = { initBroadcast };
