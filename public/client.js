(() => {
  'use strict';

  function randomLogoTiles() {
    const colorA = Math.floor(Math.random() * 6);
    const numberA = 1 + Math.floor(Math.random() * 6);

    const otherColors = [0,1,2,3,4,5].filter(c => c !== colorA);
    const otherNumbers = [1,2,3,4,5,6].filter(n => n !== numberA);
    const colorB = otherColors[Math.floor(Math.random() * otherColors.length)];
    const numberB = otherNumbers[Math.floor(Math.random() * otherNumbers.length)];

    return [
      { color: colorA, number: numberA },
      { color: colorB, number: numberB },
    ];
  }

  function renderLogoTile(el, tile) {
    const slotClass = el.classList.contains('logo-tile-a') ? 'logo-tile-a' : 'logo-tile-b';
    const gameTile = tileElement({
      id: -1,
      kind: 'normal',
      color: tile.color,
      number: tile.number,
    });

    // Keep only the logo positioning class; everything visual comes from the
    // exact same tile classes and pip markup used by tiles in the game.
    el.className = `logo-tile ${slotClass} ${gameTile.className}`;
    el.style.cssText = gameTile.style.cssText;
    el.setAttribute('aria-label', gameTile.getAttribute('aria-label') || '');
    el.title = gameTile.title;
    el.replaceChildren(...Array.from(gameTile.childNodes, node => node.cloneNode(true)));
  }

  function initializeCrossmeldLogos() {
    const [a, b] = randomLogoTiles();
    document.querySelectorAll('.crossmeld-mark').forEach(mark => {
      const tileA = mark.querySelector('.logo-tile-a');
      const tileB = mark.querySelector('.logo-tile-b');
      if (tileA) renderLogoTile(tileA, a);
      if (tileB) renderLogoTile(tileB, b);
    });
  }

  // Starting goals are suggestions; players can enter any permitted score.
  const DEFAULT_TARGETS = {2: 1500, 3: 1250, 4: 1000};

  const els = {
    setupScreen: document.getElementById('setupScreen'),
    gameScreen: document.getElementById('gameScreen'),
    playerCount: document.getElementById('playerCount'),
    targetScore: document.getElementById('targetScore'),
    localFirstPlayer: document.getElementById('localFirstPlayer'),
    localAllowDuplicates: document.getElementById('localAllowDuplicates'),
    startGameBtn: document.getElementById('startGameBtn'),
    newGameBtn: document.getElementById('newGameBtn'),
    gameAbortBtn: document.getElementById('gameAbortBtn'),
    roundLabel: document.getElementById('roundLabel'),
    statusLine: document.getElementById('statusLine'),
    playersArea: document.getElementById('playersArea'),
    roundResults: document.getElementById('roundResults'),
    tableZone: document.getElementById('tableZone'),
    stockPileCard: document.getElementById('stockPileCard'),
    discardPileCard: document.getElementById('discardPileCard'),
    stockCount: document.getElementById('stockCount'),
    stockHint: document.getElementById('stockHint'),
    discardVisual: document.getElementById('discardVisual'),
    discardInfo: document.getElementById('discardInfo'),
    discardHint: document.getElementById('discardHint'),
    sortColorBtn: document.getElementById('sortColorBtn'),
    sortNumberBtn: document.getElementById('sortNumberBtn'),
    clearSelectionBtn: document.getElementById('clearSelectionBtn'),
    handTitle: document.getElementById('handTitle'),
    handMeta: document.getElementById('handMeta'),
    hand: document.getElementById('hand'),
    handCard: document.querySelector('.hand-card'),
    handExpandBtn: document.getElementById('handExpandBtn'),
    modalLayer: document.getElementById('modalLayer'),
    modal: document.getElementById('modal'),
  };

  // GitHub Pages serves only static frontend files; Render runs online rooms.
  // If Render assigns a different hostname, update this URL before deploying.
  const ONLINE_SERVER_ORIGIN = location.hostname.endsWith('.github.io')
    ? 'https://crossmeld-online.onrender.com' : '';
  function onlineSocketURL() {
    if (ONLINE_SERVER_ORIGIN) {
      const endpoint = new URL('/ws', ONLINE_SERVER_ORIGIN);
      endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
      return endpoint.href;
    }
    if (location.protocol !== 'https:' && location.protocol !== 'http:') return null;
    if (location.hostname.endsWith('.github.io')) return null;
    return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
  }



  const { COLORS, PIP_POS, tileAria, sortHand } = CrossmeldTiles;
  const {
    isCompatible, isWild, meldNaturalCount, meldWildCount, candidateMelds,
    isNormalForAxis, completionState, updateCompletion, canGoOut, requiredCompletedMelds,
    meldName, provisionalRoundScore, canTopAddToMeld,
  } = CrossmeldRules;
  const { Game, GameError, currentPlayer: playerOnTurn } = CrossmeldGame;

  let notificationAudioContext = null;

  function ensureNotificationAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!notificationAudioContext) notificationAudioContext = new AudioContextClass();
    if (notificationAudioContext.state === 'suspended') {
      notificationAudioContext.resume().catch(() => {});
    }
    return notificationAudioContext;
  }

  function playNotificationTone(notes) {
    const ctx = ensureNotificationAudio();
    if (!ctx || ctx.state === 'closed') return;
    const start = ctx.currentTime + 0.01;
    for (const note of notes) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      const noteStart = start + note.delay;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(note.frequency, noteStart);
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(note.gain, noteStart + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + note.duration);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteStart + note.duration + 0.02);
    }
  }

  function playTurnNotificationSound() {
    playNotificationTone([
      { frequency: 523.25, delay: 0, duration: 0.14, gain: 0.085 },
      { frequency: 783.99, delay: 0.12, duration: 0.20, gain: 0.095 },
    ]);
  }

  function playChatNotificationSound() {
    playNotificationTone([
      { frequency: 659.25, delay: 0, duration: 0.11, gain: 0.065 },
    ]);
  }

  // Unlock Web Audio on the first ordinary user interaction. Browsers generally
  // block programmatic audio until the page has received a gesture.
  document.addEventListener('pointerdown', ensureNotificationAudio, { once: true, passive: true });
  document.addEventListener('keydown', ensureNotificationAudio, { once: true });
  let game = null;
  let state = null;
  const online = {
    active:false, socket:null, connected:false, confirmed:null, pending:[], busy:false,
    playerId:null, roomCode:null, token:null, nextActionId:1,
    lobby:null, messages:[], entryMode:'create', leaving:false, closing:false,
    sessionNonce:Array.from(crypto.getRandomValues(new Uint32Array(2)),n=>n.toString(16).padStart(8,'0')).join(''), sort:'color',
    handOrder:[], waitingForFinish:false, viewRound:null, retryTimer:null, reconnecting:false,
    pingMs:null, pingTimer:null, pingNextId:0, pingPending:new Map(),
    lastChatMessageId:null, awaitingResync:false, awaitingChatResync:false,
  };
  const handPlayer = () => online.active ? state.players[online.playerId] : currentPlayer();
  const isMyTurn = () => !online.active || (online.connected &&
    state && state.players[state.current]?.id === online.playerId);
  const canActOnline = () => isMyTurn() && !online.leaving && !online.closing && !online.busy && !online.waitingForFinish &&
    !state?.discardedThisTurn && !online.confirmed?.paused;

  // UI-only state is never part of the authoritative game snapshot.
  const ui = { selected: new Set(), expandedMelds: new Set(), message: '' };

  let handExpanded = false;
  function syncHandDock() {
    const compact = !handExpanded;
    els.handCard.classList.toggle('mobile-compact', compact);
    els.handCard.classList.toggle('mobile-expanded', !compact);
    els.handExpandBtn.textContent = compact ? 'Show all' : 'Compact';
    els.handExpandBtn.setAttribute('aria-expanded', String(!compact));
  }
  els.handExpandBtn.addEventListener('click', () => {
    stopHandMomentum();
    handExpanded = !handExpanded;
    syncHandDock();
  });
  syncHandDock();

  function currentPlayer() { return state.players[state.current]; }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function tileCount(n) { return `${n} ${n === 1 ? 'tile' : 'tiles'}`; }

  function tileElement(tile, { button = false, mini = false, selected = false } = {}) {
    const el = document.createElement(button ? 'button' : 'div');
    el.className = `tile ${tile.kind}${mini ? ' tile-mini' : ''}${selected ? ' selected' : ''}`;
    el.setAttribute('aria-label', tileAria(tile));
    el.title = tileAria(tile);
    if (button) el.type = 'button';
    if (tile.color !== null) {
      el.style.setProperty('--h', String(COLORS[tile.color].hue));
      el.classList.add(`color-${tile.color}`);
      if ((tile.kind === 'normal' || tile.kind === 'blank') && tile.color !== 2) {
        el.classList.add('light-pips');
      }
    }
    if (tile.number !== null) {
      const grid = document.createElement('div');
      grid.className = `pip-grid${tile.number === 1 ? ' single' : ''}`;
      const used = new Set(PIP_POS[tile.number]);
      for (let i = 0; i < 9; i++) {
        const cell = document.createElement('span');
        cell.className = 'pip';
        if (!used.has(i)) cell.style.visibility = 'hidden';
        grid.append(cell);
      }
      el.append(grid);
    }
    return el;
  }

  function sortAllHands() { state.players.forEach(p => sortHand(p)); }

  function createExampleTile(kind, color = null, number = null) {
    if (!createExampleTile.nextId) createExampleTile.nextId = 1;
    return { id: `how-${createExampleTile.nextId++}`, kind, color, number };
  }

  function mountHowTiles(id, tiles, options = {}) {
    const host = document.getElementById(id);
    if (!host) return;
    host.replaceChildren(...tiles.map(tile => tileElement(tile, options)));
  }

  function initializeHowToPlayExamples() {
    // Tile-type samples show every color, number, and black tile in the deck.
    mountHowTiles('howNormalExample', COLORS.map((_, i) => createExampleTile('normal', i, i + 1)));
    mountHowTiles('howBlankExample', COLORS.map((_, i) => createExampleTile('blank', i, null)));
    mountHowTiles('howWhiteExample', Array.from({length:6}, (_, i) => createExampleTile('white', null, i + 1)));
    mountHowTiles('howBlackExample', Array.from({length:4}, () => createExampleTile('black')));

    // Simple, three-tile natural melds keep wilds out of the introductory examples.
    mountHowTiles('howNumberMeldExample', [
      createExampleTile('normal', 0, 4),
      createExampleTile('normal', 3, 4),
      createExampleTile('normal', 5, 4),
    ]);
    mountHowTiles('howColorMeldExample', [
      createExampleTile('normal', 4, 1),
      createExampleTile('normal', 4, 3),
      createExampleTile('normal', 4, 6),
    ]);

    mountHowTiles('howNaturalCompletionExample', [
      createExampleTile('normal', 2, 1),
      createExampleTile('normal', 2, 2),
      createExampleTile('normal', 2, 3),
      createExampleTile('normal', 2, 4),
      createExampleTile('normal', 2, 5),
      createExampleTile('normal', 2, 6),
    ]);
    mountHowTiles('howMixedCompletionExample', [
      createExampleTile('normal', 0, 3),
      createExampleTile('blank', 1, null),
      createExampleTile('normal', 2, 3),
      createExampleTile('normal', 3, 3),
      createExampleTile('normal', 4, 3),
      createExampleTile('white', null, 3),
    ]);

    // Discard illustrations reuse the exact same pile-stack and tile renderer
    // as the game. Only the expanded inventory in the frozen illustration is
    // different; it is marked as an explanatory view, not normal game UI.
    function pile(top, count, status = '') {
      const shell = document.createElement('div');
      shell.className = 'how-pile pile-card subcard';
      const inner = document.createElement('div');
      const heading = document.createElement('div');
      heading.className = 'small muted';
      heading.textContent = 'Discard pile';
      const stack = document.createElement('div');
      stack.className = 'pile-stack';
      stack.style.margin = '6px auto 0';
      stack.append(tileElement(top));
      const countEl = document.createElement('div');
      countEl.className = 'pile-count';
      countEl.textContent = `${tileCount(count)}${status ? ` · ${status}` : ''}`;
      inner.append(heading, stack, countEl);
      shell.append(inner);
      return shell;
    }
    const normalPile = document.getElementById('howDiscardTakeExample');
    const blockedPile = document.getElementById('howBlackTopExample');
    const frozenPile = document.getElementById('howFrozenPileExample');
    normalPile.replaceChildren(pile(createExampleTile('normal', 0, 5), 3));
    blockedPile.replaceChildren(pile(createExampleTile('black'), 3, 'blocked'));

    const buried = [
      createExampleTile('normal', 3, 4), // visible top
      createExampleTile('normal', 0, 2),
      createExampleTile('white', null, 3), // wild underneath, so the pile stays frozen
      createExampleTile('normal', 2, 5),
    ];
    const contents = document.createElement('div');
    contents.className = 'how-pile-contents';
    const contentsTitle = document.createElement('strong');
    contentsTitle.textContent = 'Example contents (top to bottom)';
    contents.append(contentsTitle);
    const contentsList = document.createElement('div');
    contentsList.className = 'how-pile-contents-list';
    for (const [i, t] of buried.entries()) {
      const item = document.createElement('div');
      item.className = 'how-pile-contents-item';
      item.append(tileElement(t, {mini:true}));
      const position = document.createElement('span');
      position.textContent = i === 0 ? 'Top tile' : i === 2 ? 'Buried wild' : `Underneath`;
      item.append(position);
      contentsList.append(item);
    }
    const contentsNote = document.createElement('p');
    contentsNote.className = 'how-contents-note';
    contentsNote.textContent = 'Illustrative contents only — the full pile is not shown like this during gameplay.';
    contents.append(contentsList, contentsNote);
    frozenPile.replaceChildren(pile(buried[0], buried.length, 'frozen'), contents);
  }

  function serverAction(type, args = {}, optimistic = true) {
    if (!online.active || !canActOnline()) return;
    // Hidden information is never guessed locally. A draw / discard-pile pickup
    // must wait until the authoritative server supplies the result.
    if (!online.socket || online.socket.readyState !== WebSocket.OPEN) return;
    if (!optimistic && online.pending.length) return;
    const before=handPlayer().hand.map(t => t.id);
    const actionId=`${online.sessionNonce}:${online.nextActionId++}`;
    const packet={type:'action', action:type, actionId,
      expectedRevision:online.confirmed.revision+online.pending.length,
      handBefore:before, ...args};
    let outcome=null;
    try {
      if (optimistic) outcome=applyPredictedAction(packet);
      else {
        // Validate the *whole* operation against a temporary game state,
        // without changing what the user sees until the response arrives.
        const check=Object.create(Game.prototype);
        check.state=structuredClone(state);
        check.nextMeldId=game.nextMeldId;
        applyActionToGame(check,packet);
      }
    } catch(error) { showGameError(error); return; }
    online.pending.push(packet);
    if(!optimistic) online.busy=true;
    if(outcome?.winnerId !== undefined && outcome.winnerId !== null) online.waitingForFinish=true;
    if(optimistic) {ui.selected.clear();closeModal();render();}
    else {closeModal();render();}
    online.socket.send(JSON.stringify(packet));
  }

  function applyActionToGame(gameInstance, action) {
    switch(action.action) {
      case 'drawStock': return gameInstance.drawStock();
      case 'takePileExisting': return gameInstance.takePileExisting(action.meldId);
      case 'takePileNew': return gameInstance.takePileNew(action.tileIds,action.option);
      case 'createMeld': return gameInstance.createMeld(action.tileIds,action.option || null);
      case 'addToMeld': return gameInstance.addToMeld(action.meldId,action.tileIds);
      case 'discard': return gameInstance.discard(action.tileId);
      default: throw new GameError('action','Unknown game action.');
    }
  }
  function applyPredictedAction(packet) {return applyActionToGame(game,packet);}

  function shouldPlayTurnChime(previous, next, seatId, resyncing) {
    return !resyncing && !next.roundOver && !next.paused && next.currentPlayerId===seatId &&
      (!previous || previous.roundOver || previous.currentPlayerId!==seatId);
  }

  function receiveOnlineView(view, acknowledgedId = null) {
    if(!online.active) return;
    if (online.confirmed && view.revision < online.confirmed.revision) return;
    const notifyTurn=shouldPlayTurnChime(online.confirmed,view,online.playerId,online.awaitingResync);
    if (acknowledgedId !== null) {
      const idx=online.pending.findIndex(p=>p.actionId===acknowledgedId);
      if(idx>=0)online.pending.splice(0,idx+1);
    } else {
      // Non-ack snapshots usually come from the other player's actions;
      // preserve still-pending actions if there are any.
      if (online.pending.length && view.revision > online.confirmed.revision) return;
    }
    const previousHand=online.active && state?.players?.[online.playerId]?.hand?.filter(Boolean).map(t=>t.id) || online.handOrder;
    online.confirmed=view;
    online.awaitingResync=false;
    if(notifyTurn)playTurnNotificationSound();
    online.busy=online.pending.some(p=>['drawStock','takePileExisting','takePileNew'].includes(p.action));
    online.waitingForFinish=false;
    const players=view.players.map((p)=>({
      id:p.id,name:p.name,hand:p.id===online.playerId ? view.hand.map(t=>({...t})) : Array(p.handCount).fill(null),
      melds:structuredClone(p.melds),totalScore:p.totalScore,sort:p.id===online.playerId?online.sort:'color',
    }));
    const me=players[online.playerId];
    if (online.sort==='manual') {
      const byId=new Map(me.hand.map(t=>[t.id,t]));
      me.hand=[...previousHand.map(id=>{const tile=byId.get(id);byId.delete(id);return tile;}).filter(Boolean), ...byId.values()];
    } else sortHand(me,online.sort);
    const nextState={
      round:view.round,targetScore:view.targetScore,allowDuplicates:view.allowDuplicates,starter:view.starterId,
      current:view.currentPlayerId,phase:view.phase,roundOver:view.roundOver,
      stock:Array(view.stockCount).fill(null),discard:structuredClone(view.discard),
      discardFrozen:view.discardFrozen,players,discardedThisTurn:false, meldedOutThisTurn:false,
    };
    const projection=Object.create(Game.prototype);
    projection.state=nextState;
    projection.nextMeldId=view.nextMeldId;
    for(const action of online.pending) {
      try {
        const outcome=applyActionToGame(projection,action);
        if(outcome.winnerId!==null && outcome.winnerId!==undefined) online.waitingForFinish=true;
      } catch(error) {
        // A speculative move was made against a state that did not commit.
        online.pending.length=0;
        online.busy=false;
        online.waitingForFinish=false;
        break;
      }
    }
    game=projection;
    state=projection.state;
    const allIds=new Set(handPlayer().hand.map(t=>t.id));
    for(const id of ui.selected)if(!allIds.has(id))ui.selected.delete(id);
    online.handOrder=handPlayer().hand.map(t=>t.id);
    online.lobby=null;
    showScreen('gameScreen');
    document.getElementById('gameChatPanel').classList.remove('hidden');
    document.getElementById('onlineWaiting').classList.add('hidden');
    if(view.roundOver && view.results) {
      setRoundResultsVisible(true);
      if(online.viewRound!==view.round) {
        online.viewRound=view.round;
        const scores=view.results.results.map(r=>({
          player:{id:r.playerId,name:r.name,totalScore:r.totalScore,hand:[],melds:[]},
          out:r.out,concealedOut:r.concealedOut,penalty:r.penalty,delta:r.delta,publicDetail:r,
        }));
        const reached=scores.filter(r=>view.results.reachedPlayerIds.includes(r.player.id));
        const winners=scores.filter(r=>view.results.winnerPlayerIds.includes(r.player.id));
        renderRoundResults(scores,reached,winners,null,view.resultReason||'Round complete.',view.results.history||[]);
      }
    } else {
      online.viewRound=null;
      setRoundResultsVisible(false);
    }
    render();
  }

  function readOnlineSession() {
    try {return sessionStorage.getItem('crossmeldOnline');}catch{return null;}
  }
  function writeOnlineSession(value) {
    try {sessionStorage.setItem('crossmeldOnline',JSON.stringify(value));}catch{}
  }
  function clearOnlineSession() {
    try {sessionStorage.removeItem('crossmeldOnline');}catch{}
  }
  function onlineSend(data) {
    if(online.socket?.readyState===WebSocket.OPEN)online.socket.send(JSON.stringify(data));
  }
  function renderConnectionIndicator() {
    const socket=online.socket;
    const isOpen=online.connected && socket?.readyState === WebSocket.OPEN;
    const isConnecting=socket?.readyState === WebSocket.CONNECTING || online.reconnecting;
    const state=isOpen?'online':isConnecting?'connecting':'offline';
    const text=isOpen?`Connected · ${online.pingMs === null?'—':online.pingMs} ms`
      :isConnecting?(online.reconnecting?'Reconnecting…':'Connecting…'):'Not connected';
    document.querySelectorAll('[data-connection-indicator]').forEach(indicator=>{
      indicator.dataset.state=state;
      indicator.querySelector('.connection-label').textContent=text;
    });
  }
  function stopLatencyPings() {
    if(online.pingTimer!==null)clearInterval(online.pingTimer);
    online.pingTimer=null;
    online.pingPending.clear();
    online.pingMs=null;
    renderConnectionIndicator();
  }
  function sendLatencyPing(ws) {
    if(online.socket!==ws || ws.readyState!==WebSocket.OPEN)return;
    const id=++online.pingNextId;
    online.pingPending.set(id,performance.now());
    while(online.pingPending.size>4)online.pingPending.delete(online.pingPending.keys().next().value);
    ws.send(JSON.stringify({type:'latency_ping',id}));
  }
  function startLatencyPings(ws) {
    stopLatencyPings();
    sendLatencyPing(ws);
    online.pingTimer=setInterval(()=>sendLatencyPing(ws),5000);
  }
  function receiveLatencyPong(message) {
    const sentAt=online.pingPending.get(message.id);
    if(sentAt===undefined)return;
    online.pingPending.delete(message.id);
    online.pingMs=Math.max(0,Math.round(performance.now()-sentAt));
    renderConnectionIndicator();
  }
  function showOnlineWaiting(text) {
    const node=document.getElementById('onlineWaiting');
    node.classList.remove('hidden');
    node.textContent=text;
  }
  // The list always includes Random and only seats available for the chosen player count.
  function updateFirstPlayerOptions(select, count, preferred = select.value) {
    select.innerHTML = '<option value="random">Random</option>' +
      Array.from({length:count},(_,i)=>`<option value="${i}">Player ${i+1}</option>`).join('');
    select.value = preferred==='random' || (Number.isInteger(Number(preferred)) &&
      String(Number(preferred))===String(preferred) && Number(preferred)>=0 && Number(preferred)<count)
      ? String(preferred) : 'random';
  }
  function selectedFirstPlayer(select) {
    return select.value==='random'?'random':Number(select.value);
  }
  function beginOnline(kind, code='') {
    const url=onlineSocketURL();
    if(!url)return showInfo('Online play requires a server',
      'Use the published website or run npm install and npm run online locally. Local Play still works directly from disk.');
    stopLatencyPings();
    if(online.socket && online.socket.readyState===WebSocket.OPEN)online.socket.close();
    online.active=true;
    const name=document.getElementById('onlineName').value.trim().slice(0,20);
    if(kind!=='resume' && !name)return showOnlineWaiting('Please enter a username.');
    online.connected=false;
    online.reconnecting=kind==='resume';
    online.awaitingResync=kind==='resume';
    online.awaitingChatResync=kind==='resume';
    if(kind!=='resume')online.lastChatMessageId=null;
    const ws=new WebSocket(url);
    online.socket=ws;
    renderConnectionIndicator();
    showOnlineWaiting(kind==='create'?'Creating online match…':kind==='resume'?'Reconnecting…':'Joining match…');
    ws.addEventListener('open',()=>{
      online.connected=true;
      online.reconnecting=false;
      renderConnectionIndicator();
      startLatencyPings(ws);
      if(kind==='resume')onlineSend({type:'resume',code:online.roomCode,token:online.token});
      else onlineSend(kind==='create'?{type:'create',name}:{type:'join',name,code:code.trim().toUpperCase()});
    });
    ws.addEventListener('message',event=>{
      let msg;try{msg=JSON.parse(event.data);}catch{return;}
      // Ignore late events from sockets we have already detached from.
      if(online.socket!==ws)return;
      if(msg.type==='latency_pong'){receiveLatencyPong(msg);return;}
      if(msg.type==='welcome'){
        if(online.roomCode && online.roomCode!==msg.roomCode)online.lastChatMessageId=null;
        online.roomCode=msg.roomCode;
        online.token=msg.token;
        online.playerId=msg.seatId;
        writeOnlineSession({code:msg.roomCode,token:msg.token});
      }else if(msg.type==='lobby'){
        renderLobby(msg.lobby);
      }else if(msg.type==='roomMessages'){
        renderRoomMessages(msg.messages);
      }else if(msg.type==='roomClosed'){
        const initiated=online.closing;
        resetOnline();
        if(!initiated)showInfo('Room closed',escapeHtml(msg.message||'The host closed the room.'));
      }else if(msg.type==='left'){
        resetOnline();
      }else if(msg.type==='state'){
        receiveOnlineView(msg.view);
      }else if(msg.type==='ack'){
        receiveOnlineView(msg.view,msg.id);
      }else if(msg.type==='rejected'){
        online.pending.length=0;online.busy=false;online.waitingForFinish=false;
        receiveOnlineView(msg.view);
        showInfo('Move rejected',escapeHtml(msg.message||'The server could not accept that action.'));
      }else if(msg.type==='error'){
        online.leaving=false;online.closing=false;
        if(!online.lobby && !state)showOnlineWaiting(`Online error: ${msg.message}`);
        else showInfo('Online error',escapeHtml(msg.message));
      }
    });
    ws.addEventListener('close',()=>{
      if(online.socket!==ws)return;
      stopLatencyPings();
      if(online.leaving || online.closing){resetOnline();return;}
      online.connected=false;
      online.reconnecting=Boolean(online.roomCode && online.token);
      renderConnectionIndicator();
      online.pending.length=0;online.busy=true;
      online.waitingForFinish=false;
      if(state)render();
      else if(online.lobby)document.getElementById('lobbySettingsNote').textContent='Connection lost. Trying to reconnect…';
      else showOnlineWaiting('Connection lost. Trying to reconnect…');
      if(online.roomCode && online.token && !online.retryTimer){
        online.retryTimer=setTimeout(()=>{online.retryTimer=null;beginOnline('resume');},1800);
      }else if(!online.roomCode){online.active=false;showOnlineWaiting('Connection failed. Check that the online server is running, then try again.');}
    });
    ws.addEventListener('error',()=>{if(online.socket===ws && !online.connected)renderConnectionIndicator();});
  }
  // Browser-only state (selection, expansion, ordering) stays outside the game engine.
  function startGame() {
    const count = Number(els.playerCount.value);
    const target = Math.round(clamp(Number(els.targetScore.value) || DEFAULT_TARGETS[count], 100, 10000));
    const names = Array.from({ length: count }, (_, i) => `Player ${i + 1}`);
    const requestedFirst=selectedFirstPlayer(els.localFirstPlayer);
    const firstPlayer=requestedFirst==='random'?Math.floor(Math.random()*count):requestedFirst;
    game = new Game({ names, targetScore: target, firstPlayer, allowDuplicates: els.localAllowDuplicates.value === 'true' });
    state = game.state;
    ui.selected = new Set();
    ui.expandedMelds = new Set();
    state.players.forEach(p => { p.sort = 'color'; });
    showScreen('gameScreen');
    document.getElementById('gameChatPanel').classList.add('hidden');
    startRound(true);
  }

  function startRound(firstRound = false, nextRound = false) {
    if (nextRound) game.nextRound(); else game.startRound();
    ui.selected.clear();
    ui.expandedMelds.clear();
    sortAllHands();
    setRoundResultsVisible(false);
    setMessage(`${currentPlayer().name} starts. Draw ${state.stock.length >= 2 ? '2 tiles' : 'from the stock'} or take the discard pile.`);
    render();
    window.scrollTo(0, 0);
    showPassModal(currentPlayer().name, firstRound ? 'Start game' : `Round ${state.round}`);
  }

  function selectedNewMeldOptions(top, frozenOnly = false) {
    return CrossmeldRules.selectedNewMeldOptions(selectedTiles(), top, frozenOnly, state.allowDuplicates);
  }

  function hasAnyTakeOption(player) {
    return CrossmeldRules.hasAnyTakeOption(player, state.discard, state.discardFrozen, requiredCompletedMelds(state.players.length), state.allowDuplicates);
  }

  function showGameError(error) {
    if (!(error instanceof GameError)) throw error;
    const titles = {
      'meld':'Not a legal meld', 'black':'Black tiles can only be melded when going out',
      'go-out':'You cannot go out yet', 'stranded':'No legal way to finish the turn', 'discard-required':'You must discard to end your turn', 'fit':'Those tiles do not fit', 'duplicates':'Duplicate identities not allowed',
      'wilds':'Too many wilds', 'pickup':'Cannot take the discard pile',
    };
    showInfo(titles[error.code] || 'Invalid action', escapeHtml(error.message));
  }

  function drawFromStock() {
    if(online.active)return serverAction('drawStock',{},false);
    try {
      const { drawn } = game.drawStock();
      const p = currentPlayer();
      sortHand(p);
      ui.selected.clear();
      setMessage(`${p.name} drew ${tileCount(drawn.length)}. Meld if you want, then discard one.`);
      render();
    } catch (error) { showGameError(error); }
  }

  function takePileIntoExisting(meldId) {
    if(online.active)return serverAction('takePileExisting',{meldId},false);
    try {
      const p = currentPlayer();
      const { meld, completedNow, winnerId } = game.takePileExisting(meldId);
      sortHand(p);
      ui.selected.clear();
      closeModal();
      if (winnerId !== null) return endRound(winnerId, `${p.name} went out by taking the discard pile.`);
      setMessage(`${p.name} took the discard pile and added the top tile to ${meldName(meld)}${completedNow ? `, completing it ${meld.completion}` : ''}.`);
      render();
    } catch (error) { showGameError(error); }
  }

  function takePileIntoNew(option) {
    if(online.active)return serverAction('takePileNew',{tileIds:selectedTiles().map(t=>t.id),option},false);
    try {
      const p = currentPlayer();
      const { meld, winnerId } = game.takePileNew(selectedTiles().map(t => t.id), option);
      sortHand(p);
      ui.selected.clear();
      closeModal();
      if (winnerId !== null) return endRound(winnerId, `${p.name} took the discard pile, completed the play, and went out.`);
      setMessage(`${p.name} took the discard pile and started ${meldName(meld)}.`);
      render();
    } catch (error) { showGameError(error); }
  }

  function createSelectedMeld() {
    if (state.phase !== 'play' || !canActOnline()) return;
    const selected = selectedTiles();
    const p = currentPlayer();
    if (selected.length >= 3 && selected.every(t => t.kind === 'black')) {
      if(online.active)return serverAction('createMeld',{tileIds:selected.map(t=>t.id)});
      try {
        const result = game.createMeld(selected.map(t => t.id));
        ui.selected.clear();
        if (result.winnerId !== null) return endRound(result.winnerId, `${p.name} went out by melding their remaining black tiles.`);
        render();
      } catch (error) { showGameError(error); }
      return;
    }
    const options = candidateMelds(selected, state.allowDuplicates);
    if (!options.length) return showInfo('Not a legal meld', `A meld needs 3+ tiles sharing one number or one color, at least 2 natural tiles, and no more than 2 wilds.${state.allowDuplicates ? '' : ' Each identity must be unique (no duplicates).'} Black tiles can only be melded together when doing so makes you go out.`);
    const remaining = p.hand.length - selected.length;
    const legalOptions = options.filter(o => remaining > 1 || canGoOut(p, state.players.length,
      completionState({ ...o, tiles: selected }) ? 1 : 0));
    if (!legalOptions.length) return showInfo('No legal way to finish the turn',
      `You cannot leave yourself with one tile unless you have enough completed melds to go out (${requiredCompletedMelds(state.players.length)} needed). A new completion made by this play counts.`);
    if (legalOptions.length === 1) return finalizeNewMeld(legalOptions[0]);
    showChoice('Choose meld type', 'These tiles can legally form more than one kind of meld.', legalOptions.map(o => ({
      label: o.type === 'number' ? `Number meld: ${o.target}s` : `Color meld: ${COLORS[o.target].name}`,
      action: () => finalizeNewMeld(o),
    })));
  }

  function finalizeNewMeld(option) {
    if(online.active)return serverAction('createMeld',{tileIds:selectedTiles().map(t=>t.id),option});
    try {
      const p = currentPlayer();
      const { meld, completedNow, winnerId } = game.createMeld(selectedTiles().map(t => t.id), option);
      ui.selected.clear();
      closeModal();
      if (winnerId !== null) return endRound(winnerId, `${p.name} went out.`);
      setMessage(`${p.name} made a new ${meldName(meld)} meld${completedNow ? ` and completed it ${meld.completion}` : ''}.`);
      render();
    } catch (error) { showGameError(error); }
  }

  function addSelectedToMeld(meldId) {
    if (state.phase !== 'play' || !canActOnline()) return;
    const p = currentPlayer();
    const selected = selectedTiles();
    if (!selected.length) return;
    if(online.active)return serverAction('addToMeld',{meldId,tileIds:selected.map(t=>t.id)});
    try {
      const { meld, completedNow, winnerId } = game.addToMeld(meldId, selected.map(t => t.id));
      ui.selected.clear();
      if (winnerId !== null) return endRound(winnerId, `${p.name} went out.`);
      setMessage(`${p.name} added ${tileCount(selected.length)} to ${meldName(meld)}${completedNow ? `, completing it ${meld.completion}` : ''}.`);
      render();
    } catch (error) { showGameError(error); }
  }

  function discardSelected() {
    if (state.phase !== 'play' || ui.selected.size !== 1 || !canActOnline()) return;
    if(online.active)return serverAction('discard',{tileId:selectedTiles()[0].id});
    try {
      const p = currentPlayer();
      const tile = selectedTiles()[0];
      const result = game.discard(tile.id);
      ui.selected.clear();
      if (result.winnerId !== null) return endRound(result.winnerId, `${p.name} went out by discarding the last tile.`);
      setMessage(`${p.name} discarded ${tileAria(tile)}.`);
      advanceTurn();
    } catch (error) { showGameError(error); }
  }

  function advanceTurn() {
    const { roundEnds } = game.advanceTurn();
    ui.selected.clear();
    render();
    const p = currentPlayer();
    if (roundEnds) return endRound(null, `The stock is empty and ${p.name} cannot legally take the discard pile.`);
    setMessage(state.stock.length ? `${p.name}'s turn. Draw from the stock or take the discard pile.` : `${p.name}'s turn. The stock is empty, so the discard pile must be taken.`);
    render();
    showPassModal(p.name, 'Next turn');
  }

  // Round results are a dedicated game screen, not a modal over a visible hand.
  // Only actual game actions change the score; presentation uses those exact
  // authoritative round results rather than calculating a new score.
  function setRoundResultsVisible(visible) {
    els.roundResults.classList.toggle('hidden', !visible);
    els.playersArea.classList.toggle('hidden', visible);
    els.tableZone.classList.toggle('hidden', visible);
    els.handCard.classList.toggle('hidden', visible);
    if (!visible) els.roundResults.replaceChildren();
  }

  function scoreDetail(result) {
    if(result.publicDetail){
      const r=result.publicDetail;
      return {normalCount:r.normalTiles,specialCount:r.specialTiles,
        naturalCount:r.naturalCompletions,mixedCount:r.mixedCompletions,
        handNormal:r.normalLeft,handSpecial:r.specialLeft,
        normalPoints:r.normalTiles*5,specialPoints:r.specialTiles*10,
        naturalPoints:r.naturalCompletions*100,mixedPoints:r.mixedCompletions*60,
        previousTotal:r.previousScore};
    }
    const melded = result.player.melds.flatMap(m => m.tiles);
    const normalCount = melded.filter(t => t.kind === 'normal').length;
    const specialCount = melded.length - normalCount;
    const naturalCount = result.player.melds.filter(m => m.completion === 'natural').length;
    const mixedCount = result.player.melds.filter(m => m.completion === 'mixed').length;
    const handNormal = result.player.hand.filter(t => t.kind === 'normal').length;
    const handSpecial = result.player.hand.length - handNormal;
    const detail = {
      normalCount, specialCount, naturalCount, mixedCount, handNormal, handSpecial,
      normalPoints: normalCount * 5, specialPoints: specialCount * 10,
      naturalPoints: naturalCount * 100, mixedPoints: mixedCount * 60,
      previousTotal: result.player.totalScore - result.delta,
    };
    // This also makes the breakdown robust if a future deck is rebalanced.
    // Existing scores come only from the engine's result values.
    return detail;
  }

  // Scores read as a ledger: old score + earned points - penalties = new score.
  // A category with zero contribution is omitted entirely.
  function resultLine(label, detail, points) {
    if (!points) return '';
    const negative = points < 0;
    const sign = negative ? '−' : '+';
    return `<div class="results-score-line">
      <div class="results-score-description">
        <div><span class="results-score-label">${escapeHtml(label)}</span>
          <span class="results-score-note">${escapeHtml(detail)}</span></div>
      </div>
      <strong class="results-score-points${negative ? ' results-negative' : ''}">${sign}${Math.abs(points).toLocaleString()}</strong>
    </div>`;
  }

  function renderMatchStandings(results, winners, history) {
    const finalRanks = [...results].sort((a,b) => b.player.totalScore-a.player.totalScore || a.player.id-b.player.id);
    const winnersById = new Set(winners.map(r=>r.player.id));
    const highest = Math.max(1,...finalRanks.map(r=>Math.abs(r.player.totalScore)));
    const standings = finalRanks.map(r => {
      const score = r.player.totalScore;
      const percent = score === 0 ? 0 : Math.max(1.5,Math.abs(score)/highest*100);
      const place=finalRanks.findIndex(other=>other.player.totalScore===score)+1;
      return `<div class="results-standing subcard${winnersById.has(r.player.id)?' leader':''}">
        <div class="results-standing-name">${escapeHtml(r.player.name)}
          ${winnersById.has(r.player.id)?'<span class="results-standing-detail">Match winner</span>':''}
        </div>
        <div class="results-standing-bar" aria-label="${Math.abs(score).toLocaleString()} total match points${score<0?' below zero':''}">
          ${score !== 0 ? `<div class="results-standing-fill${score<0?' loss':''}" style="width:${percent.toFixed(2)}%"></div>` : ''}
        </div>
        <span class="results-standing-value${score<0?' results-negative':''}">${score.toLocaleString()}</span>
        <span class="results-standing-running">${place}${place===1?'st':place===2?'nd':place===3?'rd':'th'} place</span>
      </div>`;
    }).join('');
    
    const rows = history.map(h => {
      const scores=new Map(h.scores.map(s=>[s.playerId,s.delta]));
      return `<tr><th scope="row">Round ${h.round}</th>${finalRanks.map(r => {
        const delta=scores.get(r.player.id)??0;
        return `<td class="${delta<0?'results-negative':''}">${delta>=0?'+':''}${delta.toLocaleString()}</td>`;
      }).join('')}</tr>`;
    }).join('');
    return `<section class="results-section card" aria-label="Match standings">
      <h2>Match standings</h2>
      <div class="results-standing-list">${standings}</div>
      <h3 class="results-history-heading">Round-by-round scores</h3>
      <div class="results-history-scroll"><table class="results-history-table">
        <thead><tr><th scope="col">Round</th>${finalRanks.map(r=>`<th scope="col">${escapeHtml(r.player.name)}</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><th scope="row">Final score</th>${finalRanks.map(r=>`<td>${r.player.totalScore.toLocaleString()}</td>`).join('')}</tr></tfoot>
      </table></div>
    </section>`;
  }

  function renderRoundResults(results, reached, winners, winnerId, reason, history = []) {
    const ranked = [...results].sort((a, b) => b.delta - a.delta ||
      b.player.totalScore - a.player.totalScore || a.player.id - b.player.id);
    const finishedMatch = reached.length > 0;
    const title = finishedMatch ? 'Match complete' : `Round ${state.round} complete`;
    const matchNames = winners.map(r => r.player.name).join(' & ');
    const summary = finishedMatch ? `Match winner${winners.length !== 1 ? 's' : ''}: ${matchNames}.` : '';

    // All bars share one scale so the relative round results are visible.
    const largestMagnitude = Math.max(1, ...ranked.map(r => Math.abs(r.delta)));
    const standings = ranked.map((r,i) => {
      const percent = Math.max(r.delta === 0 ? 0 : 1.5, Math.abs(r.delta) / largestMagnitude * 100);
      return `<div class="results-standing subcard${i === 0 ? ' leader' : ''}">
        <div class="results-standing-name">${escapeHtml(r.player.name)}
          ${r.out ? `<span class="results-standing-detail">${r.concealedOut ? 'Concealed out' : 'Went out'}</span>` : ''}
        </div>
        <div class="results-standing-bar" aria-label="${Math.abs(r.delta).toLocaleString()} points ${r.delta < 0 ? 'lost' : 'earned'} this round">
          ${r.delta !== 0 ? `<div class="results-standing-fill${r.delta < 0 ? ' loss' : ''}" style="width:${percent.toFixed(2)}%"></div>` : ''}
        </div>
        <span class="results-standing-value${r.delta < 0 ? ' results-negative' : ''}">${signed(r.delta)}</span>
        <span class="results-standing-running">${r.player.totalScore.toLocaleString()} total</span>
      </div>`;
    }).join('');

    els.roundResults.innerHTML = `
      <section class="results-intro card">
        <h1 id="roundResultsTitle">${title}</h1>
        <p>${escapeHtml(reason)}${summary ? ` ${escapeHtml(summary)}` : ''}</p>
      </section>
      <section class="results-section card" aria-label="Round standings">
        <h2>Round standings</h2>
        <div class="results-standing-list">${standings}</div>
      </section>
      <section class="results-section card" aria-label="Detailed round scores">
        <h2>Score breakdown</h2>
        <div class="results-breakdown">${ranked.map(r => {
          const d = scoreDetail(r);
          return `<article class="results-player subcard">
            <div class="results-player-head">
              <h3>${escapeHtml(r.player.name)}</h3>
            </div>
            <div class="results-score-start"><span>Old score</span><strong>${d.previousTotal.toLocaleString()}</strong></div>
            ${resultLine('Natural tiles', `${d.normalCount} × 5 points`, d.normalPoints)}
            ${resultLine('Special tiles', `${d.specialCount} × 10 points`, d.specialPoints)}
            ${resultLine('Natural completions', `${d.naturalCount} × 100 points`, d.naturalPoints)}
            ${resultLine('Mixed completions', `${d.mixedCount} × 60 points`, d.mixedPoints)}
            ${resultLine(r.concealedOut ? 'Concealed going out' : 'Going out', 'Going-out bonus', r.out)}
            ${resultLine('Tiles left in hand', `${d.handNormal} natural · ${d.handSpecial} special`, -r.penalty)}
            <div class="results-score-end"><span>New score</span>
              <strong>${r.player.totalScore.toLocaleString()}</strong></div>
          </article>`;
        }).join('')}</div>
      </section>
      ${finishedMatch ? renderMatchStandings(results,winners,history) : ''}
      <div class="results-footer">
        <button id="resultsNextBtn" type="button" class="primary">${finishedMatch ? (online.active?'Return to lobby':'Abort game') : 'Next round'}</button>
      </div>`;

    if(online.active && online.playerId !== 0) {
      const button=els.roundResults.querySelector('#resultsNextBtn');
      button.textContent='Waiting for host…';
      button.disabled=true;
    }
    els.roundResults.querySelector('#resultsNextBtn').addEventListener('click', () => {
      if(online.active){
        if(online.playerId===0)onlineSend({type:finishedMatch?'abortMatch':'nextRound'});
        else showInfo('Waiting for host','The host will start the next round.');
      } else if(finishedMatch)abortLocalGame();
      else startRound(false, true);
    });
  }

  function endRound(winnerId, reason) {
    if (state.roundOver) return;
    const { results, reached, winners } = game.finishRound(winnerId);
    ui.selected.clear();
    stopHandMomentum();
    setRoundResultsVisible(true);
    renderRoundResults(results, reached, winners, winnerId, reason, game.state.roundHistory);
    render();
    window.scrollTo(0, 0);
  }

  function setMessage(msg) { ui.message = msg; }

  function render() {
    if (!state) return;
    const host=online.active && online.confirmed?.isHost;
    document.querySelector('.topbar').classList.toggle('host-controls',!!host);
    els.gameAbortBtn.classList.toggle('hidden',online.active && !host);
    els.newGameBtn.classList.toggle('hidden',!online.active);
    els.newGameBtn.textContent='Leave room';
    els.roundLabel.textContent = `Round ${state.round} · First to ${state.targetScore} points`;
    els.statusLine.innerHTML = '';
    if (state.roundOver) {
      addPill(`Round ${state.round} results`, 'good');
      return; // Only the header + results screen remain after a round.
    }
    addPill(`${currentPlayer().name}'s turn`, 'good');
    if(online.active) {
      addPill(`Room ${online.roomCode||'—'}`);
      if(!online.connected)addPill('Reconnecting…','warn');
      else if(online.confirmed?.paused)addPill('Waiting for player','warn');
    }
    addPill(`Stock ${state.stock.length}`);
    addPill(`Discard ${state.discard.length}`);
    if (state.discardFrozen) addPill('Discard frozen', 'warn');
    if (state.discard.length && state.discard[state.discard.length-1].kind === 'black') addPill('Black on top', 'danger');
    renderPlayers();
    renderTable();
    renderHand();
  }

  function addPill(text, cls = '') {
    const span = document.createElement('span');
    span.className = `pill ${cls}`;
    span.textContent = text;
    els.statusLine.append(span);
  }

  function renderPlayers() {
    els.playersArea.innerHTML = '';
    state.players.forEach((p, idx) => {
      const panel = document.createElement('section');
      panel.className = `player-panel card${idx === state.current ? ' current' : ''}`;
      const head = document.createElement('div');
      head.className = 'player-summary';
      const left = document.createElement('div');
      left.innerHTML = `<div class="player-name">${escapeHtml(p.name)}</div><div class="scoreline"><span class="score-piece">${tileCount(p.hand.length)} in hand</span> · <span class="score-piece">${p.totalScore} points total</span> · <span class="score-piece">${provisionalRoundScore(p)} points on table</span></div>`;
      const right = document.createElement('span');
      const eligible = canGoOut(p, state.players.length);
      right.className = `pill ${eligible ? 'good' : ''}`;
      right.textContent = eligible ? 'Can go out' : `${p.melds.length} meld${p.melds.length === 1 ? '' : 's'}`;
      head.append(left,right);
      panel.append(head);
      const list = document.createElement('div');
      list.className = 'meld-list';
      if (!p.melds.length) {
        const empty = document.createElement('div');
        empty.className = 'tiny muted';
        empty.textContent = 'No melds yet.';
        list.append(empty);
      } else {
        p.melds.forEach(m => list.append(renderMeld(p,m, idx === state.current && isMyTurn())));
      }
      panel.append(list);
      if (idx === state.current && state.phase === 'play' && !state.roundOver && canActOnline()) {
        const target = document.createElement('div');
        target.className = `new-meld-target${ui.selected.size >= 3 ? ' ready' : ''}`;
        target.dataset.dropAction = 'new-meld';
        target.setAttribute('role','button');
        target.tabIndex = 0;
        target.textContent = 'New meld';
        const activate = () => {
          if (ui.selected.size >= 3) createSelectedMeld();
          else setMessage('Select at least 3 tiles, then tap this area or drag the selected tiles here.');
        };
        target.addEventListener('click', activate);
        target.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
        });
        panel.append(target);
      }
      els.playersArea.append(panel);
    });
  }

  function meldPreviewTiles(meld) {
    if (meld.type === 'black') return meld.tiles.slice(0, 6);

    const chosen = [];
    const usedIds = new Set();

    if (meld.type === 'number') {
      // Each preview slot represents a color. Natural tiles always win that slot.
      for (let color = 0; color < 6; color++) {
        const natural = meld.tiles.find(t => t.kind === 'normal' && t.number === meld.target && t.color === color);
        if (natural) {
          chosen.push(natural);
          usedIds.add(natural.id);
        }
      }
      // Then use fixed-color blanks for colors that still lack a representative.
      for (let color = 0; color < 6; color++) {
        if (chosen.some(t => t.color === color && (t.kind === 'normal' || t.kind === 'blank'))) continue;
        const blank = meld.tiles.find(t => t.kind === 'blank' && t.color === color && !usedIds.has(t.id));
        if (blank) {
          chosen.push(blank);
          usedIds.add(blank.id);
        }
      }
      // White tiles are flexible-color wilds; assign them only to still-missing colors.
      let flex = meld.tiles.filter(t => t.kind === 'white' && t.number === meld.target && !usedIds.has(t.id));
      const represented = new Set(chosen.map(t => t.color).filter(c => c !== null));
      for (let color = 0; color < 6 && flex.length; color++) {
        if (represented.has(color)) continue;
        const tile = flex.shift();
        chosen.push(tile);
        usedIds.add(tile.id);
        represented.add(color);
      }

      // Keep the visible preview ordered by represented color. Flexible white tiles
      // fill the earliest missing colors, matching the completion/slot logic.
      const result = [];
      const naturalsOrBlanks = new Map();
      chosen.forEach(t => { if (t.color !== null) naturalsOrBlanks.set(t.color, t); });
      const whites = chosen.filter(t => t.kind === 'white');
      let wi = 0;
      for (let color = 0; color < 6; color++) {
        if (naturalsOrBlanks.has(color)) result.push(naturalsOrBlanks.get(color));
        else if (wi < whites.length) result.push(whites[wi++]);
      }
      return result;
    }

    // Color meld: each preview slot represents a number. Natural tiles win first.
    for (let number = 1; number <= 6; number++) {
      const natural = meld.tiles.find(t => t.kind === 'normal' && t.color === meld.target && t.number === number);
      if (natural) {
        chosen.push(natural);
        usedIds.add(natural.id);
      }
    }
    // Fixed-number white tiles are the next-best representative for that number.
    for (let number = 1; number <= 6; number++) {
      if (chosen.some(t => t.number === number && (t.kind === 'normal' || t.kind === 'white'))) continue;
      const white = meld.tiles.find(t => t.kind === 'white' && t.number === number && !usedIds.has(t.id));
      if (white) {
        chosen.push(white);
        usedIds.add(white.id);
      }
    }
    // Colored blanks are flexible-number wilds; assign only to missing numbers.
    let flex = meld.tiles.filter(t => t.kind === 'blank' && t.color === meld.target && !usedIds.has(t.id));
    const represented = new Set(chosen.map(t => t.number).filter(n => n !== null));
    for (let number = 1; number <= 6 && flex.length; number++) {
      if (represented.has(number)) continue;
      const tile = flex.shift();
      chosen.push(tile);
      usedIds.add(tile.id);
      represented.add(number);
    }

    const result = [];
    const normalsOrWhites = new Map();
    chosen.forEach(t => { if (t.number !== null) normalsOrWhites.set(t.number, t); });
    const blanks = chosen.filter(t => t.kind === 'blank');
    let bi = 0;
    for (let number = 1; number <= 6; number++) {
      if (normalsOrWhites.has(number)) result.push(normalsOrWhites.get(number));
      else if (bi < blanks.length) result.push(blanks[bi++]);
    }
    return result;
  }

  function expandedMeldTiles(meld) {
    const tiles = [...meld.tiles];
    if (meld.type === 'black') return tiles;

    // Work out the current effective assignment of flexible wilds before sorting.
    // Naturals/fixed-axis tiles take precedence; flexible wilds fill the earliest
    // still-missing slot, matching the preview and completion logic.
    const assigned = new Map();

    if (meld.type === 'color') {
      const represented = new Set();
      for (const t of tiles) {
        if (t.number !== null) {
          represented.add(t.number);
          assigned.set(t.id, t.number);
        }
      }
      const blanks = tiles.filter(t => t.kind === 'blank' && t.color === meld.target);
      const missing = [];
      for (let n = 1; n <= 6; n++) if (!represented.has(n)) missing.push(n);
      blanks.forEach((t, i) => assigned.set(t.id, missing[i] ?? 99));
    } else {
      const represented = new Set();
      for (const t of tiles) {
        if (t.color !== null) {
          represented.add(t.color);
          assigned.set(t.id, t.color);
        }
      }
      const whites = tiles.filter(t => t.kind === 'white' && t.number === meld.target);
      const missing = [];
      for (let c = 0; c < 6; c++) if (!represented.has(c)) missing.push(c);
      whites.forEach((t, i) => assigned.set(t.id, missing[i] ?? 99));
    }

    const kindRank = { normal: 0, blank: 1, white: 1, black: 2 };
    tiles.sort((a, b) => {
      const av = assigned.get(a.id) ?? 99;
      const bv = assigned.get(b.id) ?? 99;
      if (av !== bv) return av - bv;

      // For duplicate positions, show a natural before a wild.
      const ak = kindRank[a.kind] ?? 9;
      const bk = kindRank[b.kind] ?? 9;
      if (ak !== bk) return ak - bk;
      return a.id - b.id;
    });
    return tiles;
  }

  function renderMeld(player, meld, isCurrent) {
    const details = document.createElement('details');
    details.className = `meld${isCurrent && state.phase === 'play' && ui.selected.size > 0 && meld.type !== 'black' ? ' accepts-selection' : ''}`;
    if (isCurrent && meld.type !== 'black') {
      details.dataset.dropAction = 'meld';
      details.dataset.meldId = String(meld.id);
    }
    const openKey = `${player.id}:${meld.id}`;
    details.open = ui.expandedMelds.has(openKey);
    details.addEventListener('toggle', () => {
      if (details.open) ui.expandedMelds.add(openKey);
      else ui.expandedMelds.delete(openKey);
    });

    const summary = document.createElement('summary');
    const main = document.createElement('div');
    main.className = 'meld-summary-main';
    const title = document.createElement('div');
    title.className = 'meld-title';
    // The X/6 progress already conveys the meld size when duplicates are
    // disabled. Black going-out melds are exempt: they have no X/6 progress.
    const showTileCount = state.allowDuplicates || meld.type === 'black';
    title.innerHTML = `<strong>${escapeHtml(meldName(meld))}</strong>${showTileCount ? `<span class="tiny muted">${tileCount(meld.tiles.length)}</span>` : ''}`;

    const preview = document.createElement('div');
    preview.className = 'meld-preview';
    meldPreviewTiles(meld).forEach(t => {
      const tile = tileElement(t, { mini: true });
      tile.classList.add('tile-preview');
      preview.append(tile);
    });
    main.append(title, preview);

    const tag = document.createElement('span');
    const hasWild = meld.tiles.some(t => t.kind === 'blank' || t.kind === 'white');
    const meldClass = meld.completion || (hasWild ? 'mixed' : 'natural');
    tag.className = `pill meld-status ${meld.completion ? 'good' : ''}`;
    if (meld.type === 'black') {
      tag.textContent = 'Final meld';
    } else if (meld.completion === 'natural') {
      tag.textContent = 'Natural +100';
    } else if (meld.completion === 'mixed') {
      tag.textContent = 'Mixed +60';
    } else {
      tag.textContent = `${meldClass === 'natural' ? 'Natural' : 'Mixed'} · ${completionProgress(meld)}/6`;
    }
    summary.append(main, tag);
    summary.addEventListener('click', (e) => {
      if (isCurrent && state.phase === 'play' && ui.selected.size > 0 && meld.type !== 'black') {
        e.preventDefault();
        addSelectedToMeld(meld.id);
      }
    });
    details.append(summary);

    const body = document.createElement('div');
    body.className = 'meld-body';
    const tiles = document.createElement('div');
    tiles.className = 'meld-expanded-tiles';
    expandedMeldTiles(meld).forEach(t => tiles.append(tileElement(t, { mini: true })));
    body.append(tiles);
    details.append(body);
    return details;
  }

  function completionProgress(meld) {
    if (meld.type === 'number') {
      const fixed = new Set(); let flex = 0;
      meld.tiles.forEach(t => {
        if (!isCompatible(t,'number',meld.target)) return;
        if (t.kind === 'normal' || t.kind === 'blank') fixed.add(t.color);
        else if (t.kind === 'white') flex++;
      });
      return Math.min(6, fixed.size + flex);
    }
    const fixed = new Set(); let flex = 0;
    meld.tiles.forEach(t => {
      if (!isCompatible(t,'color',meld.target)) return;
      if (t.kind === 'normal' || t.kind === 'white') fixed.add(t.number);
      else if (t.kind === 'blank') flex++;
    });
    return Math.min(6, fixed.size + flex);
  }

  function renderSlotStrip(meld) {
    const strip = document.createElement('div');
    strip.className = 'slot-strip';
    if (meld.type === 'number') {
      const fixed = new Set(); let flex = 0;
      meld.tiles.forEach(t => {
        if (t.kind === 'normal' || t.kind === 'blank') fixed.add(t.color);
        if (t.kind === 'white') flex++;
      });
      const remaining = [];
      for (let c=0;c<6;c++) if (!fixed.has(c)) remaining.push(c);
      const flexFilled = new Set(remaining.slice(0,flex));
      for (let c=0;c<6;c++) {
        const s = document.createElement('div');
        s.className = `slot ${(fixed.has(c)||flexFilled.has(c)) ? 'filled' : ''}`;
        s.style.borderColor = `hsl(${COLORS[c].hue} 60% 50%)`;
        s.textContent = COLORS[c].name.slice(0,1);
        strip.append(s);
      }
    } else {
      const fixed = new Set(); let flex = 0;
      meld.tiles.forEach(t => {
        if (t.kind === 'normal' || t.kind === 'white') fixed.add(t.number);
        if (t.kind === 'blank') flex++;
      });
      const remaining = [];
      for (let n=1;n<=6;n++) if (!fixed.has(n)) remaining.push(n);
      const flexFilled = new Set(remaining.slice(0,flex));
      for (let n=1;n<=6;n++) {
        const s = document.createElement('div');
        s.className = `slot ${(fixed.has(n)||flexFilled.has(n)) ? 'filled' : ''}`;
        s.textContent = String(n);
        strip.append(s);
      }
    }
    return strip;
  }

  function renderTable() {
    const p = handPlayer();
    const canDraw = isMyTurn() && !online.busy && state.phase === 'draw' && state.stock.length > 0;
    const canTake = isMyTurn() && !online.busy && state.phase === 'draw' && hasAnyTakeOption(p);
    const canDiscard = canActOnline() && state.phase === 'play' && ui.selected.size === 1;

    els.stockCount.textContent = `${tileCount(state.stock.length)} remaining`;
    els.stockHint.textContent = canDraw ? (state.stock.length >= 2 ? 'Tap to draw 2' : 'Tap to draw the last tile') : '';
    els.stockPileCard.classList.toggle('action-ready', canDraw);
    els.stockPileCard.setAttribute('aria-disabled', canDraw ? 'false' : 'true');

    els.discardVisual.innerHTML = '';
    if (state.discard.length) {
      const top = state.discard[state.discard.length - 1];
      els.discardVisual.append(tileElement(top));
    } else {
      const empty = document.createElement('div');
      empty.className = 'stock-back';
      empty.textContent = '—';
      els.discardVisual.append(empty);
    }
    const parts = [tileCount(state.discard.length)];
    if (state.discardFrozen) parts.push('frozen');
    if (state.discard.length && state.discard[state.discard.length-1].kind === 'black') parts.push('blocked');
    els.discardInfo.textContent = parts.join(' · ');
    els.discardHint.textContent = canTake ? 'Tap to take the pile' : canDiscard ? 'Tap or drop here to discard selected tile' : '';
    els.discardPileCard.classList.toggle('action-ready', canTake || canDiscard);
    els.discardPileCard.dataset.dropAction = 'discard';
    els.discardPileCard.setAttribute('aria-disabled', (canTake || canDiscard) ? 'false' : 'true');
  }

  function renderHand() {
    const p = handPlayer();
    els.handTitle.textContent = 'Your hand';
    const orderLabel = p.sort === 'manual' ? 'manual order' : `sorted by ${p.sort}`;
    els.handMeta.textContent = `${tileCount(p.hand.length)} · ${ui.selected.size} selected · ${orderLabel}`;
    els.sortColorBtn.classList.toggle('primary', p.sort === 'color');
    els.sortNumberBtn.classList.toggle('primary', p.sort === 'number');
    els.clearSelectionBtn.disabled = ui.selected.size === 0;
    // Two row, left-to-right layout on phones. Only enormous hands need to
    // scroll sideways; hand composition and order remain unchanged.
    els.hand.style.setProperty('--compact-cols', String(Math.max(1, Math.ceil(p.hand.length / 2))));
    const previousScroll = els.hand.scrollLeft;
    els.hand.innerHTML = '';
    p.hand.forEach(tile => {
      const btn = tileElement(tile,{button:true, selected: ui.selected.has(tile.id)});
      btn.dataset.tileId = String(tile.id);
      btn.addEventListener('pointerdown', beginHandDrag);
      btn.addEventListener('click', () => {
        if (suppressTileClick === tile.id) { suppressTileClick = null; return; }
        toggleSelected(tile.id);
      });
      els.hand.append(btn);
    });
    // Retain browsing position when selecting tiles; otherwise the strip jumps
    // back to the beginning after every tap in a very large hand.
    els.hand.scrollLeft = previousScroll;
  }

  let handDrag = null;
  let suppressTileClick = null;
  let dragScrollFrame = null;
  let handMomentumFrame = null;

  function stopHandMomentum() {
    if (handMomentumFrame !== null) cancelAnimationFrame(handMomentumFrame);
    handMomentumFrame = null;
  }

  // Touch drags need `touch-action: none` to remain draggable diagonally onto
  // melds and discard. Give their manually handled sideways swipes momentum
  // rather than changing to native pan-x (which would steal diagonal drags).
  function startHandMomentum(drag, releasedAt) {
    const samples = drag.scrollSamples || [];
    if (samples.length < 2) return;
    const last = samples[samples.length - 1];
    // A gesture that pauses before release should not fling the hand.
    if (releasedAt - last.t > 80) return;
    const earlier = samples.find(s => last.t - s.t <= 100) || samples[0];
    const elapsed = last.t - earlier.t;
    if (elapsed < 12) return;
    let velocity = Math.max(-2.4, Math.min(2.4, (earlier.x - last.x) / elapsed));
    if (Math.abs(velocity) < 0.14) return;
    let previous = performance.now();
    function frame(now) {
      const dt = Math.min(now - previous, 40);
      previous = now;
      const old = els.hand.scrollLeft;
      els.hand.scrollLeft = old + velocity * dt;
      velocity *= Math.exp(-dt / 245);
      if (Math.abs(velocity) < 0.06 || Math.abs(els.hand.scrollLeft - old) < 0.1) {
        handMomentumFrame = null;
        return;
      }
      handMomentumFrame = requestAnimationFrame(frame);
    }
    handMomentumFrame = requestAnimationFrame(frame);
  }

  function stopDragAutoScroll() {
    if (dragScrollFrame !== null) cancelAnimationFrame(dragScrollFrame);
    dragScrollFrame = null;
  }

  function dragAutoScrollTick() {
    dragScrollFrame = null;
    if (!handDrag?.active || handDrag.pointerType !== 'touch') return;
    const y = handDrag.pointerY;
    const handRect = els.hand.getBoundingClientRect();
    // Drag-reordering a tile inside the hand must not scroll the page.
    if (y >= handRect.top - 5 && y <= handRect.bottom + 5) {
      dragScrollFrame = requestAnimationFrame(dragAutoScrollTick);
      return;
    }
    const height = window.innerHeight;
    const edge = Math.min(100, height * .17);
    let speed = 0;
    if (y < edge) speed = -Math.max(2, (edge - y) * .23);
    else if (y > height - edge) speed = Math.max(2, (y - (height - edge)) * .23);
    if (speed) {
      const before = window.scrollY;
      window.scrollBy(0, speed);
      if (window.scrollY !== before) updateDragTarget(handDrag.pointerX, handDrag.pointerY);
    }
    dragScrollFrame = requestAnimationFrame(dragAutoScrollTick);
  }

  function dragTileIdsForStart(id) {
    if (ui.selected.has(id) && ui.selected.size > 1) {
      const handIds = handPlayer().hand.map(t => t.id);
      return handIds.filter(tid => ui.selected.has(tid));
    }
    return [id];
  }

  function buildDragGhost(tileIds) {
    const tiles = handPlayer().hand.filter(t => tileIds.includes(t.id));
    if (tiles.length <= 1) {
      const ghost = tileElement(tiles[0], { button:false, selected:false });
      ghost.classList.remove('selected','drag-target','drag-source');
      ghost.classList.add('drag-ghost');
      return ghost;
    }

    const maxVisible = Math.min(tiles.length, 4);
    const spread = 10;
    const tileSize = 64;
    const wrap = document.createElement('div');
    wrap.className = 'drag-ghost-stack';
    wrap.style.width = `${tileSize + spread * (maxVisible - 1)}px`;
    wrap.style.height = `${tileSize + spread * (maxVisible - 1)}px`;

    const visible = tiles.slice(0, maxVisible);
    visible.forEach((tile, i) => {
      const el = tileElement(tile, { button:false, selected:false });
      el.classList.remove('selected','drag-target','drag-source');
      el.classList.add('ghost-tile');
      el.style.left = `${spread * i}px`;
      el.style.top = `${spread * i}px`;
      el.style.zIndex = String(i + 1);
      wrap.append(el);
    });

    if (tiles.length > maxVisible) {
      const badge = document.createElement('div');
      badge.className = 'ghost-count';
      badge.textContent = `+${tiles.length - maxVisible}`;
      wrap.append(badge);
    }

    return wrap;
  }

  function beginHandDrag(e) {
    if (e.button !== undefined && e.button !== 0) return;
    stopHandMomentum();
    const btn = e.currentTarget;
    const id = Number(btn.dataset.tileId);
    handDrag = {
      id, pointerId: e.pointerId, pointerType: e.pointerType, startX: e.clientX, startY: e.clientY, pointerX: e.clientX, pointerY: e.clientY,
      active: false, source: btn, ghost: null, target: null, after: false,
      scrollingHand: false, scrollLastX: e.clientX,
      scrollSamples: [{ x: e.clientX, t: e.timeStamp }],
      dropAction: null, dropMeldId: null, dropElement: null,
      draggedTileIds: dragTileIdsForStart(id)
    };
    btn.setPointerCapture?.(e.pointerId);
    btn.addEventListener('pointermove', moveHandDrag);
    btn.addEventListener('pointerup', endHandDrag, { once: true });
    btn.addEventListener('pointercancel', cancelHandDrag, { once: true });
  }

  function moveHandDrag(e) {
    if (!handDrag || e.pointerId !== handDrag.pointerId) return;
    const dx = e.clientX - handDrag.startX;
    const dy = e.clientY - handDrag.startY;
    if (handDrag.scrollingHand) {
      if (e.cancelable) e.preventDefault();
      els.hand.scrollLeft += handDrag.scrollLastX - e.clientX;
      handDrag.scrollLastX = e.clientX;
      handDrag.scrollSamples.push({ x: e.clientX, t: e.timeStamp });
      handDrag.scrollSamples = handDrag.scrollSamples.filter(sample => e.timeStamp - sample.t <= 125);
      return;
    }
    // In the compact hand, a primarily horizontal swipe scrolls the strip;
    // vertical/diagonal movement still begins normal tile drag-and-drop.
    if (!handDrag.active && handDrag.pointerType === 'touch' &&
        els.handCard.classList.contains('mobile-compact') &&
        Math.abs(dx) > 9 && Math.abs(dx) > Math.abs(dy) * 1.8 && Math.abs(dy) < 14) {
      handDrag.scrollingHand = true;
      handDrag.scrollLastX = handDrag.startX;
      if (e.cancelable) e.preventDefault();
      els.hand.scrollLeft += handDrag.scrollLastX - e.clientX;
      handDrag.scrollLastX = e.clientX;
      handDrag.scrollSamples.push({ x: e.clientX, t: e.timeStamp });
      return;
    }
    if (!handDrag.active && Math.hypot(dx,dy) < 8) return;
    if (!handDrag.active) {
      handDrag.active = true;
      handDrag.source.classList.add('drag-source');
      handDrag.ghost = buildDragGhost(handDrag.draggedTileIds);
      document.body.append(handDrag.ghost);
    }
    if (e.cancelable) e.preventDefault();
    handDrag.pointerX = e.clientX;
    handDrag.pointerY = e.clientY;
    handDrag.ghost.style.left = `${e.clientX}px`;
    handDrag.ghost.style.top = `${e.clientY}px`;
    if (handDrag.pointerType === 'touch' && dragScrollFrame === null) {
      dragScrollFrame = requestAnimationFrame(dragAutoScrollTick);
    }
    updateDragTarget(e.clientX, e.clientY);
  }

  function updateDragTarget(x, y) {
    if (!handDrag) return;
    document.querySelectorAll('#hand .drag-target').forEach(x => x.classList.remove('drag-target'));
    document.querySelectorAll('.drop-hover').forEach(x => x.classList.remove('drop-hover'));
    handDrag.dropAction = null;
    handDrag.dropMeldId = null;
    handDrag.dropElement = null;

    const under = document.elementFromPoint(x, y);
    const dropZone = under?.closest?.('[data-drop-action]');
    if (dropZone && !dropZone.closest('#hand') && canActOnline()) {
      const action = dropZone.dataset.dropAction;
      const validPhase = action === 'discard' ? state.phase === 'play' : state.phase === 'play';
      if (validPhase && (action === 'new-meld' || action === 'meld' || action === 'discard')) {
        dropZone.classList.add('drop-hover');
        handDrag.dropAction = action;
        handDrag.dropMeldId = action === 'meld' ? Number(dropZone.dataset.meldId) : null;
        handDrag.dropElement = dropZone;
        handDrag.target = null;
        handDrag.after = false;
        return;
      }
    }

    const target = under?.closest?.('#hand .tile[data-tile-id]');
    if (target && target !== handDrag.source) {
      target.classList.add('drag-target');
      const r = target.getBoundingClientRect();
      handDrag.target = Number(target.dataset.tileId);
      handDrag.after = x > r.left + r.width / 2;
    } else {
      handDrag.target = null;
      handDrag.after = false;
    }
  }

  function endHandDrag(e) {
    if (!handDrag || e.pointerId !== handDrag.pointerId) return;
    const drag = handDrag;
    cleanupHandDrag();
    if (drag.scrollingHand) {
      startHandMomentum(drag, e.timeStamp);
      suppressTileClick = drag.id;
      setTimeout(() => { if (suppressTileClick === drag.id) suppressTileClick = null; }, 0);
      return;
    }
    if (!drag.active) return;

    suppressTileClick = drag.id;
    setTimeout(() => { if (suppressTileClick === drag.id) suppressTileClick = null; }, 0);
    const p = handPlayer();

    if (drag.dropAction && canActOnline()) {
      // Dragging a selected tile carries the whole current selection. Dragging an
      // unselected tile uses just that tile for the operation.
      if (!ui.selected.has(drag.id)) {
        ui.selected.clear();
        ui.selected.add(drag.id);
      }
      if (drag.dropAction === 'discard') {
        if (state.phase === 'play') {
          ui.selected.clear();
          ui.selected.add(drag.id);
          discardSelected();
        } else {
          render();
        }
        return;
      }
      if (drag.dropAction === 'new-meld') {
        if (state.phase === 'play') createSelectedMeld(); else render();
        return;
      }
      if (drag.dropAction === 'meld') {
        if (state.phase === 'play') addSelectedToMeld(drag.dropMeldId); else render();
        return;
      }
    }

    const from = p.hand.findIndex(t => t.id === drag.id);
    if (from < 0) { render(); return; }
    p.sort = 'manual';
    if(online.active)online.sort='manual';
    const [moved] = p.hand.splice(from,1);
    if (drag.target === null) {
      p.hand.push(moved);
    } else {
      let to = p.hand.findIndex(t => t.id === drag.target);
      if (to < 0) p.hand.push(moved);
      else {
        if (drag.after) to += 1;
        p.hand.splice(to,0,moved);
      }
    }
    if(online.active)online.handOrder=p.hand.map(t=>t.id);
    render();
  }

  function cancelHandDrag(e) {
    if (!handDrag || e.pointerId !== handDrag.pointerId) return;
    cleanupHandDrag();
  }

  function cleanupHandDrag() {
    stopDragAutoScroll();
    if (!handDrag) return;
    handDrag.source?.classList.remove('drag-source');
    handDrag.source?.removeEventListener('pointermove', moveHandDrag);
    document.querySelectorAll('#hand .drag-target').forEach(x => x.classList.remove('drag-target'));
    document.querySelectorAll('.drop-hover').forEach(x => x.classList.remove('drop-hover'));
    handDrag.ghost?.remove();
    handDrag = null;
  }

  function renderActions() {
    // Game actions are handled directly through the stock, discard pile, melds,
    // and new-meld drop target rather than a separate action button bar.
  }

  function toggleSelected(id) {
    if (ui.selected.has(id)) ui.selected.delete(id); else ui.selected.add(id);
    render();
  }

  function selectedTiles() {
    const p = handPlayer();
    const ids = ui.selected;
    return p.hand.filter(t => ids.has(t.id));
  }

  function clearSelection() { ui.selected.clear(); render(); }

  function openTakePile() {
    if (!canActOnline() || state.phase !== 'draw' || !state.discard.length) return;
    const p = handPlayer();
    const top = state.discard[state.discard.length - 1];
    if (top.kind === 'black') return showInfo('Discard pile blocked', 'A black tile is on top. It has to be covered by another discard before the pile can be taken.');

    const options = [];
    if (!state.discardFrozen) {
      p.melds.forEach(m => {
        if (!canTopAddToMeld(top,m,state.allowDuplicates)) return;
        const remainingAfterPickup = p.hand.length + state.discard.length - 1;
        const newCompletion = !m.completion && !!completionState({ ...m, tiles: [...m.tiles, top] });
        if (remainingAfterPickup <= 1 && !canGoOut(p, state.players.length, newCompletion ? 1 : 0)) return;
        options.push({ label: `Add ${tileAria(top)} to ${meldName(m)}`, action: () => takePileIntoExisting(m.id) });
      });
    }
    let newOpts = selectedNewMeldOptions(top, state.discardFrozen);
    const selected = selectedTiles();
    const remaining = p.hand.length - selected.length + state.discard.length - 1;
    if (remaining <= 1) {
      newOpts = newOpts.filter(o => canGoOut(p, state.players.length,
        completionState({ type: o.type, target: o.target, tiles: [...selected, top], completion: null }) ? 1 : 0));
    }
    newOpts.forEach(o => {
      const label = `Start new ${o.type === 'number' ? `${o.target}s` : COLORS[o.target].name} meld using the selected tiles`;
      options.push({ label, action: () => takePileIntoNew(o) });
    });

    let help = '';
    if (state.discardFrozen) help = 'The pile is frozen. Select at least two natural tiles from your hand that can form a new natural meld with the top discard.';
    else help = 'You can add the top tile to an existing meld, or select tiles to start a new meld. A new meld requires at least two matching natural tiles from your hand.';

    showChoice('Take discard pile', `${help}<br><br>Top tile: <strong>${escapeHtml(tileAria(top))}</strong> · pile size: ${state.discard.length}`, options);
  }

  function signed(n) { return n >= 0 ? `+${n}` : String(n); }

  function showPassModal(name, eyebrow) {
    showCustomModal(eyebrow, `<p class="muted">Pass the device to <strong>${escapeHtml(name)}</strong>. Their hand stays hidden until they continue.</p>`, [
      { label: `Show ${escapeHtml(name)}'s hand`, className: 'primary', action: closeModal }
    ], false);
    els.modalLayer.classList.add('privacy');
  }

  function showInfo(title, text) {
    showCustomModal(title, `<p class="muted">${text}</p>`, [{ label:'OK', className:'primary', action: closeModal }], true);
  }

  function showChoice(title, body, options) {
    if (!options.length) return showInfo(title, `${body}<br><br><strong>No legal option is currently available.</strong>`);
    showCustomModal(title, `<p class="muted">${body}</p>`, options.map(o => ({ label:o.label, className:'', action:o.action })).concat([{label:'Cancel',className:'ghost',action:closeModal}]), true);
  }

  function showCustomModal(title, bodyHtml, buttons, dismissable = true) {
    els.modal.innerHTML = '';
    const h = document.createElement('h2'); h.textContent = title; els.modal.append(h);
    const body = document.createElement('div'); body.innerHTML = bodyHtml; els.modal.append(body);
    const list = document.createElement('div'); list.className = 'option-list';
    buttons.forEach(b => {
      const btn = document.createElement('button');
      btn.innerHTML = b.label;
      if (b.className) btn.className = b.className;
      btn.addEventListener('click', b.action);
      list.append(btn);
    });
    els.modal.append(list);
    els.modalLayer.classList.remove('hidden');
    els.modalLayer.dataset.dismissable = dismissable ? '1' : '0';
  }

  function closeModal() { els.modalLayer.classList.add('hidden'); els.modalLayer.classList.remove('privacy'); els.modal.innerHTML = ''; }

  function escapeHtml(str) {
    return String(str).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  }

  function abortLocalGame() {
    if(!confirm('Abort this local game and return to the main menu?'))return;
    closeModal();stopHandMomentum();
    game=null;state=null;ui.selected.clear();ui.expandedMelds.clear();
    showMenu();
  }
  function requestLeaveRoom() {
    if(!online.connected){showInfo('Connection lost','Reconnect before leaving the room.');return;}
    if(online.leaving)return;
    if(state && !confirm('Leave the room? The current game will be aborted for everyone.'))return;
    online.leaving=true;
    onlineSend({type:'leaveRoom'});
  }
  els.startGameBtn.addEventListener('click', startGame);
  els.newGameBtn.addEventListener('click',requestLeaveRoom);
  els.gameAbortBtn.addEventListener('click',()=>{
    if(online.active){
      if(online.confirmed?.isHost && confirm('Abort this game and return everyone to the lobby?'))onlineSend({type:'abortMatch'});
    }else abortLocalGame();
  });
  function activateStock() {
    if (state?.phase === 'draw' && state.stock.length && canActOnline()) drawFromStock();
  }
  function activateDiscard() {
    if (!state || !canActOnline()) return;
    if (state.phase === 'draw') return openTakePile();
    if (state.phase === 'play' && ui.selected.size === 1) return discardSelected();
    if (state.phase === 'play') setMessage('Select one tile, then tap the discard pile—or drag a tile onto it.');
  }
  els.stockPileCard.addEventListener('click', activateStock);
  els.stockPileCard.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateStock(); } });
  els.discardPileCard.addEventListener('click', activateDiscard);
  els.discardPileCard.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateDiscard(); } });
  els.hand.addEventListener('click', e => { if (e.target === els.hand && ui.selected.size) clearSelection(); });
  els.sortColorBtn.addEventListener('click', () => {
    sortHand(handPlayer(), 'color');
    if(online.active)online.sort='color';
    render();
  });
  els.sortNumberBtn.addEventListener('click', () => {
    sortHand(handPlayer(), 'number');
    if(online.active)online.sort='number';
    render();
  });
  els.clearSelectionBtn.addEventListener('click', clearSelection);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && ui.selected.size && els.modalLayer.classList.contains('hidden')) clearSelection();
  });
  els.modalLayer.addEventListener('click', (e) => {
    if (e.target === els.modalLayer && els.modalLayer.dataset.dismissable === '1') closeModal();
  });

  const screens=['menuScreen','setupScreen','onlineEntryScreen','lobbyScreen','howScreen','gameScreen'];
  function showScreen(id) {
    // State snapshots call this for every online move and lobby refresh. Only
    // reset page position when actually navigating to a different screen.
    const changingScreen=document.getElementById(id).classList.contains('hidden');
    for(const name of screens)document.getElementById(name).classList.toggle('hidden',name!==id);
    if(id!=='gameScreen')document.getElementById('gameChatPanel').classList.add('hidden');
    document.getElementById('gameConnectionIndicator').classList.toggle('hidden',id!=='gameScreen'||!online.active);
    if(changingScreen)window.scrollTo(0,0);
  }
  function showMenu(){showScreen('menuScreen');}
  // Room codes are case-insensitive and contain exactly four ASCII letters/digits.
  function normalizeRoomCode(value) {
    return String(value).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4);
  }
  const roomCodeField=document.getElementById('onlineCode');
  roomCodeField.addEventListener('input',()=>{
    const original=roomCodeField.value;
    const cleaned=normalizeRoomCode(original);
    if(cleaned===original)return;
    const cursor=normalizeRoomCode(original.slice(0,roomCodeField.selectionStart??original.length)).length;
    roomCodeField.value=cleaned;
    roomCodeField.setSelectionRange(cursor,cursor);
  });
  // Handle paste before maxlength can truncate valid characters after separators.
  roomCodeField.addEventListener('paste',event=>{
    const pasted=event.clipboardData?.getData('text');
    if(typeof pasted!=='string')return;
    event.preventDefault();
    const start=roomCodeField.selectionStart??roomCodeField.value.length;
    const end=roomCodeField.selectionEnd??start;
    const before=roomCodeField.value.slice(0,start);
    const inserted=pasted.toUpperCase().replace(/[^A-Z0-9]/g,'');
    const cleaned=normalizeRoomCode(before+inserted+roomCodeField.value.slice(end));
    const cursor=normalizeRoomCode(before+inserted).length;
    roomCodeField.value=cleaned;
    roomCodeField.setSelectionRange(cursor,cursor);
  });
  function openOnlineEntry(kind) {
    online.entryMode=kind;
    // A new Create/Join screen always starts with an empty username field.
    document.getElementById('onlineName').value='';
    document.getElementById('onlineEntryTitle').textContent=kind==='create'?'Create room':'Join room';
    document.getElementById('onlineEntryHelp').textContent=kind==='create'?'Make a private room, then share its four-character code.':'Enter the code your friend shared.';
    document.getElementById('entryCodeLabel').classList.toggle('hidden',kind==='create');
    document.getElementById('onlineEntryFields').classList.toggle('single-field',kind==='create');
    document.getElementById('onlineEntryConfirmBtn').textContent=kind==='create'?'Create Room':'Join Room';
    document.getElementById('onlineWaiting').classList.add('hidden');
    showScreen('onlineEntryScreen');
  }
  function renderLobby(lobby) {
    // A lobby snapshot may follow a live match being aborted by the host or
    // another player leaving. Forget all gameplay predictions and private state.
    game=null;state=null;online.confirmed=null;online.pending=[];
    online.busy=false;online.waitingForFinish=false;online.viewRound=null;
    online.handOrder=[];online.sort='color';
    ui.selected.clear();ui.expandedMelds.clear();closeModal();stopHandMomentum();
    online.lobby=lobby;online.playerId=lobby.seatId;
    online.awaitingResync=false;
    online.roomCode=lobby.code;
    showScreen('lobbyScreen');
    document.getElementById('lobbyCode').textContent=lobby.code;
    document.getElementById('lobbySeatCount').textContent=`${lobby.players.length}/${lobby.playerCount}`;
    document.getElementById('lobbyPlayers').innerHTML=lobby.players.map(p=>`<div class="lobby-player">
      <span class="lobby-player-name">${escapeHtml(p.name)}</span>
      ${p.isHost?'<span class="tiny muted">Host</span>':''}
      <span class="lobby-connection ${p.connected?'':'offline'}">${p.connected?'Connected':'Offline'}</span>
    </div>`).join('')+Array.from({length:lobby.playerCount-lobby.players.length},()=>'<div class="lobby-player vacant muted">Waiting for player…</div>').join('');
    const count=document.getElementById('lobbyPlayerCount'),target=document.getElementById('lobbyTargetScore');
    const first=document.getElementById('lobbyFirstPlayer'),duplicates=document.getElementById('lobbyAllowDuplicates');
    if(document.activeElement!==count)count.value=String(lobby.playerCount);
    if(document.activeElement!==target)target.value=String(lobby.targetScore);
    const preferred=document.activeElement===first?first.value:String(lobby.firstPlayer);
    updateFirstPlayerOptions(first,Number(count.value),preferred);
    if(document.activeElement!==duplicates)duplicates.value=String(lobby.allowDuplicates);
    count.disabled=target.disabled=first.disabled=duplicates.disabled=!lobby.isHost;
    document.getElementById('lobbySaveSettingsBtn').classList.toggle('hidden',!lobby.isHost);
    document.getElementById('lobbyCloseBtn').classList.toggle('hidden',!lobby.isHost);
    document.getElementById('lobbySettingsNote').textContent=lobby.isHost?'Only the host can change the settings.':'Room settings are controlled by the host.';
    const start=document.getElementById('lobbyStartBtn');
    start.classList.toggle('hidden',!lobby.isHost);
    start.disabled=lobby.players.length!==lobby.playerCount||lobby.players.some(p=>!p.connected);
    start.textContent=start.disabled?`Waiting for ${lobby.playerCount-lobby.players.length} player(s)…`:'Start match';
    renderRoomMessages(lobby.messages);
  }
  function renderChatInto(container,messages) {
    const wasAtBottom=container.scrollHeight-container.scrollTop-container.clientHeight<45;
    const lastId=messages.length?messages[messages.length-1].id:0;
    if(container.dataset.lastMessageId===String(lastId)&&container.dataset.messageCount===String(messages.length))return;
    container.innerHTML=messages.map(m=>m.system?
      `<div class="chat-system">${escapeHtml(m.text)}</div>`:
      `<div class="chat-message"><strong>${escapeHtml(m.sender)}</strong><span>${escapeHtml(m.text)}</span></div>`).join('');
    container.dataset.lastMessageId=String(lastId);container.dataset.messageCount=String(messages.length);
    if(wasAtBottom||!container.dataset.initialized)container.scrollTop=container.scrollHeight;
    container.dataset.initialized='1';
  }
  function shouldPlayChatChime(messages,lastSeenId,ownSeatId) {
    return lastSeenId!==null && messages.some(message=>
      Number.isSafeInteger(message.id) && message.id>lastSeenId &&
      !message.system && message.senderId!==ownSeatId);
  }
  function renderRoomMessages(messages) {
    const received=Array.isArray(messages)?messages:[];
    // The first snapshot is history, not a new message. Ignore repeat broadcasts
    // and system notices; don't alert a player about their own chat message.
    if(online.active && online.connected && !online.awaitingChatResync &&
      shouldPlayChatChime(received,online.lastChatMessageId,online.playerId))playChatNotificationSound();
    online.awaitingChatResync=false;
    const newestId=received.reduce((max,message)=>
      Number.isSafeInteger(message.id)?Math.max(max,message.id):max,0);
    online.lastChatMessageId=Math.max(online.lastChatMessageId??0,newestId);
    online.messages=received;
    renderChatInto(document.getElementById('lobbyChatLog'),online.messages);
    renderChatInto(document.getElementById('gameChatLog'),online.messages);
  }
  function submitRoomChat(form, input) {
    const message=input.value.trim();
    if(!message||!online.connected)return;
    onlineSend({type:'chat',text:message});
    input.value='';
  }
  function resetOnline() {
    const socket=online.socket;
    online.socket=null;
    stopLatencyPings();
    online.connected=false;online.reconnecting=false;online.active=false;online.confirmed=null;online.pending=[];
    online.busy=false;online.waitingForFinish=false;online.roomCode=null;online.token=null;
    online.lobby=null;online.messages=[];online.viewRound=null;online.leaving=false;online.closing=false;
    online.playerId=null;online.handOrder=[];online.sort='color';
    online.lastChatMessageId=null;online.awaitingResync=false;online.awaitingChatResync=false;
    ui.selected.clear();ui.expandedMelds.clear();closeModal();stopHandMomentum();
    if(online.retryTimer)clearTimeout(online.retryTimer);
    online.retryTimer=null;
    clearOnlineSession();
    if(socket)socket.close();
    state=null;game=null;
    showMenu();
    renderConnectionIndicator();
    document.getElementById('menuResumeBtn').classList.add('hidden');
  }
  document.getElementById('menuLocalBtn').addEventListener('click',()=>showScreen('setupScreen'));
  document.getElementById('menuCreateBtn').addEventListener('click',()=>openOnlineEntry('create'));
  document.getElementById('menuJoinBtn').addEventListener('click',()=>openOnlineEntry('join'));
  document.getElementById('menuHowBtn').addEventListener('click',()=>showScreen('howScreen'));
  document.getElementById('howBackBtn').addEventListener('click',showMenu);
  document.getElementById('localBackBtn').addEventListener('click',showMenu);
  document.getElementById('onlineEntryBackBtn').addEventListener('click',showMenu);
  document.getElementById('onlineEntryConfirmBtn').addEventListener('click',()=>{
    const code=normalizeRoomCode(roomCodeField.value);
    if(online.entryMode==='join'&&!/^[A-Z0-9]{4}$/.test(code)){
      showOnlineWaiting('Please enter a valid four-character room code.');return;
    }
    beginOnline(online.entryMode,code);
  });
  document.getElementById('menuResumeBtn').addEventListener('click',()=>{
    try{
      const previous=JSON.parse(readOnlineSession());
      if(!previous?.code||!previous?.token)throw Error();
      online.roomCode=previous.code;online.token=previous.token;
      showScreen('onlineEntryScreen');beginOnline('resume');
    }catch{showInfo('No saved match','There is no saved online match in this tab.');}
  });
  document.getElementById('copyCodeBtn').addEventListener('click',async()=>{
    try{await navigator.clipboard.writeText(online.roomCode);document.getElementById('copyCodeBtn').textContent='Copied!';
      setTimeout(()=>{document.getElementById('copyCodeBtn').textContent='Copy code';},1500);
    }catch{showInfo('Room code',escapeHtml(online.roomCode));}
  });
  for(const [countId,firstId] of [['playerCount','localFirstPlayer'],['lobbyPlayerCount','lobbyFirstPlayer']]) {
    const count=document.getElementById(countId),first=document.getElementById(firstId);
    count.addEventListener('change',()=>{
      const players=Number(count.value);
      updateFirstPlayerOptions(first,players);
      const score=document.getElementById(countId==='playerCount'?'targetScore':'lobbyTargetScore');
      score.value=String(DEFAULT_TARGETS[players]);
    });
    updateFirstPlayerOptions(first,Number(count.value));
  }
  document.getElementById('lobbySaveSettingsBtn').addEventListener('click',()=>onlineSend({type:'settings',
    playerCount:Number(document.getElementById('lobbyPlayerCount').value),
    targetScore:Number(document.getElementById('lobbyTargetScore').value),
    firstPlayer:selectedFirstPlayer(document.getElementById('lobbyFirstPlayer')),
    allowDuplicates:document.getElementById('lobbyAllowDuplicates').value==='true'}));
  document.getElementById('lobbyStartBtn').addEventListener('click',()=>onlineSend({type:'startMatch'}));
  document.getElementById('lobbyLeaveBtn').addEventListener('click',requestLeaveRoom);
  document.getElementById('lobbyCloseBtn').addEventListener('click',()=>{
    if(online.closing || !online.connected)return;
    if(confirm('Close this room? Everyone will be returned to the main menu.')){
      online.closing=true;
      onlineSend({type:'closeRoom'});
    }
  });
  document.getElementById('lobbyChatForm').addEventListener('submit',e=>{e.preventDefault();submitRoomChat(e.target,document.getElementById('lobbyChatInput'));});
  document.getElementById('gameChatForm').addEventListener('submit',e=>{e.preventDefault();submitRoomChat(e.target,document.getElementById('gameChatInput'));});
  if(readOnlineSession())document.getElementById('menuResumeBtn').classList.remove('hidden');
  initializeCrossmeldLogos();
  initializeHowToPlayExamples();
  renderConnectionIndicator();
})();
