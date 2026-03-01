"use strict";

/**
 * services/localCardSearch.service.js
 *
 * Wraps the existing localCards.service to add intent-based query parsing.
 * Does NOT duplicate card loading — all data access goes through localCards.
 *
 * Supported query patterns:
 *   "Charizard Phantasmal Flames"  → card name + set name
 *   "Gengar VMAX 00/f00"           → card name + card number
 *   "Me02"                          → set code only → return full set
 *   "Destined Rivals"              → set name only → return full set
 */

const localCards = require("./LocalCards.service");
const fs = require("fs");
const path = require("path");

// ─── Set registry (loaded once) ───────────────────────────────────────────────

let _sets = null;

function getSets() {
  if (_sets) return _sets;
  const filePath = path.resolve(__dirname, "../data/sets/en.json");
  if (!fs.existsSync(filePath)) {
    console.warn("[LocalSearch] sets/en.json not found");
    _sets = [];
    return _sets;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  _sets = Array.isArray(parsed) ? parsed : (parsed.data ?? []);
  return _sets;
}

// ─── Normalizers ──────────────────────────────────────────────────────────────

/** "Me02" -> "me2", "sv10" -> "sv10" — strips leading zeros from numeric part */
function normalizeSetCode(input) {
  return input.toLowerCase().replace(/^([a-z]+)0*(\d+)(.*)$/, "$1$2$3");
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ─── Query Parser ─────────────────────────────────────────────────────────────

// Matches: "013/094", "00/f00", "085", "TG01", "GG70"
const CARD_NUMBER_REGEX =
  /\b(\d{1,3}\/[a-zA-Z0-9]{1,6}|[A-Z]{1,3}\d{2,3}|\d{3})\b/;

/**
 * parseQuery(rawQuery) -> { type, set, cardName, cardNumber }
 * type: 'set_only' | 'card_in_set' | 'card_global'
 */
function parseQuery(rawQuery) {
  let remaining = rawQuery.trim();
  let cardNumber = null;

  // 1. Extract card number if present
  const numMatch = remaining.match(CARD_NUMBER_REGEX);
  if (numMatch) {
    cardNumber = numMatch[1];
    remaining = remaining
      .replace(numMatch[0], "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  const sets = getSets();

  // 2. Single token — could be a set code (e.g. "Me02", "sv10", "base1")
  if (remaining && !remaining.includes(" ")) {
    const normalized = normalizeSetCode(remaining);
    const setByCode = sets.find(
      (s) =>
        s.id.toLowerCase() === normalized ||
        (s.ptcgoCode && s.ptcgoCode.toLowerCase() === remaining.toLowerCase()),
    );
    if (setByCode) {
      if (!cardNumber) {
        return {
          type: "set_only",
          set: setByCode,
          cardName: null,
          cardNumber: null,
        };
      }
      return {
        type: "card_in_set",
        set: setByCode,
        cardName: null,
        cardNumber,
      };
    }
  }

  // 3. Try matching trailing words against known set names (longest match wins)
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

  // 4. Also check for an inline set code token among the words
  if (!matchedSet) {
    for (let i = 0; i < words.length; i++) {
      const normalized = normalizeSetCode(words[i]);
      const found = sets.find((s) => s.id.toLowerCase() === normalized);
      if (found) {
        matchedSet = found;
        const rest = [...words.slice(0, i), ...words.slice(i + 1)]
          .join(" ")
          .trim();
        const cn = rest || null;
        if (!cn && !cardNumber) {
          return {
            type: "set_only",
            set: found,
            cardName: null,
            cardNumber: null,
          };
        }
        return { type: "card_in_set", set: found, cardName: cn, cardNumber };
      }
    }
  }

  const cardNameWords = matchedSet
    ? words.slice(0, words.length - matchedLength)
    : words;
  const cardName = cardNameWords.join(" ").trim() || null;

  if (matchedSet && !cardName && !cardNumber) {
    return {
      type: "set_only",
      set: matchedSet,
      cardName: null,
      cardNumber: null,
    };
  }
  if (matchedSet) {
    return { type: "card_in_set", set: matchedSet, cardName, cardNumber };
  }
  return {
    type: "card_global",
    set: null,
    cardName: cardName || remaining,
    cardNumber,
  };
}

// ─── Set card loader ──────────────────────────────────────────────────────────

function getSetCards(set, limit = 60) {
  const filePath = path.resolve(__dirname, `../data/cards/en/${set.id}.json`);
  if (!fs.existsSync(filePath)) return [];

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : (parsed.data ?? []);
    return list.slice(0, limit).map((card) => enrichCard(card, set));
  } catch {
    return [];
  }
}

// ─── Card resolution using existing localCards API ───────────────────────────

function resolveCardInSet(set, cardName, cardNumber, limit = 10) {
  let candidates = [];

  if (cardName) {
    // Defensive — use whichever API is available
    if (typeof localCards.findCard === "function") {
      const best = localCards.findCard(cardName, set.name);
      if (best) candidates.push(best);
    }
    if (typeof localCards.getCardsByName === "function") {
      const byName = localCards.getCardsByName(cardName);
      for (const c of byName) {
        if (!candidates.find((x) => x.id === c.id)) candidates.push(c);
      }
    }
    // Always fall back to searchLocal — filter to this set after
    if (
      candidates.length === 0 &&
      typeof localCards.searchLocal === "function"
    ) {
      const searched = localCards.searchLocal(cardName, 30);
      candidates = searched;
    }
  }

  // Filter to only this set
  let results = candidates.filter((c) => (c.set?.id || "") === set.id);

  // Card number hard filter
  if (cardNumber) {
    const queryNum = cardNumber.replace(/^0+/, "").toLowerCase();
    results = results.filter(
      (c) => (c.number || "").replace(/^0+/, "").toLowerCase() === queryNum,
    );
  }

  return results.slice(0, limit).map((card) => enrichCard(card, set));
}

function resolveCardGlobal(cardName, cardNumber, limit = 10) {
  const sets = getSets();
  let candidates = [];

  if (cardName && typeof localCards.searchLocal === "function") {
    // searchLocal does name-contains, which is what we need
    candidates = localCards.searchLocal(cardName, 30);
  }

  // Card number hard filter
  if (cardNumber) {
    const queryNum = cardNumber.replace(/^0+/, "").toLowerCase();
    candidates = candidates.filter(
      (c) => (c.number || "").replace(/^0+/, "").toLowerCase() === queryNum,
    );
  }

  return candidates.slice(0, limit).map((card) => {
    const set = sets.find((s) => s.id === (card.set?.id || "")) || null;
    return set ? enrichCard(card, set) : card;
  });
}

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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * localSearch(rawQuery) ->
 * {
 *   intent, primaryResults, setFallback,
 *   detectedSet, parsedCardName, parsedCardNumber, scrydexQuery
 * }
 */
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
  const parsed = parseQuery(rawQuery);
  const { type, set, cardName, cardNumber } = parsed;

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

    if (primary.length === 0) {
      console.log(
        `[LocalSearch] No match in ${set.id} — returning set fallback`,
      );
    }

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

module.exports = { localSearch, parseQuery, getSets, getSetCards };
