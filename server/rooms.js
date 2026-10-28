'use strict';
// Authoritative, private-seat multiplayer rooms. All gameplay rules live in shared/game.js.
const crypto = require('node:crypto');
const {Game, GameError} = require('../shared/game');
const {playerView, publicRoundResults} = require('../shared/view');

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode() { return Array.from(crypto.randomBytes(4), n => ROOM_ALPHABET[n % ROOM_ALPHABET.length]).join(''); }
function cleanName(value, fallback) { return (typeof value === 'string' ? value.trim().slice(0,20) : '') || fallback; }
// Compare the final display names, including trimmed/truncated names and Unicode variants.
function nameKey(value) { return value.normalize('NFKC').toLowerCase(); }
function isId(value) { return (Number.isSafeInteger(value) && value > 0) || (typeof value==='string' && /^[0-9a-f]{16}:[1-9][0-9]{0,9}$/i.test(value)); }
function validCount(n) { return Number.isSafeInteger(n) && n >= 2 && n <= 4; }
function defaultTargetForCount(count) { return {2:1500,3:1250,4:1000}[count]; }
function validTarget(n) { return Number.isSafeInteger(n) && n >= 100 && n <= 10000; }
function validDuplicates(value) { return typeof value === 'boolean'; }
// Presentation-only information. Reject malformed or incomplete lists rather
// than allowing a client to persist a layout containing nonexistent tile IDs.
function normalizeHandLayout(layout, hand) {
  if (!layout || !['color','number','manual'].includes(layout.sort) || !Array.isArray(layout.order)) return null;
  if (layout.order.length !== hand.length) return null;
  const ids = new Set(hand.map(tile => tile.id));
  if (new Set(layout.order).size !== ids.size || layout.order.some(id => !Number.isSafeInteger(id) || !ids.has(id))) return null;
  return {sort:layout.sort, order:[...layout.order]};
}
// A fixed starter is a zero-based seat ID; 'random' resolves only when a match begins.
function validFirstPlayer(value, count) {
  return value === 'random' || (Number.isSafeInteger(value) && value >= 0 && value < count);
}
const connected = seat => !!seat.connection && seat.connection.readyState === 1;

class RoomManager {
  constructor() { this.rooms = new Map(); }
  record(room, text, system = true, sender = null, senderId = null) {
    const entry = {id:++room.messageId, system, sender, senderId, text};
    room.messages.push(entry);
    if(room.messages.length>75)room.messages.shift();
    return entry;
  }
  create({name, targetScore, playerCount = 2, firstPlayer = 'random', allowDuplicates = true} = {}, connection) {
    if(!validCount(playerCount))throw new GameError('settings','Choose 2–4 players.');
    if(targetScore===undefined)targetScore=defaultTargetForCount(playerCount);
    if(!validTarget(targetScore))throw new GameError('settings','Invalid target score.');
    if(!validFirstPlayer(firstPlayer,playerCount))throw new GameError('settings','Choose a valid Round 1 starting player.');
    if(!validDuplicates(allowDuplicates))throw new GameError('settings','Invalid duplicate setting.');
    let code;
    do { code=randomCode(); } while(this.rooms.has(code));
    const seat = {id:0,name:cleanName(name,'Player 1'),token:crypto.randomBytes(32).toString('hex'),connection,seen:new Map(),handLayout:null};
    const room={code,targetScore,playerCount,firstPlayer,allowDuplicates,seats:[seat],game:null,revision:0,results:null,reason:'',closed:false,
      messages:[],messageId:0,lastDraw:null};
    this.record(room,`${seat.name} created the room.`);
    this.rooms.set(code,room);
    return {room,seat};
  }
  join({code,name}={},connection) {
    const room=this.rooms.get(String(code||'').trim().toUpperCase());
    if(!room||room.closed)throw new GameError('room','Room not found.');
    if(room.game)throw new GameError('room','This match has already started.');
    if(room.seats.length>=room.playerCount)throw new GameError('room','This room is full.');
    const joinName=cleanName(name,`Player ${room.seats.length+1}`);
    if(room.seats.some(s=>nameKey(s.name)===nameKey(joinName))){
      throw new GameError('name','That username is already taken in this room.');
    }
    const seat={id:room.seats.length,name:joinName,token:crypto.randomBytes(32).toString('hex'),connection,seen:new Map(),handLayout:null};
    room.seats.push(seat);
    this.record(room,`${seat.name} joined the room.`);
    return {room,seat};
  }
  findReconnectSeat({code,token}={}) {
    const room=this.rooms.get(String(code||'').trim().toUpperCase());
    const seat=room?.seats.find(s=>typeof token==='string' && /^[0-9a-f]{64}$/i.test(token) && crypto.timingSafeEqual(Buffer.from(s.token,'hex'),Buffer.from(token,'hex')));
    if(!room||room.closed||!seat)throw new GameError('auth','Unable to reconnect to that seat.');
    return {room,seat};
  }
  reconnect(data={},connection,{verifiedStaleConnection=null}={}) {
    const {room,seat}=this.findReconnectSeat(data);
    if(seat.connection===connection)throw new GameError('connected','This session is already connected.');
    // A token alone must not kick a currently connected player. The server
    // may explicitly supply an old socket only after its live ping probe fails.
    if(connected(seat) && seat.connection!==verifiedStaleConnection){
      throw new GameError('connected','This player is already connected in this room.');
    }
    const replacedConnection=seat.connection;
    seat.connection=connection;
    this.record(room,`${seat.name} reconnected.`);
    return {room,seat,replacedConnection};
  }
  disconnect(connection) {
    for(const room of this.rooms.values())for(const seat of room.seats){
      if(seat.connection===connection){seat.connection=null;this.record(room,`${seat.name} disconnected.`);return {room,seat};}
    }
    return null;
  }
  // A match is ephemeral; the room, chat and occupied seats survive an abort.
  stopMatch(room) {
    room.game=null;
    room.revision=0;
    room.results=null;
    room.reason='';
    room.lastDraw=null;
    for(const member of room.seats){member.seen.clear();member.handLayout=null;}
  }
  leave(room,seat) {
    if(!room || room.closed || !room.seats.includes(seat))throw new GameError('room','Not in this room.');
    const playing=!!room.game;
    const wasHost=room.seats[0]===seat;
    if(playing)this.stopMatch(room);
    room.seats.splice(room.seats.indexOf(seat),1);
    seat.connection=null;
    room.seats.forEach((member,i)=>{member.id=i;});
    this.record(room,`${seat.name} left the room.${playing?' The match was aborted.':''}`);
    if(wasHost && room.seats.length)this.record(room,`${room.seats[0].name} is now the host.`);
    if(!room.seats.length){room.closed=true;this.rooms.delete(room.code);}
    return playing;
  }
  abortMatch(room,seat) {
    if(!room || room.closed || !room.seats.includes(seat) || !room.game)throw new GameError('room','There is no active match to abort.');
    if(room.seats[0]!==seat)throw new GameError('host','Only the host can abort the game.');
    this.stopMatch(room);
    this.record(room,`${seat.name} aborted the game. Returned to the lobby.`);
  }
  closeRoom(room,seat) {
    if(!room || room.closed || !room.seats.includes(seat))throw new GameError('room','Room not found.');
    if(room.seats[0]!==seat)throw new GameError('host','Only the host can close the room.');
    if(room.game)throw new GameError('room','Abort the game before closing the room.');
    room.closed=true;
    this.rooms.delete(room.code);
  }
  configure(room,seat,{playerCount,targetScore,firstPlayer=room?.firstPlayer,allowDuplicates=room?.allowDuplicates}={}) {
    if(!room||room.game)throw new GameError('settings','Settings cannot be changed after the match starts.');
    if(seat!==room.seats[0])throw new GameError('host','Only the host can change settings.');
    if(!validCount(playerCount)||playerCount<room.seats.length)throw new GameError('settings','Player count must accommodate everyone already in the room (2–4).');
    if(!validTarget(targetScore))throw new GameError('settings','Target score must be 100–10000.');
    if(!validFirstPlayer(firstPlayer,playerCount))throw new GameError('settings','Choose a valid Round 1 starting player.');
    if(!validDuplicates(allowDuplicates))throw new GameError('settings','Invalid duplicate setting.');
    room.playerCount=playerCount;room.targetScore=targetScore;room.firstPlayer=firstPlayer;room.allowDuplicates=allowDuplicates;
    const starterLabel=firstPlayer==='random'?'Random':`Player ${firstPlayer+1}`;
    this.record(room,`Room settings: ${playerCount} players, first to ${targetScore} points, Round 1 first: ${starterLabel}, duplicates ${allowDuplicates ? 'allowed' : 'not allowed'}.`);
  }
  start(room,seat) {
    if(!room||room.game)throw new GameError('room','This match has already started.');
    if(seat!==room.seats[0])throw new GameError('host','Only the host can start the match.');
    if(room.seats.length!==room.playerCount)throw new GameError('room',`Waiting for ${room.playerCount-room.seats.length} more player(s).`);
    if(room.seats.some(s=>!connected(s)))throw new GameError('room','All players must be connected to start.');
    const firstPlayer=room.firstPlayer==='random'?crypto.randomInt(room.playerCount):room.firstPlayer;
    const game=new Game({names:room.seats.map(s=>s.name),targetScore:room.targetScore,firstPlayer,allowDuplicates:room.allowDuplicates,
      rng:()=>crypto.randomInt(0,4294967296)/4294967296});
    game.startRound();
    room.game=game;room.revision=1;room.lastDraw=null;
    for(const member of room.seats)member.handLayout=null;
    this.record(room,`The match has started. ${room.seats[firstPlayer].name} goes first in Round 1.`);
  }
  chat(room,seat,text) {
    if(!room?.seats.includes(seat))throw new GameError('room','Not in a room.');
    if(typeof text!=='string'||text.trim().length===0||text.trim().length>280)throw new GameError('chat','Messages must be 1–280 characters.');
    const now=Date.now();
    if(seat.lastMessageAt && now-seat.lastMessageAt<450)throw new GameError('chat','You are sending messages too quickly.');
    seat.lastMessageAt=now;
    return this.record(room,text.trim(),false,seat.name,seat.id);
  }
  getLobby(room,seat) {
    if(!room?.seats.includes(seat))throw new GameError('room','Not in this room.');
    return {code:room.code,playerCount:room.playerCount,targetScore:room.targetScore,firstPlayer:room.firstPlayer,allowDuplicates:room.allowDuplicates,
      seatId:seat.id,isHost:room.seats[0]===seat,started:!!room.game,
      players:room.seats.map(s=>({id:s.id,name:s.name,connected:connected(s),isHost:s===room.seats[0]})),
      messages:room.messages.slice()};
  }
  getView(room,seat) {
    if(!room.game)throw new GameError('room','Match has not started.');
    return {...playerView(room.game,seat.id),revision:room.revision,
      nextMeldId:room.game.nextMeldId,roomCode:room.code,isHost:room.seats[0]===seat,
      results:room.results,resultReason:room.reason,paused:room.seats.some(s=>!connected(s)),
      lastDraw:room.lastDraw,
      // Only the owner receives their saved layout. Never publish other hands'
      // tile IDs or arrangements through the player list or lobby.
      handLayout:{sort:seat.handLayout?.sort || 'color',
        order:seat.handLayout?.round===room.game.state.round ? [...seat.handLayout.order] : []}};
  }
  // Private, presentation-only updates are allowed even outside the player's
  // turn. Ignore malformed/stale layouts silently: no gameplay revision, reply,
  // broadcast, or exposure of the owner's tile identities.
  saveHandLayout(room,seat,input) {
    if(!room?.game || room.closed || !room.seats.includes(seat) ||
       input?.round!==room.game.state.round || room.game.state.roundOver) return false;
    const layout=normalizeHandLayout(input.handLayout,room.game.state.players[seat.id].hand);
    if(!layout)return false;
    seat.handLayout={...layout,round:room.game.state.round};
    return true;
  }
  process(room,seat,input) {
    if(!room||!room.game||!room.seats.includes(seat))throw new GameError('room','Not in an active room.');
    if(!input||typeof input!=='object'||Array.isArray(input))throw new GameError('message','Invalid action.');
    if(!isId(input.actionId))throw new GameError('message','Invalid action ID.');
    if(seat.seen.has(input.actionId))return {id:input.actionId,duplicate:true,view:this.getView(room,seat)};
    if(input.expectedRevision!==room.revision)throw new GameError('revision','Game state has changed.');
    if(room.seats.some(s=>!connected(s)))throw new GameError('paused','Waiting for the disconnected player to return.');
    if(room.game.state.roundOver)throw new GameError('round','The round is already over.');
    if(room.game.state.current!==seat.id)throw new GameError('turn','It is not your turn.');
    if(!room.game.handMatches(seat.id,input.handBefore))throw new GameError('hand','Your hand is out of sync with the server.');
    const game=room.game;
    // Gameplay actions also carry layout updates: validate against the hand
    // before the action, then prune tiles played during that action.
    const proposedLayout=normalizeHandLayout(input.handLayout,game.state.players[seat.id].hand);
    let result;
    const ids=input.tileIds;
    switch(input.action){
      case 'drawStock':result=game.drawStock();break;
      case 'takePileExisting':
        if(!Number.isSafeInteger(input.meldId))throw new GameError('meld','Invalid meld ID.');
        result=game.takePileExisting(input.meldId);break;
      case 'takePileNew':
        if(!Array.isArray(ids)||ids.length>room.game.state.players[seat.id].hand.length)throw new GameError('tiles','Invalid tile selection.');
        result=game.takePileNew(ids,input.option);break;
      case 'createMeld':
        if(!Array.isArray(ids)||ids.length>room.game.state.players[seat.id].hand.length)throw new GameError('tiles','Invalid tile selection.');
        result=game.createMeld(ids,input.option||null);break;
      case 'addToMeld':
        if(!Number.isSafeInteger(input.meldId)||!Array.isArray(ids)||ids.length>room.game.state.players[seat.id].hand.length)throw new GameError('tiles','Invalid tile selection.');
        result=game.addToMeld(input.meldId,ids);break;
      case 'discard':result=game.discard(input.tileId);break;
      default:throw new GameError('action','Unsupported gameplay action.');
    }
    // Public turn activity: only the draw source and count, never private tiles.
    // Keep it visible through this player's play phase; clear on turn change.
    if(input.action==='drawStock'){
      room.lastDraw={playerId:seat.id,source:'stock',count:result.drawn.length};
    }else if(input.action==='takePileExisting'||input.action==='takePileNew'){
      room.lastDraw={playerId:seat.id,source:'discard',count:result.received.length+1};
    }
    if(result.winnerId!==undefined&&result.winnerId!==null){
      const finish=game.finishRound(result.winnerId);
      room.results=publicRoundResults(finish);
      const winner=finish.results.find(r=>r.player.id===result.winnerId);
      room.reason=`${room.seats[result.winnerId].name} went out${winner.concealedOut?' concealed':''}.`;
      this.record(room,room.reason);
    }else if(input.action==='discard'){
      const advance=game.advanceTurn();
      room.lastDraw=null;
      if(advance.roundEnds){
        const finish=game.finishRound(null);
        room.results=publicRoundResults(finish);
        room.reason='Stock exhausted; no legal discard pickup available.';
        this.record(room,room.reason);
      }
    }
    // Keep preferences current after any legal action, not just at turn end.
    // A stock draw adds tiles after this snapshot; the client will send its
    // updated order upon receipt of the authoritative new hand.
    if(proposedLayout){
      const remainingIds=new Set(game.state.players[seat.id].hand.map(tile=>tile.id));
      seat.handLayout={sort:proposedLayout.sort,
        order:proposedLayout.order.filter(id=>remainingIds.has(id)),round:game.state.round};
    }
    room.revision++;
    seat.seen.set(input.actionId,true);
    if(seat.seen.size>128)seat.seen.delete(seat.seen.keys().next().value);
    return {id:input.actionId,view:this.getView(room,seat),result:{completedNow:!!result.completedNow,roundOver:game.state.roundOver}};
  }
  nextRound(room,seat) {
    if(!room?.game||room.seats[0]!==seat)throw new GameError('host','Only the host can advance the round.');
    if(!room.game.state.roundOver)throw new GameError('round','The round is still running.');
    if(room.results?.winnerPlayerIds?.length)throw new GameError('match','The match has ended.');
    room.game.nextRound();room.revision++;room.results=null;room.reason='';room.lastDraw=null;
    for(const s of room.seats)s.seen.clear();
    this.record(room,`Round ${room.game.state.round} has started.`);
  }
}
module.exports={RoomManager};
