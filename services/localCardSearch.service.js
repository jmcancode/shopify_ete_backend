"use strict";

/**
 * services/localCardSearch.service.js
 *
 * Self-contained — loads its own in-memory index from the same JSON files.
 * No dependency on localCards.service to avoid require() issues.
 *
 * Card number strategy:
 *   When a card number is present in the query (e.g. "Duskull GG28"),
 *   parseQuery() extracts it and passes it to resolvers.
 *
 *   Instead of hard-filtering (which returns 0 results if the number
 *   format doesn't match exactly), we RANK by number match:
 *     - Exact number match  → score +100 (floats to top)
 *     - Partial/prefix match → score +50
 *     - No match            → score 0 (still returned, ranked below)
 *
 *   This means "Duskull GG28" always returns the GG28/GG70 card first,
 *   with remaining Duskull cards below — broader is better.
 */

const fs = require("fs");
const path = require("path");

const CARDS_DIR = path.resolve(__dirname, "../data/cards/en");
const SETS_FILE = path.resolve(__dirname, "../data/sets/en.json");

// ─── In-memory index ──────────────────────────────────────────────────────────

let _sets = null; // Set[]
let _cardIndex = null; // Map<lowerName, card[]>
let _loaded = false;

function ensureLoaded() {
  if (_loaded) return;
  _sets = loadSets();
  _cardIndex = loadCardIndex(_sets);
  _loaded = true;
}

function loadSets() {
  if (!fs.existsSync(SETS_FILE)) return [];
  try {
    const raw = fs.readFileSync(SETS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : (parsed.data ?? []);
  } catch {
    return [];
  }
}

function loadCardIndex(sets) {
  const index = new Map(); // lowerName → card[]
  const setMap = new Map(sets.map((s) => [s.id, s]));

  if (!fs.existsSync(CARDS_DIR)) return index;

  for (const file of fs
    .readdirSync(CARDS_DIR)
    .filter((f) => f.endsWith(".json"))) {
    const setId = path.basename(file, ".json");
    const setMeta = setMap.get(setId) ?? null;
    try {
      const raw = fs.readFileSync(path.join(CARDS_DIR, file), "utf8");
      const list = (() => {
        const p = JSON.parse(raw);
        return Array.isArray(p) ? p : (p.data ?? []);
      })();
      for (const card of list) {
        if (!card.id || !card.name) continue;
        if (!card.set) {
          card.set = setMeta
            ? {
                id: setMeta.id,
                name: setMeta.name,
                series: setMeta.series ?? null,
              }
            : { id: setId, name: setId, series: null };
        }
        const key = card.name.toLowerCase().trim();
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(card);
      }
    } catch {
      /* skip bad file */
    }
  }
  console.log(`[LocalSearch] Indexed ${index.size} unique card names`);
  return index;
}

// ─── Core search ─────────────────────────────────────────────────────────────

function searchCards(query, limit = 50) {
  ensureLoaded();
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const results = [];
  for (const [name, cards] of _cardIndex) {
    if (name.includes(q)) {
      for (const card of cards) {
        results.push(card);
        if (results.length >= limit) return results;
      }
    }
  }
  return results;
}

function getSets() {
  ensureLoaded();
  return _sets;
}

// ─── Normalizers ──────────────────────────────────────────────────────────────

function normalizeSetCode(input) {
  return input.toLowerCase().replace(/^([a-z]+)0*(\d+)(.*)$/, "$1$2$3");
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ─── Number scoring (replaces hard filter) ────────────────────────────────────

/**
 * scoreByNumber — returns a numeric score for how well a card's number
 * matches the query number. Higher = better match. 0 = no match.
 *
 * Normalizes both sides: strips leading zeros, lowercases.
 *   "GG28" matches "GG28/GG70" → 100
 *   "060"  matches "060/172"   → 100
 *   "GG"   partial prefix      → 50
 *   no match                   → 0
 */
function scoreByNumber(card, queryNumber) {
  if (!queryNumber) return 0;

  const cardNum = (card.number || "").toLowerCase();
  const queryNum = queryNumber.replace(/^0+/, "").toLowerCase();

  if (!cardNum) return 0;

  // Normalize card number — strip leading zeros from numeric portion
  const cardNormalized = cardNum.replace(/^0+/, "");

  // Exact match: "gg28" === "gg28" or "gg28/gg70".startsWith("gg28")
  if (cardNormalized === queryNum) return 100;
  if (cardNormalized.startsWith(queryNum + "/")) return 100;
  if (cardNormalized.startsWith(queryNum)) return 50;

  return 0;
}

/**
 * rankByNumber — sorts candidates so number-matching cards float to top.
 * Cards with no number match are still returned (broader is better),
 * just ranked below matching ones.
 */
function rankByNumber(cards, cardNumber) {
  if (!cardNumber) return cards;
  return [...cards].sort(
    (a, b) => scoreByNumber(b, cardNumber) - scoreByNumber(a, cardNumber),
  );
}

// ─── Query Parser ─────────────────────────────────────────────────────────────

const CARD_NUMBER_REGEX =
  /\b(\d{1,3}\/[a-zA-Z0-9]{1,6}|[A-Z]{1,3}\d{2,3}|\d{3})\b/;

function parseQuery(rawQuery) {
  let remaining = rawQuery.trim();
  let cardNumber = null;

  const numMatch = remaining.match(CARD_NUMBER_REGEX);
  if (numMatch) {
    cardNumber = numMatch[1];
    remaining = remaining
      .replace(numMatch[0], "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  const sets = getSets();

  // Single token — set code?
  if (remaining && !remaining.includes(" ")) {
    const normalized = normalizeSetCode(remaining);
    const setByCode = sets.find(
      (s) =>
        s.id.toLowerCase() === normalized ||
        (s.ptcgoCode && s.ptcgoCode.toLowerCase() === remaining.toLowerCase()),
    );
    if (setByCode) {
      return cardNumber
        ? { type: "card_in_set", set: setByCode, cardName: null, cardNumber }
        : {
            type: "set_only",
            set: setByCode,
            cardName: null,
            cardNumber: null,
          };
    }
  }

  // Try matching trailing words to a set name
  const words = remaining.split(/\s+/).filter(Boolean);
  let matchedSet = null;
  let matchedLength = 0;

  for (let len = words.length; len >= 1; len--) {
    const candidate = words.slice(words.length - len).join(" ");
    const found = sets.find(
      (s) =>
        s.name.toLowerCase() === candidate.toLowerCase() ||
        slugify(s.name) === slugify(candidate),
    );
    if (found) {
      matchedSet = found;
      matchedLength = len;
      break;
    }
  }

  // Inline set code token
  if (!matchedSet) {
    for (let i = 0; i < words.length; i++) {
      const found = sets.find(
        (s) => s.id.toLowerCase() === normalizeSetCode(words[i]),
      );
      if (found) {
        const cn =
          [...words.slice(0, i), ...words.slice(i + 1)].join(" ").trim() ||
          null;
        return cn || cardNumber
          ? { type: "card_in_set", set: found, cardName: cn, cardNumber }
          : { type: "set_only", set: found, cardName: null, cardNumber: null };
      }
    }
  }

  const cardNameWords = matchedSet
    ? words.slice(0, words.length - matchedLength)
    : words;
  const cardName = cardNameWords.join(" ").trim() || null;

  if (matchedSet && !cardName && !cardNumber)
    return {
      type: "set_only",
      set: matchedSet,
      cardName: null,
      cardNumber: null,
    };
  if (matchedSet)
    return { type: "card_in_set", set: matchedSet, cardName, cardNumber };
  return {
    type: "card_global",
    set: null,
    cardName: cardName || remaining,
    cardNumber,
  };
}

// ─── Enrichment ───────────────────────────────────────────────────────────────

function enrichCard(card, set) {
  return {
    ...card,
    setId: set.id,
    setName: set.name,
    series: set.series || card.set?.series || null,
    ptcgoCode: set.ptcgoCode || null,
    setImages: set.images || null,
    releaseDate: set.releaseDate || null,
  };
}

// ─── Set card loader ──────────────────────────────────────────────────────────

function getSetCards(set, limit = 60) {
  const filePath = path.resolve(__dirname, `../data/cards/en/${set.id}.json`);
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const list = (() => {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : (p.data ?? []);
    })();
    return list.slice(0, limit).map((card) => enrichCard(card, set));
  } catch {
    return [];
  }
}

// ─── Resolvers ────────────────────────────────────────────────────────────────

function resolveCardInSet(set, cardName, cardNumber, limit = 20) {
  let candidates = searchCards(cardName || set.id, 50).filter(
    (c) => (c.set?.id || "") === set.id,
  );
  // Rank by number — exact matches float to top, rest follow
  candidates = rankByNumber(candidates, cardNumber);
  return candidates.slice(0, limit).map((c) => enrichCard(c, set));
}

function resolveCardGlobal(cardName, cardNumber, limit = 20) {
  const sets = getSets();
  let candidates = searchCards(cardName || "", 50);

  // Rank by number — exact matches float to top, rest follow
  candidates = rankByNumber(candidates, cardNumber);

  return candidates.slice(0, limit).map((card) => {
    const set = sets.find((s) => s.id === (card.set?.id || "")) || null;
    return set ? enrichCard(card, set) : card;
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

function localSearch(rawQuery) {
  if (!rawQuery?.trim()) {
    return {
      intent: "empty",
      primaryResults: [],
      setFallback: null,
      detectedSet: null,
      parsedCardName: null,
      parsedCardNumber: null,
      scrydexQuery: "",
    };
  }

  console.log(`[LocalSearch] "${rawQuery}"`);
  const { type, set, cardName, cardNumber } = parseQuery(rawQuery);
  console.log(
    `[LocalSearch] intent=${type} | set=${set?.id || "—"} | name="${cardName || ""}" | #${cardNumber || ""}`,
  );

  const scrydexQuery = cardName || (set ? set.name : rawQuery.trim());

  if (type === "set_only") {
    return {
      intent: "set_only",
      primaryResults: getSetCards(set),
      setFallback: null,
      detectedSet: set,
      parsedCardName: null,
      parsedCardNumber: null,
      scrydexQuery: set.name,
    };
  }

  if (type === "card_in_set") {
    const primary = resolveCardInSet(set, cardName, cardNumber);
    const fallback = primary.length === 0 ? getSetCards(set) : null;
    if (!primary.length)
      console.log(
        `[LocalSearch] No match in ${set.id} — returning set fallback`,
      );
    return {
      intent: "card_in_set",
      primaryResults: primary,
      setFallback: fallback,
      detectedSet: set,
      parsedCardName: cardName,
      parsedCardNumber: cardNumber,
      scrydexQuery,
    };
  }

  // card_global
  const primary = resolveCardGlobal(cardName, cardNumber);
  const topSet =
    primary.length > 0
      ? getSets().find((s) => s.id === primary[0].setId) || null
      : null;

  return {
    intent: "card_global",
    primaryResults: primary,
    setFallback: null,
    detectedSet: topSet,
    parsedCardName: cardName,
    parsedCardNumber: cardNumber,
    scrydexQuery,
  };
}

// Pre-load on startup
ensureLoaded();

module.exports = { localSearch, parseQuery, getSets, getSetCards };
