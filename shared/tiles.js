/* Crossmeld tile definitions and deck factory. Browser global + Node/CommonJS. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CrossmeldTiles = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const COLORS = Object.freeze([
    { id: 0, name: 'Red', hue: 350, pip: 'light' },
    { id: 1, name: 'Orange', hue: 23, pip: 'dark' },
    { id: 2, name: 'Yellow', hue: 45, pip: 'dark' },
    { id: 3, name: 'Green', hue: 120, pip: 'light' },
    { id: 4, name: 'Blue', hue: 210, pip: 'light' },
    { id: 5, name: 'Purple', hue: 295, pip: 'light' },
  ]);
  const NUMBERS = Object.freeze([1, 2, 3, 4, 5, 6]);
  const PIP_POS = Object.freeze({
    1: [4], 2: [0, 8], 3: [0, 4, 8],
    4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
  });

  // Copy counts are configuration, NOT baked into draw/score/game logic.
  // Deliberately does not add the hypothetical blank white universal wild.
  const DEFAULT_DECK_CONFIG = Object.freeze({
    normalCopies: 3,
    coloredBlankCopies: 1,
    whiteNumberedCopies: 1,
    blackCopies: 4,
  });

  function shuffle(arr, rng = Math.random) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function buildDeck(config = DEFAULT_DECK_CONFIG, options = {}) {
    const { rng = Math.random, nextId = (() => { let id = 1; return () => id++; })() } = options;
    for (const key of ['normalCopies','coloredBlankCopies','whiteNumberedCopies','blackCopies']) {
      if (!Number.isSafeInteger(config[key]) || config[key] < 0) {
        throw new TypeError(`Deck configuration ${key} must be a non-negative integer.`);
      }
    }
    const deck = [];
    const add = (kind, color, number) => deck.push({ id: nextId(), kind, color, number });
    for (let copy = 0; copy < config.normalCopies; copy++) {
      for (const color of COLORS) for (const number of NUMBERS) add('normal', color.id, number);
    }
    for (let copy = 0; copy < config.coloredBlankCopies; copy++) {
      for (const color of COLORS) add('blank', color.id, null);
    }
    for (let copy = 0; copy < config.whiteNumberedCopies; copy++) {
      for (const number of NUMBERS) add('white', null, number);
    }
    for (let copy = 0; copy < config.blackCopies; copy++) add('black', null, null);
    return shuffle(deck, rng);
  }

  function startingHandSize(count) { return count === 2 ? 15 : count === 3 ? 13 : 11; }
  function tileValue(tile) { return tile.kind === 'normal' ? 5 : 10; }
  function tileAria(tile) {
    if (tile.kind === 'normal') return `${COLORS[tile.color].name} ${tile.number}`;
    if (tile.kind === 'blank') return `${COLORS[tile.color].name} blank`;
    if (tile.kind === 'white') return `White ${tile.number}`;
    return 'Black tile';
  }

  // Presentation-only ordering: the server never needs this method.
  function sortHand(player, mode = player.sort) {
    player.sort = mode;
    if (mode === 'manual') return;
    const kindRank = { normal: 0, blank: 1, white: 2, black: 3 };
    player.hand.sort((a, b) => {
      if (mode === 'color') {
        const ac = a.color ?? 99, bc = b.color ?? 99;
        if (ac !== bc) return ac - bc;
        const an = a.number ?? 99, bn = b.number ?? 99;
        if (an !== bn) return an - bn;
      } else if (mode === 'number') {
        const an = a.number ?? 99, bn = b.number ?? 99;
        if (an !== bn) return an - bn;
        const ac = a.color ?? 99, bc = b.color ?? 99;
        if (ac !== bc) return ac - bc;
      }
      return kindRank[a.kind] - kindRank[b.kind] || a.id - b.id;
    });
  }

  return { COLORS, NUMBERS, PIP_POS, DEFAULT_DECK_CONFIG, buildDeck, shuffle,
    startingHandSize, tileValue, tileAria, sortHand };
});
