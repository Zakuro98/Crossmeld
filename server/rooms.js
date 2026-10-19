'use strict';
// Authoritative, private-seat multiplayer rooms. All gameplay rules live in shared/game.js.
const crypto = require('node:crypto');
const {Game, GameError} = require('../shared/game');
const {playerView, publicRoundResults} = require('../shared/view');

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode() { return Array.from(crypto.randomBytes(4), n => ROOM_ALPHABET[n % ROOM_ALPHABET.length]).join(''); }
function cleanName(value, fallback) { return (typeof value === 'string' ? value.trim().slice(0,20) : '') || fallback; }
function isId(value) { return (Number.isSafeInteger(value) && value > 0) || (typeof value==='string' && /^[0-9a-f]{16}:[1-9][0-9]{0,9}$/i.test(value)); }
function validCount(n) { return Number.isSafeInteger(n) && n >= 2 && n <= 4; }
function validTarget(n) { return Number.isSafeInteger(n) && n >= 100 && n <= 10000; }
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
  create({name, targetScore = 1000, playerCount = 2, firstPlayer = 'random'} = {}, connection) {
    if(!validTarget(targetScore))throw new GameError('settings','Invalid target score.');
    if(!validCount(playerCount))throw new GameError('settings','Choose 2–4 players.');
    if(!validFirstPlayer(firstPlayer,playerCount))throw new GameError('settings','Choose a valid Round 1 starting player.');
    let code;
    do { code=randomCode(); } while(this.rooms.has(code));
    const seat = {id:0,name:cleanName(name,'Player 1'),token:crypto.randomBytes(32).toString('hex'),connection,seen:new Map()};
    const room={code,targetScore,playerCount,firstPlayer,seats:[seat],game:null,revision:0,results:null,reason:'',closed:false,
      messages:[],messageId:0};
    this.record(room,`${seat.name} created the room.`);
    this.rooms.set(code,room);
    return {room,seat};
  }
  join({code,name}={},connection) {
    const room=this.rooms.get(String(code||'').trim().toUpperCase());
    if(!room||room.closed)throw new GameError('room','Room not found.');
    if(room.game)throw new GameError('room','This match has already started.');
    if(room.seats.length>=room.playerCount)throw new GameError('room','This room is full.');
    const seat={id:room.seats.length,name:cleanName(name,`Player ${room.seats.length+1}`),token:crypto.randomBytes(32).toString('hex'),connection,seen:new Map()};
    room.seats.push(seat);
    this.record(room,`${seat.name} joined the room.`);
    return {room,seat};
  }
  reconnect({code,token}={},connection) {
    const room=this.rooms.get(String(code||'').trim().toUpperCase());
    const seat=room?.seats.find(s=>typeof token==='string' && /^[0-9a-f]{64}$/i.test(token) && crypto.timingSafeEqual(Buffer.from(s.token,'hex'),Buffer.from(token,'hex')));
    if(!room||room.closed||!seat)throw new GameError('auth','Unable to reconnect to that seat.');
    if(connected(seat) && seat.connection!==connection)throw new GameError('auth','This seat is already connected.');
    seat.connection=connection;
    this.record(room,`${seat.name} reconnected.`);
    return {room,seat};
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
    for(const member of room.seats)member.seen.clear();
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
  configure(room,seat,{playerCount,targetScore,firstPlayer=room?.firstPlayer}={}) {
    if(!room||room.game)throw new GameError('settings','Settings cannot be changed after the match starts.');
    if(seat!==room.seats[0])throw new GameError('host','Only the host can change settings.');
    if(!validCount(playerCount)||playerCount<room.seats.length)throw new GameError('settings','Player count must accommodate everyone already in the room (2–4).');
    if(!validTarget(targetScore))throw new GameError('settings','Target score must be 100–10000.');
    if(!validFirstPlayer(firstPlayer,playerCount))throw new GameError('settings','Choose a valid Round 1 starting player.');
    room.playerCount=playerCount;room.targetScore=targetScore;room.firstPlayer=firstPlayer;
    const starterLabel=firstPlayer==='random'?'Random':`Player ${firstPlayer+1}`;
    this.record(room,`Room settings: ${playerCount} players, first to ${targetScore} points, Round 1 first: ${starterLabel}.`);
  }
  start(room,seat) {
    if(!room||room.game)throw new GameError('room','This match has already started.');
    if(seat!==room.seats[0])throw new GameError('host','Only the host can start the match.');
    if(room.seats.length!==room.playerCount)throw new GameError('room',`Waiting for ${room.playerCount-room.seats.length} more player(s).`);
    if(room.seats.some(s=>!connected(s)))throw new GameError('room','All players must be connected to start.');
    const firstPlayer=room.firstPlayer==='random'?crypto.randomInt(room.playerCount):room.firstPlayer;
    const game=new Game({names:room.seats.map(s=>s.name),targetScore:room.targetScore,firstPlayer,
      rng:()=>crypto.randomInt(0,4294967296)/4294967296});
    game.startRound();
    room.game=game;room.revision=1;
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
    return {code:room.code,playerCount:room.playerCount,targetScore:room.targetScore,firstPlayer:room.firstPlayer,
      seatId:seat.id,isHost:room.seats[0]===seat,started:!!room.game,
      players:room.seats.map(s=>({id:s.id,name:s.name,connected:connected(s),isHost:s===room.seats[0]})),
      messages:room.messages.slice()};
  }
  getView(room,seat) {
    if(!room.game)throw new GameError('room','Match has not started.');
    return {...playerView(room.game,seat.id),revision:room.revision,
      nextMeldId:room.game.nextMeldId,roomCode:room.code,isHost:room.seats[0]===seat,
      results:room.results,resultReason:room.reason,paused:room.seats.some(s=>!connected(s))};
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
    if(result.winnerId!==undefined&&result.winnerId!==null){
      const finish=game.finishRound(result.winnerId);
      room.results=publicRoundResults(finish);
      const winner=finish.results.find(r=>r.player.id===result.winnerId);
      room.reason=`${room.seats[result.winnerId].name} went out${winner.concealedOut?' concealed':''}.`;
      this.record(room,room.reason);
    }else if(input.action==='discard'){
      const advance=game.advanceTurn();
      if(advance.roundEnds){
        const finish=game.finishRound(null);
        room.results=publicRoundResults(finish);
        room.reason='Stock exhausted; no legal discard pickup available.';
        this.record(room,room.reason);
      }
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
    room.game.nextRound();room.revision++;room.results=null;room.reason='';
    for(const s of room.seats)s.seen.clear();
    this.record(room,`Round ${room.game.state.round} has started.`);
  }
}
module.exports={RoomManager};
