/* Pure Crossmeld rules, usable identically in a browser or on the server. */
(function (root, factory) {
  const tiles = typeof module === 'object' && module.exports ? require('./tiles.js') : root.CrossmeldTiles;
  const api = factory(tiles);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CrossmeldRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (tiles) {
  'use strict';
  const { COLORS, tileValue } = tiles;

  function isCompatible(tile, type, target) {
    if (tile.kind === 'black') return false;
    if (type === 'number') {
      if (tile.kind === 'blank') return true;
      return tile.number === target;
    }
    if (type === 'color') {
      if (tile.kind === 'white') return true;
      return tile.color === target;
    }
    return false;
  }

  function isWild(tile) {
    return tile.kind === 'blank' || tile.kind === 'white';
  }

  function meldNaturalCount(tiles, type, target) {
    return tiles.filter(t => isNormalForAxis(t, type, target)).length;
  }

  function meldWildCount(tiles) {
    return tiles.filter(isWild).length;
  }

  function ordinaryMeldLimitsOk(tiles, type, target) {
    return meldNaturalCount(tiles, type, target) >= 2 && meldWildCount(tiles) <= 2;
  }

  function candidateMelds(tiles) {
    if (tiles.length < 3 || tiles.some(t => t.kind === 'black')) return [];
    const out = [];
    for (let n = 1; n <= 6; n++) {
      if (tiles.every(t => isCompatible(t, 'number', n)) && ordinaryMeldLimitsOk(tiles, 'number', n)) {
        out.push({ type: 'number', target: n });
      }
    }
    for (let c = 0; c < 6; c++) {
      if (tiles.every(t => isCompatible(t, 'color', c)) && ordinaryMeldLimitsOk(tiles, 'color', c)) {
        out.push({ type: 'color', target: c });
      }
    }
    return out;
  }

  function isNormalForAxis(tile, type, target) {
    if (tile.kind !== 'normal') return false;
    return type === 'number' ? tile.number === target : tile.color === target;
  }

  function completionState(meld) {
    if (meld.type === 'number') {
      const naturalColors = new Set(meld.tiles.filter(t => t.kind === 'normal' && t.number === meld.target).map(t => t.color));
      if (naturalColors.size === 6) return 'natural';
      const fixed = new Set();
      let flex = 0;
      for (const t of meld.tiles) {
        if (!isCompatible(t, 'number', meld.target)) continue;
        if (t.kind === 'normal' || t.kind === 'blank') fixed.add(t.color);
        else if (t.kind === 'white' && t.number === meld.target) flex++;
      }
      return fixed.size + flex >= 6 ? 'mixed' : null;
    }
    const naturalNums = new Set(meld.tiles.filter(t => t.kind === 'normal' && t.color === meld.target).map(t => t.number));
    if (naturalNums.size === 6) return 'natural';
    const fixed = new Set();
    let flex = 0;
    for (const t of meld.tiles) {
      if (!isCompatible(t, 'color', meld.target)) continue;
      if (t.kind === 'normal' || t.kind === 'white') fixed.add(t.number);
      else if (t.kind === 'blank' && t.color === meld.target) flex++;
    }
    return fixed.size + flex >= 6 ? 'mixed' : null;
  }

  function updateCompletion(meld) {
    if (meld.completion) return false;
    const status = completionState(meld);
    if (status) {
      meld.completion = status;
      return true;
    }
    return false;
  }

  function completedMeldCount(player) {
    return player.melds.filter(m => m.type !== 'black' && (m.completion === 'natural' || m.completion === 'mixed')).length;
  }
  function hasCompletedMeld(player) { return completedMeldCount(player) > 0; }
  function requiredCompletedMelds(playerCount) { return playerCount === 2 ? 2 : 1; }
  function canGoOut(player, playerCount, newlyCompletedMelds = 0) {
    return completedMeldCount(player) + newlyCompletedMelds >= requiredCompletedMelds(playerCount);
  }

  function meldName(meld) {
    if (meld.type === 'black') return 'Black meld';
    return meld.type === 'number' ? `${meld.target}s` : `${COLORS[meld.target].name}`;
  }

  function meldTilePoints(player) {
    return player.melds.reduce((sum,m) => sum + m.tiles.reduce((s,t) => s + tileValue(t),0),0);
  }

  function meldBonusPoints(player) {
    return player.melds.reduce((sum,m) => sum + (m.completion === 'natural' ? 100 : m.completion === 'mixed' ? 60 : 0),0);
  }

  function provisionalRoundScore(player) { return meldTilePoints(player) + meldBonusPoints(player); }

  function handPenalty(player) { return player.hand.reduce((s,t) => s + tileValue(t),0); }

  function canTopAddToMeld(top, meld) {
    if (!isCompatible(top, meld.type, meld.target)) return false;
    return meldWildCount([...meld.tiles, top]) <= 2;
  }

  function hasFrozenNaturalPair(player, top) {
    if (!top || top.kind !== 'normal') return false;
    const normals = player.hand.filter(t => t.kind === 'normal');
    let numberCount = 0, colorCount = 0;
    for (const t of normals) {
      if (t.number === top.number) numberCount++;
      if (t.color === top.color) colorCount++;
    }
    return numberCount >= 2 || colorCount >= 2;
  }

  function hasAnyNewMeldWithTop(player, top) {
    const naturals = player.hand.filter(t => t.kind === 'normal');
    for (let i = 0; i < naturals.length; i++) {
      for (let j = i + 1; j < naturals.length; j++) {
        const pair = [naturals[i], naturals[j]];
        const options = candidateMelds([...pair, top]);
        if (options.some(o => meldNaturalCount(pair, o.type, o.target) >= 2)) return true;
      }
    }
    return false;
  }

  function selectedNewMeldOptions(selectedTiles, top, frozenOnly = false) {
    if (selectedTiles.length < 2) return [];
    const tiles = [...selectedTiles, top];
    let options = candidateMelds(tiles).filter(o => meldNaturalCount(selectedTiles, o.type, o.target) >= 2);
    if (frozenOnly) {
      if (top.kind !== 'normal' || selectedTiles.some(t => t.kind !== 'normal')) return [];
      options = options.filter(o => tiles.every(t => isNormalForAxis(t, o.type, o.target)));
    }
    return options;
  }

  function hasAnyTakeOption(player, discard, discardFrozen, requiredCount = 1) {
    if (!discard.length) return false;
    const top = discard[discard.length - 1];
    if (top.kind === 'black') return false;

    const mayFinishWith = (remaining, resultingMeld) => {
      if (remaining > 1) return true;
      // An already-completed existing meld isn't a *new* completion.
      const newlyCompleted = !resultingMeld.completion && !!completionState(resultingMeld) ? 1 : 0;
      return completedMeldCount(player) + newlyCompleted >= requiredCount;
    };

    if (!discardFrozen) {
      for (const meld of player.melds) {
        if (canTopAddToMeld(top, meld) &&
            mayFinishWith(player.hand.length + discard.length - 1,
              { ...meld, tiles: [...meld.tiles, top] })) return true;
      }
    }

    // Every new pickup needs two matching natural tiles already in hand.
    // Testing a pair is sufficient: if those two leave >=2 tiles, it is
    // legal to continue. If they leave <=1, there are at most three tiles
    // in the hand, too few to complete a six-slot meld without an existing
    // completed meld (which is covered by mayFinishWith).
    const naturals = player.hand.filter(t => t.kind === 'normal');
    for (let i = 0; i < naturals.length; i++) {
      for (let j = i + 1; j < naturals.length; j++) {
        const selected = [naturals[i], naturals[j]];
        for (const option of selectedNewMeldOptions(selected, top, discardFrozen)) {
          const remaining = player.hand.length - 2 + discard.length - 1;
          if (mayFinishWith(remaining, { ...option, tiles: [...selected, top] })) return true;
        }
      }
    }
    return false;
  }

  function wouldQualifyToGoOutWithNewMeld(player, tiles, options, requiredCount = 1) {
    return options.some(o => completedMeldCount(player) +
      (completionState({ type: o.type, target: o.target, tiles, completion: null }) ? 1 : 0) >= requiredCount);
  }

  function handCompositionMatches(player, ids) {
    if (!Array.isArray(ids) || ids.length !== player.hand.length) return false;
    if (new Set(ids).size !== ids.length) return false;
    const owned = new Set(player.hand.map(t => t.id));
    return ids.every(id => owned.has(id));
  }

  return { isCompatible, isWild, meldNaturalCount, meldWildCount, ordinaryMeldLimitsOk, candidateMelds, isNormalForAxis, completionState, updateCompletion, hasCompletedMeld, completedMeldCount, requiredCompletedMelds, canGoOut, meldName, meldTilePoints, meldBonusPoints, provisionalRoundScore, handPenalty, canTopAddToMeld, hasFrozenNaturalPair, hasAnyNewMeldWithTop, selectedNewMeldOptions, hasAnyTakeOption, wouldQualifyToGoOutWithNewMeld, handCompositionMatches };
});
