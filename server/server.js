'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {WebSocketServer,WebSocket}=require('ws');
const {RoomManager}=require('./rooms');
const manager=new RoomManager();
const root=path.resolve(__dirname,'..');
const port=Number(process.env.PORT||8001);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
const server=http.createServer((req,res)=>{
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
  let pathname;
  try{pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400);res.end();return;}
  if(pathname==='/health'){
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    res.end(JSON.stringify({status:'ok'}));return;
  }
  if(pathname==='/'||pathname==='/public'||pathname==='/index.html'){
    res.writeHead(302,{Location:'/public/','Cache-Control':'no-store'});res.end();return;
  }
  if(pathname==='/public/')pathname='/public/index.html';
  // Do not serve server source, tests, or private project files via HTTP.
  if(!(/^\/public\/[\w.-]+\.(?:html|css|js)$/.test(pathname)||
       /^\/shared\/[\w.-]+\.js$/.test(pathname))){res.writeHead(404);res.end();return;}
  const filepath=path.resolve(root,`.${pathname}`);
  if(!filepath.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  fs.stat(filepath,(err,stat)=>{
    if(err||!stat.isFile()){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':mime[path.extname(filepath)]||'application/octet-stream','Cache-Control':'no-store'});
    if(req.method==='HEAD'){res.end();return;}
    fs.createReadStream(filepath).pipe(res);
  });
});
const wss=new WebSocketServer({server,path:'/ws',maxPayload:64*1024});
// Detect half-open connections (for example after sleep or a broken network link).
// Browsers respond automatically to protocol-level WebSocket ping frames.
function heartbeatConnections() {
  for(const ws of wss.clients) {
    if(ws.isAlive===false) {ws.terminate();continue;}
    if(ws.readyState!==WebSocket.OPEN)continue;
    ws.isAlive=false;
    ws.ping();
  }
}
const heartbeatTimer=setInterval(heartbeatConnections,30_000);
heartbeatTimer.unref?.();
wss.on('close',()=>clearInterval(heartbeatTimer));
const send=(ws,data)=>{if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(data));};
const notify=room=>{
  if(!room)return;
  for(const seat of room.seats){
    if(room.game)send(seat.connection,{type:'state',view:manager.getView(room,seat)});
    else send(seat.connection,{type:'lobby',lobby:manager.getLobby(room,seat)});
    // Chat is independent of the game's optimistic action revision system.
    if(room.game)send(seat.connection,{type:'roomMessages',messages:room.messages});
  }
};
wss.on('connection',ws=>{
  ws.isAlive=true;
  ws.on('pong',()=>{ws.isAlive=true;});
  // Avoid letting a network-level socket error crash the multiplayer server.
  ws.on('error',()=>{});
  let binding=null;
  ws.on('message',raw=>{
    let data;
    try{data=JSON.parse(raw.toString());if(typeof data!=='object'||data===null||Array.isArray(data))throw Error();}
    catch{send(ws,{type:'error',message:'Invalid JSON message.'});return;}
    // Lightweight application-level round-trip measurement, valid before joining a room.
    if(data.type==='latency_ping'){
      if(Number.isSafeInteger(data.id) && data.id>=0)send(ws,{type:'latency_pong',id:data.id});
      return;
    }
    try{
      if(data.type==='create'||data.type==='join'||data.type==='resume'){
        if(binding)throw new Error('Already in a room.');
        const {room,seat}=data.type==='create'?manager.create(data,ws):data.type==='join'?manager.join(data,ws):manager.reconnect(data,ws);
        binding={room,seat};
        send(ws,{type:'welcome',roomCode:room.code,token:seat.token,seatId:seat.id});
        notify(room);
      }else{
        if(!binding)throw new Error('Join or create a room first.');
        const {room,seat}=binding;
        if(room.closed || !room.seats.includes(seat)){
          binding=null;
          throw new Error('You are no longer in this room.');
        }
        if(data.type==='action'){
          try{
            const ack=manager.process(room,seat,data);
            send(ws,{type:'ack',...ack});
            for(const other of room.seats)if(other!==seat)send(other.connection,{type:'state',view:manager.getView(room,other)});
            if(room.game.state.roundOver)notify(room);
          }catch(error){send(ws,{type:'rejected',actionId:data.actionId,code:error.code||'action',message:error.message,view:manager.getView(room,seat)});}
        }else if(data.type==='startMatch'){
          manager.start(room,seat);notify(room);
        }else if(data.type==='settings'){
          manager.configure(room,seat,data);notify(room);
        }else if(data.type==='chat'){
          manager.chat(room,seat,data.text);
          for(const member of room.seats)send(member.connection,{type:'roomMessages',messages:room.messages});
        }else if(data.type==='nextRound'){
          manager.nextRound(room,seat);notify(room);
        }else if(data.type==='abortMatch'){
          manager.abortMatch(room,seat);notify(room);
        }else if(data.type==='closeRoom'){
          manager.closeRoom(room,seat);
          for(const member of room.seats)send(member.connection,{type:'roomClosed',message:`${seat.name} closed the room.`});
          binding=null;
        }else if(data.type==='sync'){
          notify(room);
        }else if(data.type==='leaveRoom'){
          manager.leave(room,seat);
          binding=null;
          send(ws,{type:'left'});
          if(!room.closed)notify(room);
        }else throw new Error('Unknown message type.');
      }
    }catch(error){send(ws,{type:'error',message:error.message||'Request failed.'});}
  });
  ws.on('close',()=>{
    const disconnected=manager.disconnect(ws);
    if(disconnected)notify(disconnected.room);
  });
});
server.listen(port,'0.0.0.0',()=>{
  console.log(`Crossmeld Step 4: http://localhost:${port}/`);
  for(const interfaces of Object.values(os.networkInterfaces()))for(const a of interfaces??[])if(a.family==='IPv4'&&!a.internal)console.log(`Same-Wi-Fi: http://${a.address}:${port}/`);
  console.log('Private-room multiplayer, lobby and chat.');
});
module.exports={server,wss,manager,heartbeatConnections};
