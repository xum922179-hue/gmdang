// NEON STRIKE - Multiplayer Server
// Run: node server.js  (default port 8080)
// Clients connect via: ws://<your-ip>:8080
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

// ----- Static file server (so clients can also load multiplayer.html from this server) -----
const MIME = { '.html':'text/html', '.js':'application/javascript', '.json':'application/json', '.css':'text/css' };
const server = http.createServer((req, res)=>{
  let p = req.url === '/' ? '/multiplayer.html' : req.url;
  // Block path traversal
  if(p.indexOf('..') >= 0){ res.writeHead(403); return res.end('forbidden'); }
  const file = path.join(__dirname, p);
  fs.readFile(file, (err, data)=>{
    if(err){ res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {'Content-Type': MIME[path.extname(file)] || 'application/octet-stream'});
    res.end(data);
  });
});

// ----- WebSocket server -----
const wss = new WebSocketServer({ server });

// ws re-emits http server errors on the WebSocketServer instance, so the
// friendly handler must be attached to wss too (registered listener order
// means the http-level handler alone would never run).
function handleServerError(err){
  if(err && err.code === 'EADDRINUSE'){
    console.error(`\n[!] 启动失败：端口 ${PORT} 已被占用。`);
    console.error(`    常见原因：之前已经开启过一个游戏服务器窗口，或端口被其他程序占用。`);
    console.error(`    解决：关闭旧的服务器窗口后重试；`);
    console.error(`          或用记事本编辑 START_GAME.bat，在启动行前加一句  set PORT=8081`);
    process.exit(1);
  }
  throw err;
}
wss.on('error', handleServerError);
server.on('error', handleServerError);

// Rooms keyed by roomCode. Each room:
// { code, mode, hostId, players: Map<id, playerObj>, state, scores, roundState }
const rooms = new Map();
let nextPlayerId = 1;

// Default config per mode
function defaultConfig(mode){
  if(mode === 'dm')     return { mode, target: 15, respawnDelay: 2.5 };
  if(mode === 'tdm')    return { mode, target: 25, respawnDelay: 2.5 };
  if(mode === 'round')  return { mode, target: 5, respawnDelay: 0, roundMax: 9 }; // best of 9 rounds
  return { mode:'dm', target: 15, respawnDelay: 2.5 };
}

// Pick a random spawn point on the arena perimeter
const SPAWN_POINTS = [
  [ 25, 1.7,  25], [-25, 1.7,  25], [ 25, 1.7, -25], [-25, 1.7, -25],
  [ 0, 1.7,  35], [ 0, 1.7, -35], [ 35, 1.7, 0], [-35, 1.7, 0]
];
function randomSpawn(){
  return SPAWN_POINTS[Math.floor(Math.random()*SPAWN_POINTS.length)];
}

function broadcast(room, msg, exceptId){
  const data = JSON.stringify(msg);
  for(const [id, p] of room.players){
    if(id === exceptId) continue;
    if(p.ws.readyState === 1) p.ws.send(data);
  }
}

function sendTo(player, msg){
  if(player.ws.readyState === 1) player.ws.send(JSON.stringify(msg));
}

function getRoomList(){
  const list = [];
  for(const [code, r] of rooms){
    list.push({ code, mode:r.mode, count:r.players.size, host:r.hostId });
  }
  return list;
}

function sanitizeName(v, id){
  let n = String(v == null ? '' : v).trim().slice(0, 14);
  return n || ('Player' + id);
}

// Remove a player from whichever room they are in. Returns {room, empty} or null.
function removePlayer(id){
  for(const [code, room] of rooms){
    if(room.players.has(id)){
      room.players.delete(id);
      if(room.players.size === 0){
        rooms.delete(code);
        console.log(`    room ${code} destroyed (empty)`);
        return { room, empty:true };
      }
      if(room.hostId === id){
        // Promote next player to host
        room.hostId = [...room.players.keys()][0];
      }
      broadcast(room, { type:'players', players: serializePlayers(room) });
      return { room, empty:false };
    }
  }
  return null;
}

function startMatch(room){
  room.state = 'playing';
  // Reset scores
  for(const p of room.players.values()){
    p.score = 0;
    p.hp = 100;
    p.alive = true;
    const sp = randomSpawn();
    p.pos = sp.slice();
    p.rot = [0, 0];
  }
  if(room.mode === 'round'){
    room.roundNum = 1;
    room.scores = { red:0, blue:0 };
    room.roundState = 'live';
  }
  broadcast(room, { type:'matchStart', mode: room.mode, config: defaultConfig(room.mode) });
  // Send each player their spawn
  for(const [id, p] of room.players){
    sendTo(p, { type:'spawn', pos: p.pos, rot: p.rot });
  }
  // Announce round 1 for round mode (later rounds are announced in checkWinCondition)
  if(room.mode === 'round'){
    broadcast(room, { type:'roundStart', round: room.roundNum });
  }
}

function endMatch(room, winnerInfo){
  room.state = 'ended';
  broadcast(room, { type:'matchEnd', winner: winnerInfo });
  // Reset for lobby
  setTimeout(()=>{
    if(room.players.size > 0){
      room.state = 'lobby';
      room.roundState = null;
      room.roundNum = 0;
      for(const p of room.players.values()){
        p.score = 0; p.hp = 100; p.alive = true;
        p.pos = [0,1.7,0]; p.rot = [0,0];
      }
      broadcast(room, { type:'lobbyState', players: serializePlayers(room) });
    } else {
      rooms.delete(room.code);
    }
  }, 5000);
}

function checkWinCondition(room){
  if(room.mode === 'dm'){
    // First to target kills
    for(const p of room.players.values()){
      if(p.score >= room.config.target){
        endMatch(room, { type:'dm', winnerId: p.id, name: p.name });
        return true;
      }
    }
  } else if(room.mode === 'tdm'){
    const teams = { red:0, blue:0 };
    for(const p of room.players.values()){
      teams[p.team] = (teams[p.team]||0) + p.score;
    }
    if(teams.red >= room.config.target){ endMatch(room, { type:'tdm', team:'red' }); return true; }
    if(teams.blue >= room.config.target){ endMatch(room, { type:'tdm', team:'blue' }); return true; }
  } else if(room.mode === 'round'){
    if(room.roundState !== 'live') return false;
    const aliveByTeam = { red:0, blue:0 };
    for(const p of room.players.values()){
      if(p.alive) aliveByTeam[p.team]++;
    }
    let winningTeam = null;
    if(aliveByTeam.red === 0 && aliveByTeam.blue > 0) winningTeam = 'blue';
    else if(aliveByTeam.blue === 0 && aliveByTeam.red > 0) winningTeam = 'red';
    if(winningTeam){
      room.scores[winningTeam]++;
      room.roundState = 'ended';
      broadcast(room, { type:'roundEnd', team: winningTeam, scores: room.scores });
      // Check match winner
      const needed = Math.ceil(room.config.roundMax/2);
      if(room.scores[winningTeam] >= needed){
        endMatch(room, { type:'round', team: winningTeam });
        return true;
      }
      // Next round in 4s
      setTimeout(()=>{
        room.roundNum++;
        for(const p of room.players.values()){
          p.alive = true;
          p.hp = 100;
          const sp = randomSpawn();
          p.pos = sp.slice();
          p.rot = [0, 0];
          sendTo(p, { type:'spawn', pos: p.pos, rot: p.rot });
          // Re-show this player's avatar on everyone else's screen
          // (deaths hide it locally; without this it stays invisible next round)
          broadcast(room, { type:'playerRespawn', id: p.id, pos: p.pos });
        }
        room.roundState = 'live';
        broadcast(room, { type:'roundStart', round: room.roundNum });
      }, 4000);
      return true;
    }
  }
  return false;
}

function respawnPlayer(room, p){
  if(room.mode === 'round') return;  // no respawn in round mode
  if(!room.players.has(p.id)) return;  // disconnected while waiting
  if(room.state !== 'playing') return; // match ended while waiting
  const sp = randomSpawn();
  p.pos = sp.slice();
  p.hp = 100;
  p.alive = true;
  sendTo(p, { type:'spawn', pos: p.pos, rot: p.rot });
  broadcast(room, { type:'playerRespawn', id: p.id, pos: p.pos }, p.id);
}

wss.on('connection', (ws, req)=>{
  const id = nextPlayerId++;
  console.log(`[+] player ${id} connected from ${req.socket.remoteAddress}`);

  ws.on('message', (raw)=>{
    let msg;
    try{ msg = JSON.parse(raw); }catch(e){ return; }

    switch(msg.type){

      case 'listRooms': {
        sendTo({ws}, { type:'roomList', rooms: getRoomList() });
        break;
      }

      case 'create': {
        // {type:'create', name, mode}
        removePlayer(id); // socket must only ever belong to one room
        let code;
        do { code = Math.random().toString(36).slice(2, 7).toUpperCase(); }
        while(rooms.has(code)); // avoid collision with an existing room
        const mode = ['dm','tdm','round'].includes(msg.mode) ? msg.mode : 'dm';
        const room = {
          code, mode, hostId: id,
          players: new Map(),
          state: 'lobby',
          roundNum: 0, roundState: null,
          config: defaultConfig(mode)
        };
        rooms.set(code, room);
        const player = {
          id, ws, name: sanitizeName(msg.name, id),
          team: mode === 'tdm' || mode === 'round' ? 'red' : null,
          pos:[0,1.7,0], rot:[0,0], hp:100, alive:true, score:0
        };
        room.players.set(id, player);
        sendTo(player, { type:'joinOk', id, code, mode, host: true });
        broadcast(room, { type:'players', players: serializePlayers(room) });
        break;
      }

      case 'join': {
        // {type:'join', code, name}
        const room = rooms.get(String(msg.code||'').trim().toUpperCase());
        if(!room){ sendTo({ws}, { type:'error', msg:'Room not found' }); break; }
        if(room.players.size >= 8){ sendTo({ws}, { type:'error', msg:'Room full' }); break; }
        if(!room.players.has(id)) removePlayer(id); // socket must only ever belong to one room
        // Auto-assign team for team modes
        let team = null;
        if(room.mode === 'tdm' || room.mode === 'round'){
          const counts = { red:0, blue:0 };
          for(const p of room.players.values()) counts[p.team]++;
          team = counts.red <= counts.blue ? 'red' : 'blue';
        }
        const player = {
          id, ws, name: sanitizeName(msg.name, id),
          team, pos:[0,1.7,0], rot:[0,0], hp:100, alive:true, score:0
        };
        room.players.set(id, player);
        sendTo(player, { type:'joinOk', id, code: room.code, mode: room.mode, host: room.hostId === id });
        broadcast(room, { type:'players', players: serializePlayers(room) });
        // If game is in progress, drop newcomer straight into the action
        if(room.state === 'playing'){
          sendTo(player, { type:'matchStart', mode: room.mode, config: room.config });
          const sp = randomSpawn();
          player.pos = sp.slice();
          sendTo(player, { type:'spawn', pos: player.pos, rot: player.rot });
        }
        break;
      }

      case 'leaveRoom': {
        removePlayer(id);
        sendTo({ws}, { type:'leftRoom' });
        break;
      }

      case 'startMatch': {
        // Only host can start
        for(const room of rooms.values()){
          const p = room.players.get(id);
          if(p && room.hostId === id && room.state === 'lobby'){
            startMatch(room);
            break;
          }
        }
        break;
      }

      case 'state': {
        // {type:'state', pos:[x,y,z], rot:[yaw,pitch]}
        const pos = msg.pos, rot = msg.rot;
        const validVec = (v, n) => Array.isArray(v) && v.length === n &&
          v.every(x => typeof x === 'number' && isFinite(x));
        if(!validVec(pos, 3) || !validVec(rot, 2)) break;
        for(const room of rooms.values()){
          const p = room.players.get(id);
          if(p && room.state === 'playing'){
            p.pos = pos;
            p.rot = rot;
            // Echo to others (low-rate, clients throttle to ~20Hz)
            broadcast(room, { type:'state', id, pos, rot }, id);
            break;
          }
        }
        break;
      }

      case 'shoot': {
        // {type:'shoot', origin:[x,y,z], dir:[x,y,z], id (target hit, optional), isHeadshot}
        for(const room of rooms.values()){
          const p = room.players.get(id);
          if(p && room.state === 'playing' && p.alive){
            // Forward the shot to other players so they see tracers
            broadcast(room, { type:'shoot', shooterId: id, origin: msg.origin, dir: msg.dir }, id);
            // If a hit was reported, apply damage
            if(msg.targetId){
              const target = room.players.get(msg.targetId);
              // No friendly fire in team modes
              const sameTeam = target && target.team && target.team === p.team;
              if(target && target.alive && !sameTeam){
                const dmg = msg.isHeadshot ? 100 : 18;
                target.hp -= dmg;
                broadcast(room, { type:'hit', targetId: target.id, shooterId: id, damage: dmg, isHeadshot: !!msg.isHeadshot, targetHp: Math.max(0, target.hp) });
                if(target.hp <= 0){
                  target.hp = 0;
                  target.alive = false;
                  p.score++;
                  broadcast(room, {
                    type:'death', id: target.id, killerId: id,
                    killerName: p.name, victimName: target.name,
                    killerScore: p.score
                  });
                  if(!checkWinCondition(room)){
                    if(room.mode !== 'round'){
                      setTimeout(()=> respawnPlayer(room, target), room.config.respawnDelay * 1000);
                    }
                  }
                }
              }
            }
            break;
          }
        }
        break;
      }

      case 'chat': {
        for(const room of rooms.values()){
          const p = room.players.get(id);
          if(p){
            broadcast(room, { type:'chat', id, name: p.name, text: String(msg.text).slice(0, 200) });
            break;
          }
        }
        break;
      }
    }
  });

  ws.on('close', ()=>{
    console.log(`[-] player ${id} disconnected`);
    const res = removePlayer(id);
    // A disconnect can wipe out a whole team mid-round -> resolve the round
    if(res && !res.empty && res.room.mode === 'round'
       && res.room.state === 'playing' && res.room.roundState === 'live'){
      checkWinCondition(res.room);
    }
  });
});

function serializePlayers(room){
  const arr = [];
  for(const p of room.players.values()){
    arr.push({ id:p.id, name:p.name, team:p.team, score:p.score, hp:p.hp, alive:p.alive, isHost: room.hostId === p.id });
  }
  return arr;
}

server.listen(PORT, ()=>{
  const nets = require('os').networkInterfaces();
  const ips = ['127.0.0.1'];
  for(const name of Object.keys(nets)){
    for(const n of nets[name]){
      if(n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }
  console.log(`NEON STRIKE multiplayer server listening on port ${PORT}`);
  console.log(`Local:    http://localhost:${PORT}/`);
  for(const ip of ips.slice(1)){
    console.log(`Network:  http://${ip}:${PORT}/`);
  }
  console.log(`\nFriends on same Wi-Fi/LAN connect to the Network URL above.`);
  console.log(`If friends can't connect, run 开放防火墙.bat on THIS computer once.`);
});
