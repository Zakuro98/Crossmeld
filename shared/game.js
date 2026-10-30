/* Crossmeld state transitions. No DOM, no networking, usable in Node and browser. */
(function (root, factory) {
  const tiles = typeof module === 'object' && module.exports ? require('./tiles.js') : root.CrossmeldTiles;
  const rules = typeof module === 'object' && module.exports ? require('./rules.js') : root.CrossmeldRules;
  const api = factory(tiles, rules);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CrossmeldGame = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (tiles, rules) {
  'use strict';
  const {
    candidateMelds, completionState, updateCompletion, canGoOut, requiredCompletedMelds, discardLimit,
    meldNaturalCount, isNormalForAxis, isCompatible, meldWildCount, meldIdentitiesUnique,
    canTopAddToMeld, selectedNewMeldOptions, hasAnyTakeOption,
    handCompositionMatches, meldTilePoints, meldBonusPoints, handPenalty,
  } = rules;

  class GameError extends Error {
    constructor(code, message) { super(message); this.name = 'GameError'; this.code = code; }
  }
  const fail = (code, message) => { throw new GameError(code, message); };
  const currentPlayer = state => state.players[state.current];

  function ownedTiles(player, ids) {
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) fail('tiles', 'Select valid, distinct tiles.');
    const byId = new Map(player.hand.map(tile => [tile.id, tile]));
    if (ids.some(id => !byId.has(id))) fail('ownership', 'You do not have every selected tile.');
    // Maintain the hand's original tile order, as in the local prototype.
    const wanted = new Set(ids);
    return player.hand.filter(t => wanted.has(t.id));
  }
  function removeFromHand(player, ids) {
    const wanted = new Set(ids);
    player.hand = player.hand.filter(t => !wanted.has(t.id));
  }
  function requirePhase(state, phase) {
    if (state.roundOver || state.phase !== phase) fail('phase', `This action is not available in the ${state.phase} phase.`);
  }
  function requireTarget(options, option) {
    if (!option || !options.some(o => o.type === option.type && o.target === option.target)) {
      fail('meld', 'Those tiles do not form the requested meld.');
    }
  }

  // Do not permit a play to leave one tile and no completed meld: the player
  // would be unable to discard it or go out. Emptying the hand is legal only
  // when the player qualifies to go out (including completion by this move).
  function validatePostPlayHand(player, remaining, playerCount, newlyCompletedMeld = false, requiredCompletions = 2) {
    const qualifies = canGoOut(player, playerCount, newlyCompletedMeld ? 1 : 0, requiredCompletions);
    const required = requiredCompletedMelds(playerCount, requiredCompletions);
    if (remaining === 0 && !qualifies) fail('go-out', `You need ${required} completed ordinary meld${required === 1 ? '' : 's'} to go out.`);
    if (remaining === 1 && !qualifies) fail('stranded', `That move would leave one tile with no legal way to finish your turn. You need ${required} completed ordinary meld${required === 1 ? '' : 's'} to discard your last tile.`);
    return remaining === 0 ? player.id : null;
  }

  class Game {
    constructor({ names, targetScore = 1000, firstPlayer = 0, allowDuplicates = true, randomNaturals = false, requiredCompletions = 2, doubleDiscardScope = 'self', deckConfig = tiles.DEFAULT_DECK_CONFIG, rng = Math.random } = {}) {
      if (!Array.isArray(names) || names.length < 2 || names.length > 4) fail('players', 'Crossmeld requires 2–4 players.');
      if (!Number.isSafeInteger(targetScore) || targetScore < 100 || targetScore > 10000) {
        fail('settings', 'Game target must be an integer between 100 and 10000 points.');
      }
      if (!Number.isSafeInteger(firstPlayer) || firstPlayer < 0 || firstPlayer >= names.length) {
        fail('settings', 'First player must be a valid player seat.');
      }
      if (typeof allowDuplicates !== 'boolean') fail('settings', 'Duplicates allowed must be on or off.');
      if (typeof randomNaturals !== 'boolean') fail('settings', 'Random natural tiles must be on or off.');
      if (!Number.isSafeInteger(requiredCompletions) || requiredCompletions < 1 || requiredCompletions > 20) fail('settings', 'Required completed melds must be an integer between 1 and 20.');
      if (!['self', 'everyone'].includes(doubleDiscardScope)) fail('settings', 'Choose who unlocks two-tile discards.');
      this.deckConfig = { ...deckConfig };
      this.rng = rng;
      this.nextTileId = 1;
      this.nextMeldId = 1;
      this.state = {
        targetScore, allowDuplicates, randomNaturals, requiredCompletions, doubleDiscardScope, round: 1, starter: firstPlayer, current: firstPlayer, phase: 'draw', roundHistory: [],
        stock: [], discard: [], discardFrozen: false, roundOver: false, discardedThisTurn: false, meldedOutThisTurn: false,
        players: names.map((name, id) => ({ id, name, hand: [], melds: [], totalScore: 0, exposedMeldsPreviously: false })),
      };
    }

    startRound() {
      const s = this.state;
      // Build and validate first: an invalid deck must not erase the current
      // round or consume instance IDs before startRound throws.
      let nextId = this.nextTileId;
      const freshDeck = tiles.buildDeck(this.deckConfig, {
        rng: this.rng, nextId: () => nextId++, randomNaturals: s.randomNaturals,
      });
      const size = tiles.startingHandSize(s.players.length);
      if (freshDeck.length < size * s.players.length + 1) {
        fail('deck', 'Deck does not contain enough tiles to deal a round.');
      }
      this.nextTileId = nextId;
      s.roundOver = false;
      s.discardedThisTurn = false;
      s.meldedOutThisTurn = false;
      s.stock = freshDeck;
      s.discard = [];
      s.discardFrozen = false;
      s.players.forEach(p => { p.hand = []; p.melds = []; p.exposedMeldsPreviously = false; });
      s.current = s.starter;
      s.phase = 'draw';
      for (let i = 0; i < size; i++) for (const p of s.players) p.hand.push(s.stock.pop());
      const firstDiscard = s.stock.pop();
      s.discard.push(firstDiscard);
      if (firstDiscard.kind === 'blank' || firstDiscard.kind === 'white') s.discardFrozen = true;
      return { starter: s.current, firstDiscard };
    }

    nextRound() {
      if (!this.state.roundOver) fail('round', 'The current round has not ended.');
      const previousRound = this.state.round;
      const previousStarter = this.state.starter;
      this.state.round++;
      this.state.starter = (this.state.starter + 1) % this.state.players.length;
      try { return this.startRound(); }
      catch (error) {
        this.state.round = previousRound;
        this.state.starter = previousStarter;
        throw error;
      }
    }

    drawStock() {
      const s = this.state;
      requirePhase(s, 'draw');
      if (!s.stock.length) fail('stock', 'The stock is empty.');
      const p = currentPlayer(s);
      const count = Math.min(2, s.stock.length);
      const drawn = [];
      for (let i = 0; i < count; i++) { const tile = s.stock.pop(); drawn.push(tile); p.hand.push(tile); }
      s.phase = 'play';
      return { playerId: p.id, drawn };
    }

    takePileExisting(meldId) {
      const s = this.state;
      requirePhase(s, 'draw');
      const p = currentPlayer(s);
      const meld = p.melds.find(m => m.id === meldId);
      if (!meld || !s.discard.length || s.discardFrozen) fail('pickup', 'You cannot take the pile using that meld.');
      const top = s.discard[s.discard.length - 1];
      if (top.kind === 'black' || !canTopAddToMeld(top, meld, s.allowDuplicates)) fail('pickup', 'The top discard cannot join that meld.');
      const remaining = p.hand.length + s.discard.length - 1;
      const newlyCompletes = !meld.completion && !!completionState({ ...meld, tiles: [...meld.tiles, top] });
      const winnerId = validatePostPlayHand(p, remaining, s.players.length, newlyCompletes, s.requiredCompletions);
      const pile = s.discard.splice(0);
      meld.tiles.push(pile.pop());
      const completedNow = updateCompletion(meld);
      p.hand.push(...pile);
      s.discardFrozen = false;
      s.phase = 'play';
      if (winnerId !== null) s.meldedOutThisTurn = true;
      return { meld, completedNow, received: pile, winnerId };
    }

    takePileNew(ids, option) {
      const s = this.state;
      requirePhase(s, 'draw');
      const p = currentPlayer(s);
      const selected = ownedTiles(p, ids);
      if (selected.length < 2 || !s.discard.length) fail('pickup', 'A new pickup meld requires at least two tiles in hand.');
      const top = s.discard[s.discard.length - 1];
      if (top.kind === 'black') fail('pickup', 'The discard pile is blocked by a black tile.');
      requireTarget(selectedNewMeldOptions(selected, top, s.discardFrozen, s.allowDuplicates), option);
      // Check whether the pickup leaves a legal way to end the turn before
      // removing any tiles. This pickup's meld can itself earn completion.
      const remainingAfterPickup = p.hand.length - selected.length + s.discard.length - 1;
      const pickupCompletes = !!completionState({ type: option.type, target: option.target, tiles: [...selected, top] });
      const winnerId = validatePostPlayHand(p, remainingAfterPickup, s.players.length, pickupCompletes, s.requiredCompletions);
      const pile = s.discard.splice(0);
      const usedTop = pile.pop();
      removeFromHand(p, ids);
      const meld = { id: this.nextMeldId++, type: option.type, target: option.target,
        tiles: [...selected, usedTop], completion: null };
      const completedNow = updateCompletion(meld);
      p.melds.push(meld);
      p.hand.push(...pile);
      s.discardFrozen = false;
      s.phase = 'play';
      if (winnerId !== null) s.meldedOutThisTurn = true;
      return { meld, completedNow, received: pile, winnerId };
    }

    createMeld(ids, option = null) {
      const s = this.state;
      requirePhase(s, 'play');
      if (s.discardedThisTurn) fail('discard', 'You already ended your turn by discarding.');
      const p = currentPlayer(s);
      const selected = ownedTiles(p, ids);
      if (selected.length >= 3 && selected.every(t => t.kind === 'black')) {
        if (selected.length !== p.hand.length) {
          fail('black', 'Black tiles can only be melded as your final play to go out.');
        }
        if (!canGoOut(p, s.players.length, 0, s.requiredCompletions)) fail('go-out', `You need ${requiredCompletedMelds(s.players.length, s.requiredCompletions)} completed ordinary meld${s.requiredCompletions === 1 ? '' : 's'} before going out with black tiles.`);
        removeFromHand(p, ids);
        const meld = { id: this.nextMeldId++, type: 'black', target: null, tiles: selected, completion: null };
        p.melds.push(meld);
        s.meldedOutThisTurn = true;
        return { meld, completedNow: false, winnerId: p.id };
      }
      const options = candidateMelds(selected, s.allowDuplicates);
      if (!options.length) fail('meld', 'That is not a legal meld.');
      if (!option && options.length > 1) fail('choice', 'Choose which kind of meld to create.');
      option ||= options[0];
      requireTarget(options, option);
      const remaining = p.hand.length - selected.length;
      const completes = !!completionState({ type: option.type, target: option.target, tiles: selected });
      const winnerId = validatePostPlayHand(p, remaining, s.players.length, completes, s.requiredCompletions);
      removeFromHand(p, ids);
      const meld = { id: this.nextMeldId++, type: option.type, target: option.target, tiles: selected, completion: null };
      const completedNow = updateCompletion(meld);
      p.melds.push(meld);
      if (winnerId !== null) s.meldedOutThisTurn = true;
      return { meld, completedNow, winnerId };
    }

    addToMeld(meldId, ids) {
      const s = this.state;
      requirePhase(s, 'play');
      if (s.discardedThisTurn) fail('discard', 'You already ended your turn by discarding.');
      const p = currentPlayer(s);
      const meld = p.melds.find(m => m.id === meldId);
      if (!meld || meld.type === 'black') fail('meld', 'No ordinary meld with that ID.');
      const selected = ownedTiles(p, ids);
      if (!selected.every(t => isCompatible(t, meld.type, meld.target))) fail('fit', 'Those tiles do not fit the meld.');
      const combined = [...meld.tiles, ...selected];
      if (meldWildCount(combined) > 2) fail('wilds', 'An ordinary meld can contain no more than two wilds.');
      if (!s.allowDuplicates && !meldIdentitiesUnique(combined, meld.type, meld.target))
        fail('duplicates', 'Each color or number can appear only once in this meld.');
      const remaining = p.hand.length - selected.length;
      const newlyCompletes = !meld.completion && !!completionState({ ...meld, tiles: [...meld.tiles, ...selected] });
      const winnerId = validatePostPlayHand(p, remaining, s.players.length, newlyCompletes, s.requiredCompletions);
      removeFromHand(p, ids);
      meld.tiles.push(...selected);
      const completedNow = updateCompletion(meld);
      if (winnerId !== null) s.meldedOutThisTurn = true;
      return { meld, completedNow, winnerId };
    }

    discard(tileIds) {
      const s = this.state;
      requirePhase(s, 'play');
      if (s.discardedThisTurn) fail('discard', 'You already discarded this turn.');
      const p = currentPlayer(s);
      // Single-ID callers remain compatible; arrays are ordered bottom to top.
      const ids = Array.isArray(tileIds) ? tileIds : [tileIds];
      const limit = discardLimit(s, p);
      if (ids.length > limit) fail('discard-count', `You may discard up to ${limit} tile${limit === 1 ? '' : 's'} this turn.`);
      const owned = ownedTiles(p, ids);
      const byId = new Map(owned.map(tile => [tile.id, tile]));
      const discarded = ids.map(id => byId.get(id));
      if (p.hand.length === discarded.length && !canGoOut(p, s.players.length, 0, s.requiredCompletions)) fail('go-out', `You need ${requiredCompletedMelds(s.players.length, s.requiredCompletions)} completed ordinary meld${s.requiredCompletions === 1 ? '' : 's'} before discarding your final tiles.`);
      removeFromHand(p, ids);
      s.discard.push(...discarded);
      if (discarded.some(tile => tile.kind === 'blank' || tile.kind === 'white')) s.discardFrozen = true;
      s.discardedThisTurn = true;
      return { tile: discarded[discarded.length - 1], tiles: discarded, playerId: p.id, winnerId: p.hand.length ? null : p.id };
    }

    advanceTurn() {
      const s = this.state;
      requirePhase(s, 'play');
      if (!s.discardedThisTurn) fail('discard-required', 'You must discard a tile to end your turn.');
      if (!currentPlayer(s).hand.length) fail('round', 'The last discard ended the round; score it instead of advancing.');
      // An ordinary meld made on a preceding turn prevents a concealed out.
      currentPlayer(s).exposedMeldsPreviously ||= currentPlayer(s).melds.length > 0;
      s.discardedThisTurn = false;
      s.meldedOutThisTurn = false;
      s.current = (s.current + 1) % s.players.length;
      s.phase = 'draw';
      const p = currentPlayer(s);
      return { playerId: p.id, stockExhausted: !s.stock.length,
        roundEnds: !s.stock.length && !hasAnyTakeOption(p, s.discard, s.discardFrozen, requiredCompletedMelds(s.players.length, s.requiredCompletions), s.allowDuplicates) };
    }

    scoreRound(winnerId) {
      return this.state.players.map(player => {
        const table = meldTilePoints(player), bonuses = meldBonusPoints(player);
        const concealedOut = player.id === winnerId && !player.exposedMeldsPreviously;
        const out = player.id === winnerId ? (concealedOut ? 100 : 50) : 0;
        const penalty = handPenalty(player);
        return { player, table, bonuses, out, concealedOut, penalty, delta: table + bonuses + out - penalty };
      });
    }
    finishRound(winnerId) {
      if (this.state.roundOver) fail('round', 'The round has already ended.');
      if (winnerId === null || winnerId === undefined) {
        const s = this.state;
        // With no player going out, the only normal end condition is that
        // stock is empty and the next player cannot legally take the pile.
        if (s.phase !== 'draw' || s.stock.length !== 0 ||
            hasAnyTakeOption(currentPlayer(s), s.discard, s.discardFrozen,
              requiredCompletedMelds(s.players.length, s.requiredCompletions), s.allowDuplicates)) {
          fail('round', 'The round cannot end while a legal turn is available.');
        }
      } else {
        const s = this.state;
        const winner = s.players.find(p => p.id === winnerId);
        if (!winner || !(s.discardedThisTurn || s.meldedOutThisTurn) || s.players[s.current].id !== winnerId ||
            winner.hand.length !== 0 || !canGoOut(winner, s.players.length, 0, s.requiredCompletions)) {
          fail('go-out', `A player needs ${requiredCompletedMelds(s.players.length, s.requiredCompletions)} completed ordinary meld${s.requiredCompletions === 1 ? '' : 's'} to go out.`);
        }
      }
      const results = this.scoreRound(winnerId);
      this.state.roundOver = true;
      results.forEach(r => { r.player.totalScore += r.delta; });
      // Store public score changes, never tiles or hidden hands, for the final
      // match standings. This history survives nextRound() and is append-only.
      this.state.roundHistory.push({
        round: this.state.round,
        scores: results.map(r => ({playerId:r.player.id, delta:r.delta, totalScore:r.player.totalScore})),
      });
      const reached = results.filter(r => r.player.totalScore >= this.state.targetScore);
      const best = reached.length ? Math.max(...reached.map(r => r.player.totalScore)) : null;
      return { results, reached, winners: reached.filter(r => r.player.totalScore === best),
        history: this.state.roundHistory.map(h => ({ round:h.round, scores:h.scores.map(score => ({...score})) })) };
    }

    handMatches(playerId, ids) {
      const player = this.state.players.find(p => p.id === playerId);
      return !!player && handCompositionMatches(player, ids);
    }
  }
  return { Game, GameError, currentPlayer };
});
