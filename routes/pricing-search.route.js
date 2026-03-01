const express = require("express");
const router = express.Router();
const scrydexService = require("../services/scrydex.service");

/**
 * GET /api/pricing/search
 *
 * Three improvements over the previous version:
 *
 * 1. QUERY CLEANING
 *    parseQuery() now handles ALL card number formats before sending to Scrydex:
 *      GG28/GG70  TG18/TG30  060/172  #060  079  gg28
 *    The number is stripped from the name so Scrydex never sees it.
 *    Previously only numeric formats (079/073) were caught — GG28 slipped
 *    through and Scrydex mangled it into name:"Duskull GG/GG".
 *
 * 2. SCORING PICKER
 *    scoreResult() now gives card number match the highest weight (+60),
 *    so the correct print always floats to position 1 regardless of how
 *    many variants Scrydex returns.
 *
 * 3. FALLBACK QUERY CHAIN
 *    If Scrydex returns 0 card results for the full name, we automatically
 *    retry with the first word only (e.g. "Duskull" → "Dusk").
 *    This ensures something always comes back even on partial OCR reads.
 *
 * 4. scrydexId PASSTHROUGH
 *    Every result already includes scrydexId. The frontend passes this to
 *    POST /api/pricing/market-value as localCardId, which bypasses the
 *    Scrydex name search entirely and goes straight to the correct card.
 */

// ─── Number formats we understand ─────────────────────────────────────────────
//  GG28/GG70  → gallery / special set numbers
//  TG18/TG30  → trainer gallery
//  060/172    → standard set numbers
//  #060       → hash-prefixed
//  SV123      → promo style
const CARD_NUM_REGEX = /\b([A-Z]{0,3}\d{1,3}(?:\/[A-Z]{0,3}\d{1,3})?)\b/gi;

// ─── Query Parser ─────────────────────────────────────────────────────────────

/**
 * parseQuery — strips card numbers from the raw query so they never
 * reach Scrydex (which mangles them), and returns them separately for
 * use in scoreResult().
 *
 * "Duskull GG28/GG70" → { namePart: "Duskull", numbers: ["GG28", "GG70", "GG28/GG70"] }
 * "Pikachu 060/172"   → { namePart: "Pikachu", numbers: ["060", "172", "060/172"] }
 * "Charizard"         → { namePart: "Charizard", numbers: [] }
 */
function parseQuery(raw) {
  const numbers = [];
  let cleaned = raw.replace(/#/g, " "); // strip hash prefixes

  const matches = [...cleaned.matchAll(CARD_NUM_REGEX)];

  for (const match of matches) {
    const token = match[1];
    numbers.push(token.toUpperCase());

    // Also push individual sides of a slash number: GG28/GG70 → ["GG28","GG70"]
    if (token.includes("/")) {
      const [left, right] = token.split("/");
      numbers.push(left.toUpperCase());
      numbers.push(right.toUpperCase());
    }

    cleaned = cleaned.replace(match[0], " ");
  }

  const namePart = cleaned.replace(/\s{2,}/g, " ").trim() || raw.trim();

  return { namePart, numbers: [...new Set(numbers)] };
}

// ─── Relevance Scoring ────────────────────────────────────────────────────────

/**
 * scoreResult — returns 0-200 score for a Scrydex result.
 *
 * Card number match is the highest signal (+60) — if the user typed
 * GG28 and this card is GG28/GG70, it wins over all other Duskulls.
 *
 * Scoring breakdown:
 *   Exact name match           → +100
 *   Name starts with query     → +80
 *   Name contains query        → +60
 *   Partial word overlap       → up to +40
 *   Exact card number match    → +60
 *   Left-side number match     → +30
 */
function scoreResult(item, namePart, numbers) {
  const name = (item.name ?? "").toLowerCase().trim();
  const q = namePart.toLowerCase().trim();
  const rawNum = (item.printed_number ?? "").replace(/^#/, "").toUpperCase();

  let score = 0;

  // ── Name scoring ────────────────────────────────────────────────────────────
  if (name === q) score += 100;
  else if (name.startsWith(q)) score += 80;
  else if (name.includes(q)) score += 60;
  else {
    const words = q.split(/\s+/).filter((w) => w.length > 1);
    const matched = words.filter((w) => name.includes(w)).length;
    if (words.length) score += Math.round((matched / words.length) * 40);
  }

  // ── Number scoring ──────────────────────────────────────────────────────────
  if (numbers.length > 0 && rawNum) {
    // Normalize: strip leading zeros from each segment
    const norm = (s) =>
      s
        .split("/")
        .map((p) => p.replace(/^0+/, "") || "0")
        .join("/");
    const cardNorm = norm(rawNum);

    for (const n of numbers) {
      const qNorm = norm(n);

      // Exact match: "GG28/GG70" === "GG28/GG70"
      if (cardNorm === qNorm) {
        score += 60;
        break;
      }

      // Left-side match: card is "GG28/GG70", query number is "GG28"
      if (cardNorm.startsWith(qNorm + "/")) {
        score += 30;
        break;
      }

      // Right-side match: card is "GG28/GG70", query number is "GG70"
      const cardRight = cardNorm.split("/")[1];
      if (cardRight && cardRight === qNorm) {
        score += 20;
        break;
      }
    }
  }

  return score;
}

// ─── Scrydex card search with fallback chain ──────────────────────────────────

/**
 * searchCardsWithFallback — tries progressively broader queries until
 * we get results. Broader is always better — something beats nothing.
 *
 * Chain:
 *   1. Full name:        "Duskull"        (exact as typed)
 *   2. First word only:  "Dusk"           (handles OCR truncation)
 *   3. Four chars:       "Dusk"           (already covered above usually)
 *
 * Returns { cards, usedFallback }
 */
async function searchCardsWithFallback(namePart) {
  // Attempt 1 — full name
  const res1 = await scrydexService.searchCards(namePart, false, 20);
  const cards1 = res1?.data ?? [];
  if (cards1.length > 0) return { cards: cards1, usedFallback: false };

  console.log(`⚠️  No results for "${namePart}" — trying first word fallback`);

  // Attempt 2 — first word only
  const firstWord = namePart.split(/\s+/)[0];
  if (firstWord && firstWord !== namePart && firstWord.length >= 3) {
    const res2 = await scrydexService.searchCards(firstWord, false, 20);
    const cards2 = res2?.data ?? [];
    if (cards2.length > 0) {
      console.log(
        `✅ Fallback returned ${cards2.length} results for "${firstWord}"`,
      );
      return { cards: cards2, usedFallback: true };
    }
  }

  // Attempt 3 — first 4 chars (handles "Duskull" → "Dusk" style OCR clips)
  if (namePart.length > 5) {
    const prefix = namePart.slice(0, 4);
    const res3 = await scrydexService.searchCards(prefix, false, 20);
    const cards3 = res3?.data ?? [];
    if (cards3.length > 0) {
      console.log(
        `✅ Prefix fallback returned ${cards3.length} results for "${prefix}"`,
      );
      return { cards: cards3, usedFallback: true };
    }
  }

  return { cards: [], usedFallback: false };
}

// ─── GET /api/pricing/search ──────────────────────────────────────────────────

router.get("/search", async (req, res) => {
  const rawQuery = req.query.q?.trim();
  const limit = Math.min(parseInt(req.query.limit ?? "20", 10), 50);

  if (!rawQuery || rawQuery.length < 2) {
    return res.status(400).json({
      success: false,
      message: "q param required (min 2 chars)",
    });
  }

  const { namePart, numbers } = parseQuery(rawQuery);

  console.log(
    `🔍 Search: "${rawQuery}" → name: "${namePart}", numbers: [${numbers.join(", ")}]`,
  );

  try {
    // Fire card search (with fallback) and sealed search in parallel
    const [{ cards, usedFallback }, sealedRes] = await Promise.all([
      searchCardsWithFallback(namePart),
      scrydexService
        .searchSealed({
          q:
            namePart.split(/\s+/).length > 1
              ? `name:"${namePart}"`
              : `name:${namePart}*`,
          page_size: 20,
          includePrices: false,
        })
        .catch(() => ({ data: [] })), // sealed failures are non-fatal
    ]);

    const results = [];

    // ── Cards ────────────────────────────────────────────────────────────────
    for (const card of cards) {
      const image =
        card.images?.find((i) => i.type === "front")?.medium ??
        card.images?.[0]?.medium ??
        null;

      results.push({
        id: card.id,
        type: "card",
        name: card.name ?? "Unknown Card",
        subtitle: card.expansion?.name ?? null,
        detail: card.printed_number ? `#${card.printed_number}` : null,
        rarity: card.rarity ?? null,
        imageUrl: image,
        scrydexId: card.id, // ← passed to market-value as localCardId
        score: scoreResult(
          { name: card.name, printed_number: card.printed_number },
          namePart,
          numbers,
        ),
      });
    }

    // ── Sealed ───────────────────────────────────────────────────────────────
    const sealed = sealedRes?.data ?? [];
    for (const product of sealed) {
      const image =
        product.images?.find((i) => i.type === "front")?.medium ??
        product.images?.[0]?.medium ??
        null;

      results.push({
        id: product.id,
        type: "sealed",
        name: product.name ?? "Unknown Product",
        subtitle: product.expansion?.name ?? null,
        detail: product.type ?? null,
        rarity: null,
        imageUrl: image,
        scrydexId: product.id,
        score: scoreResult({ name: product.name }, namePart, numbers),
      });
    }

    // Sort by score desc, alphabetical as tiebreak
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (a.name ?? "").localeCompare(b.name ?? "");
    });

    return res.json({
      success: true,
      data: {
        results: results.slice(0, limit),
        total: results.length,
        query: rawQuery,
        usedFallback, // lets frontend optionally show "showing results for X instead"
      },
    });
  } catch (err) {
    console.error("❌ /api/pricing/search error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
