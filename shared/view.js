/* Safe per-player game projections. Never send a raw Game.state over the wire. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CrossmeldView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const copyTile = t => ({ id: t.id, kind: t.kind, color: t.color, number: t.number });
  const copyMeld = m => ({ id: m.id, type: m.type, target: m.target,
    completion: m.completion, tiles: m.tiles.map(copyTile) });

  // playerId is the authenticated seat selected by the room server, never a
  // playerId supplied without authentication by a browser message.
  function playerView(game, playerId) {
    const s = game.state;
    const you = s.players.find(p => p.id === playerId);
    if (!you) throw new RangeError('No such player seat.');
    return {
      round: s.round,
      targetScore: s.targetScore,
      allowDuplicates: s.allowDuplicates,
      starterId: s.players[s.starter].id,
      currentPlayerId: s.players[s.current].id,
      phase: s.phase,
      roundOver: s.roundOver,
      discardFrozen: s.discardFrozen,
      stockCount: s.stock.length,
      discard: s.discard.map(copyTile), // The discard pile is public, in order.
      yourPlayerId: playerId,
      hand: you.hand.map(copyTile),
      players: s.players.map(p => ({
        id: p.id,
        name: p.name,
        handCount: p.hand.length,
        totalScore: p.totalScore,
        melds: p.melds.map(copyMeld),
      })),
    };
  }

  // Game.finishRound() returns player objects with their private hands.
  // Online rooms must only broadcast this redacted scoring representation.
  function publicRoundResults(finishResult) {
    return {
      results: finishResult.results.map(r => {
        const meldTiles = r.player.melds.flatMap(m => m.tiles);
        const normalTiles = meldTiles.filter(t => t.kind === 'normal').length;
        const specialTiles = meldTiles.length - normalTiles;
        const naturalCompletions = r.player.melds.filter(m => m.completion === 'natural').length;
        const mixedCompletions = r.player.melds.filter(m => m.completion === 'mixed').length;
        const normalLeft = r.player.hand.filter(t => t.kind === 'normal').length;
        const specialLeft = r.player.hand.length - normalLeft;
        return {
          playerId: r.player.id,
          name: r.player.name,
          normalTiles,
          specialTiles,
          naturalCompletions,
          mixedCompletions,
          normalLeft,
          specialLeft,
          table: r.table,
          bonuses: r.bonuses,
          out: r.out,
          concealedOut: r.concealedOut,
          penalty: r.penalty,
          delta: r.delta,
          previousScore: r.player.totalScore - r.delta,
          totalScore: r.player.totalScore,
        };
      }),
      reachedPlayerIds: finishResult.reached.map(r => r.player.id),
      winnerPlayerIds: finishResult.winners.map(r => r.player.id),
      // Only the completed match needs its round history. No hands or tiles.
      history: finishResult.reached.length ? finishResult.history.map(h => ({
        round:h.round, scores:h.scores.map(score => ({...score})),
      })) : [],
    };
  }

  return { playerView, publicRoundResults };
});
