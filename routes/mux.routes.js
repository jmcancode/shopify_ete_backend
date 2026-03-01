const express = require("express");
const admin = require("firebase-admin");

module.exports = function (verifyToken, verifyAdmin) {
  const router = express.Router();

  // Lazy Mux client — instantiated on first use so env vars are loaded
  let _mux = null;
  function getMux() {
    if (!_mux) {
      const Mux = require("@mux/mux-node");
      _mux = new Mux({
        tokenId: process.env.MUX_TOKEN_ID,
        tokenSecret: process.env.MUX_TOKEN_SECRET,
      });
    }
    return _mux;
  }

  // Lazy db — Firebase guaranteed initialized by index.js before any route fires
  function getDb() {
    return admin.firestore();
  }

  // ─── POST /api/mux/streams ──────────────────────────────────────────────────
  // Create a Mux live stream + Firestore liveBreaks document.
  // Body: { title, description? }
  router.post("/streams", verifyToken, verifyAdmin, async (req, res) => {
    const { title, description = "" } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: "title is required" });
    }

    try {
      const mux = getMux();
      const db = getDb();

      const liveStream = await mux.video.liveStreams.create({
        playback_policy: ["public"],
        new_asset_settings: { playback_policies: ["public"] },
        latency_mode: "reduced",
      });

      const playbackId = liveStream.playback_ids?.[0]?.id;
      const streamKey = liveStream.stream_key;
      const streamId = liveStream.id;

      if (!playbackId || !streamKey) {
        throw new Error(
          "Mux did not return expected playback ID or stream key",
        );
      }

      const breakRef = await db.collection("liveBreaks").add({
        title: title.trim(),
        description,
        status: "idle",
        muxLiveStreamId: streamId,
        muxPlaybackId: playbackId,
        viewerCount: 0,
        featuredProducts: [],
        scheduledAt: null,
        startedAt: null,
        endedAt: null,
        createdBy: req.user.uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Store stream key separately — never exposed to app clients
      await db.collection("muxStreamKeys").doc(breakRef.id).set({
        breakId: breakRef.id,
        muxLiveStreamId: streamId,
        streamKey,
        rtmpUrl: "rtmps://global-live.mux.com:443/app",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.json({
        success: true,
        breakId: breakRef.id,
        muxLiveStreamId: streamId,
        muxPlaybackId: playbackId,
        streamKey,
        rtmpUrl: "rtmps://global-live.mux.com:443/app",
      });
    } catch (err) {
      console.error("[Mux] Create stream error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/mux/streams ───────────────────────────────────────────────────
  // List all live breaks with Mux encoder status.
  router.get("/streams", verifyToken, verifyAdmin, async (req, res) => {
    try {
      const mux = getMux();
      const db = getDb();

      const [breaksSnap, muxStreamsRes] = await Promise.all([
        db
          .collection("liveBreaks")
          .orderBy("createdAt", "desc")
          .limit(20)
          .get(),
        mux.video.liveStreams.list(),
      ]);

      const muxStatusMap = {};
      for (const s of muxStreamsRes.data ?? []) {
        muxStatusMap[s.id] = s.status;
      }

      const breaks = breaksSnap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          title: data.title,
          description: data.description,
          status: data.status,
          muxLiveStreamId: data.muxLiveStreamId,
          muxPlaybackId: data.muxPlaybackId,
          muxStatus: muxStatusMap[data.muxLiveStreamId] ?? "unknown",
          viewerCount: data.viewerCount ?? 0,
          featuredProducts: data.featuredProducts ?? [],
          scheduledAt: data.scheduledAt?.toDate?.() ?? null,
          startedAt: data.startedAt?.toDate?.() ?? null,
          endedAt: data.endedAt?.toDate?.() ?? null,
          createdAt: data.createdAt?.toDate?.() ?? null,
        };
      });

      res.json({ success: true, breaks });
    } catch (err) {
      console.error("[Mux] List streams error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/mux/streams/:breakId/key ─────────────────────────────────────
  // Get RTMP stream key for broadcast setup (OBS or in-app camera).
  router.get(
    "/streams/:breakId/key",
    verifyToken,
    verifyAdmin,
    async (req, res) => {
      try {
        const db = getDb();
        const keyDoc = await db
          .collection("muxStreamKeys")
          .doc(req.params.breakId)
          .get();

        if (!keyDoc.exists) {
          return res.status(404).json({ error: "Stream key not found" });
        }

        const { streamKey, rtmpUrl } = keyDoc.data();
        res.json({ success: true, streamKey, rtmpUrl });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── POST /api/mux/streams/:breakId/go-live ─────────────────────────────────
  router.post(
    "/streams/:breakId/go-live",
    verifyToken,
    verifyAdmin,
    async (req, res) => {
      try {
        const db = getDb();
        await db.collection("liveBreaks").doc(req.params.breakId).update({
          status: "live",
          startedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        res.json({ success: true, status: "live" });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── POST /api/mux/streams/:breakId/end ────────────────────────────────────
  router.post(
    "/streams/:breakId/end",
    verifyToken,
    verifyAdmin,
    async (req, res) => {
      try {
        const mux = getMux();
        const db = getDb();

        const breakDoc = await db
          .collection("liveBreaks")
          .doc(req.params.breakId)
          .get();
        if (!breakDoc.exists)
          return res.status(404).json({ error: "Break not found" });

        const { muxLiveStreamId } = breakDoc.data();

        if (muxLiveStreamId) {
          await mux.video.liveStreams.disable(muxLiveStreamId);
        }

        await db.collection("liveBreaks").doc(req.params.breakId).update({
          status: "ended",
          endedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        res.json({ success: true, status: "ended" });
      } catch (err) {
        console.error("[Mux] End stream error:", err);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── DELETE /api/mux/streams/:breakId ──────────────────────────────────────
  router.delete(
    "/streams/:breakId",
    verifyToken,
    verifyAdmin,
    async (req, res) => {
      try {
        const mux = getMux();
        const db = getDb();

        const breakDoc = await db
          .collection("liveBreaks")
          .doc(req.params.breakId)
          .get();
        if (!breakDoc.exists)
          return res.status(404).json({ error: "Break not found" });

        const { muxLiveStreamId, status } = breakDoc.data();

        if (status === "live") {
          return res
            .status(400)
            .json({ error: "Cannot delete an active stream. End it first." });
        }

        if (muxLiveStreamId) {
          await mux.video.liveStreams.delete(muxLiveStreamId);
        }

        const batch = db.batch();
        batch.delete(db.collection("liveBreaks").doc(req.params.breakId));
        batch.delete(db.collection("muxStreamKeys").doc(req.params.breakId));
        await batch.commit();

        res.json({ success: true });
      } catch (err) {
        console.error("[Mux] Delete stream error:", err);
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── GET /api/mux/streams/:breakId/analytics ───────────────────────────────
  router.get(
    "/streams/:breakId/analytics",
    verifyToken,
    verifyAdmin,
    async (req, res) => {
      try {
        const db = getDb();
        const breakDoc = await db
          .collection("liveBreaks")
          .doc(req.params.breakId)
          .get();
        if (!breakDoc.exists)
          return res.status(404).json({ error: "Break not found" });

        const { muxPlaybackId, title, startedAt, endedAt } = breakDoc.data();

        res.json({
          success: true,
          breakId: req.params.breakId,
          title,
          muxPlaybackId,
          thumbnailUrl: muxPlaybackId
            ? `https://image.mux.com/${muxPlaybackId}/thumbnail.png`
            : null,
          analyticsUrl: `https://dashboard.mux.com/data/views?filters[0]=video_id:${req.params.breakId}`,
          startedAt: startedAt?.toDate?.() ?? null,
          endedAt: endedAt?.toDate?.() ?? null,
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ─── POST /api/mux/webhooks ─────────────────────────────────────────────────
  // Register in Mux Dashboard → Settings → Webhooks
  // Events: video.live_stream.active, video.live_stream.idle
  router.post(
    "/webhooks",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      const webhookSecret = process.env.MUX_WEBHOOK_SECRET;

      if (webhookSecret) {
        try {
          getMux().webhooks.verifySignature(
            req.body,
            req.headers,
            webhookSecret,
          );
        } catch (e) {
          console.error("[Mux Webhook] Invalid signature");
          return res.status(401).json({ error: "Invalid signature" });
        }
      }

      let event;
      try {
        event = JSON.parse(req.body.toString());
      } catch {
        return res.status(400).json({ error: "Invalid JSON" });
      }

      const muxStreamId = event.data?.id;
      if (!muxStreamId) return res.sendStatus(200);

      try {
        const db = getDb();

        const breakQuery = await db
          .collection("liveBreaks")
          .where("muxLiveStreamId", "==", muxStreamId)
          .limit(1)
          .get();

        if (breakQuery.empty) return res.sendStatus(200);

        const breakDoc = breakQuery.docs[0];
        const breakId = breakDoc.id;
        const currentStatus = breakDoc.data()?.status;

        switch (event.type) {
          case "video.live_stream.active":
            await db.collection("liveBreaks").doc(breakId).update({
              status: "live",
              startedAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            console.log(`[Mux Webhook] ${breakId} → LIVE`);
            break;

          case "video.live_stream.idle":
            if (currentStatus === "live") {
              await db.collection("liveBreaks").doc(breakId).update({
                status: "idle",
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
              console.log(`[Mux Webhook] ${breakId} → IDLE`);
            }
            break;

          default:
            console.log(`[Mux Webhook] Unhandled: ${event.type}`);
        }

        res.sendStatus(200);
      } catch (err) {
        console.error("[Mux Webhook] Error:", err);
        res.status(500).json({ error: err.message });
      }
    },
  );

  return router;
};
