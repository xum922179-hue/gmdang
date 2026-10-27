// NEON STRIKE - Multiplayer Server
// Run: node server.js  (default port 8080)
// Clients connect via: ws://<your-ip>:8080
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

// Pick the LAN IPs a friend can actually reach. Multiple adapters (Wi-Fi +
// virtual-box / VMware / Hyper-V / Tailscale…) produce several "IPv4, not
// internal" addresses, and grabbing the first one can hand friends a dead IP
// (e.g. 192.168.56.x from a virtual adapter). We filter out obvious virtual
// adapters and return the real ones, the first being the recommended host.
function getLanIPs(){
  const nets = require('os').networkInterfaces();
  const skipName = /virtual|vmware|vbox|hyper-v|vethernet|docker|wsl|tailscale|zerotier|bridge|loopback|vEthernet/i;
  const skipSub = /^(192\.168\.(56|99|137)\.|172\.(1[6-9]|2\d|3[01])\.|10\.(0|254)\.)/;
  const real = [];
  const rest = [];
  for(const name of Object.keys(nets)){
    for(const n of nets[name] || []){
      if(n.family !== 'IPv4' || n.internal) continue;
      const rec = { name, ip: n.address };
      if(skipName.test(name) || skipSub.test(n.address)) rest.push(rec);
      else real.push(rec);
    }
  }
  return real.length ? real : rest;   // fall back to everything if we over-filtered
}

// ----- Static file server (so clients can also load multiplayer.html from this server) -----
const MIME = { '.html':'text/html', '.js':'application/javascript', '.json':'application/json', '.css':'text/css', '.glb':'model/gltf-binary', '.gltf':'model/gltf+json' };
const server = http.createServer((req, res)=>{
  let p = req.url.split('?')[0];
  if (p === '/' || p === '') { p = '/index.html'; }
  // Return this host's LAN IP so the client can build a real invite link
  // (e.g. http://192.168.x.x:8080/multiplayer.html?room=CODE) even when the
  // host opened the page via localhost. Friends open the link and auto-connect.
  if(p === '/api/host'){
    const lan = getLanIPs();
    const ip = lan.length ? lan[0].ip : 'localhost';
    res.writeHead(200, { 'Content-Type':'application/json', 'Cache-Control':'no-store' });
    return res.end(JSON.stringify({ host: ip, port: PORT }));
  }
  // Block path traversal
  if(p.indexOf('..') >= 0){ res.writeHead(403); return res.end('forbidden'); }
  const file = path.join(__dirname, p);
  fs.readFile(file, (err, data)=>{
    if(err){ res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    });
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

// Pick a random spawn point for the room's map.
const SPAWN_POINTS_ARENA = [
  [ 25, 1.7,  25], [-25, 1.7,  25], [ 25, 1.7, -25], [-25, 1.7, -25],
  [ 0, 1.7,  35], [ 0, 1.7, -35], [ 35, 1.7, 0], [-35, 1.7, 0]
];
// ICE FORTRESS: symmetric 3-lane spawns — red side (south, z=-36) / blue side (north, z=+36)
const SPAWN_POINTS_ICE = [
  [-18, 1.7, -36], [0, 1.7, -36], [18, 1.7, -36],
  [-18, 1.7,  36], [0, 1.7,  36], [18, 1.7,  36]
];
function randomSpawn(map){
  const pts = (map === 'ice') ? SPAWN_POINTS_ICE : SPAWN_POINTS_ARENA;
  return pts[Math.floor(Math.random()*pts.length)];
}

function broadcast(room, msg, exceptId){
  const data = JSON.stringify(msg);
  for(const [id, p] of room.players){
    if(id === exceptId) continue;
    if(!p.ws) continue;   // AI bot 没有 ws，跳过
    if(p.ws.readyState === 1) p.ws.send(data);
  }
}

function sendTo(player, msg){
  if(!player.ws) return;   // AI bot 没有 ws，跳过
  if(player.ws.readyState === 1) player.ws.send(JSON.stringify(msg));
}

function getRoomList(){
  const list = [];
  for(const [code, r] of rooms){
    list.push({ code, mode:r.mode, map:r.map, count:r.players.size, host:r.hostId });
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
        clearBotTick(room);
        rooms.delete(code);
        console.log(`    room ${code} destroyed (empty)`);
        return { room, empty:true };
      }
      if(room.hostId === id){
        // Promote next player (ignoring bots — give host to first real human if possible)
        const next = [...room.players.values()].find(p => !p.isBot);
        room.hostId = next ? next.id : [...room.players.keys()][0];
      }
      broadcast(room, { type:'players', players: serializePlayers(room) });
      return { room, empty:false };
    }
  }
  return null;
}

function getRoomByPlayerId(id){
  for(const room of rooms.values()){
    if(room.players.has(id)) return room;
  }
  return null;
}

function startMatch(room){
  room.state = 'playing';
  room.grenadeSeq = 0;
  // Reset scores
  for(const p of room.players.values()){
    p.score = 0;
    p.hp = 100;
    p.alive = true;
    p.grenades = GRENADE_MAX_PER_LIFE;
    p.lastGrenadeAt = 0;
    p.rockets = 0;   // rocket ultimate charges reset per match
    const sp = randomSpawn(room.map);
    p.pos = sp.slice();
    p.rot = [0, 0];
  }
  if(room.mode === 'round'){
    room.roundNum = 1;
    room.scores = { red:0, blue:0 };
    room.roundState = 'live';
  }
  broadcast(room, { type:'matchStart', mode: room.mode, config: defaultConfig(room.mode), map: room.map });
  // Send each player their spawn
  for(const [id, p] of room.players){
    sendTo(p, { type:'spawn', pos: p.pos, rot: p.rot });
    sendTo(p, { type:'rocketUpdate', rockets: p.rockets });
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
        p.grenades = GRENADE_MAX_PER_LIFE; p.lastGrenadeAt = 0;
        p.rockets = 0;
        p.pos = [0,1.7,0]; p.rot = [0,0];
      }
      broadcast(room, { type:'lobbyState', players: serializePlayers(room) });
    } else {
      clearBotTick(room);
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
          p.grenades = GRENADE_MAX_PER_LIFE;
          p.lastGrenadeAt = 0;
          const sp = randomSpawn(room.map);
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
  const sp = randomSpawn(room.map);
  p.pos = sp.slice();
  p.hp = 100;
  p.alive = true;
  p.grenades = GRENADE_MAX_PER_LIFE;
  sendTo(p, { type:'spawn', pos: p.pos, rot: p.rot });
  broadcast(room, { type:'playerRespawn', id: p.id, pos: p.pos }, p.id);
}

// ============== COMBAT HELPERS ==============
const GRENADE_MAX_PER_LIFE = 3;
const GRENADE_FUSE = 1.6;
const GRENADE_GRAVITY = 18;
const GRENADE_SPEED = 16;
const GRENADE_TOSS_UP = 3.2;
const GRENADE_RADIUS = 6.5;
const GRENADE_CD_MS = 700;

// Shotgun: distance-adaptive damage. Inside SHOTGUN_FULL_R every pellet does
// full damage (8 x 14 = 112 body damage -> one-shot kill up close); beyond it
// per-pellet damage decays linearly down to SHOTGUN_MIN_MUL at SHOTGUN_RANGE.
const SHOTGUN_RANGE   = 42;    // effective pellet range (m), matches client cfg.range
const SHOTGUN_FULL_R  = 12;    // full-damage distance (m)
const SHOTGUN_MIN_MUL = 0.35;  // pellet damage multiplier at max range
const SHOTGUN_DMG_BODY  = 13;
const SHOTGUN_DMG_CHEST = 15;
const SHOTGUN_DMG_HEAD  = 20;

// Rocket-launcher ultimate: 1 rocket granted per 3 kills, ~3x grenade power.
const ROCKET_SPEED  = 45;    // fast, straight flight (m/s)
const ROCKET_RADIUS = 19.5;  // 3x grenade radius (6.5)
const ROCKET_MAX_DMG = 330;  // 3x grenade damage (110)
const ROCKET_MAX_T  = 3;     // auto-detonate after this many seconds
const ROCKET_CD_MS  = 500;

// Apply damage from one player to another. Handles hp broadcast, death scoring,
// win conditions and respawn scheduling. attacker may be null (environment).
function applyDamage(room, target, attacker, dmg, weapon){
  if(room.state !== 'playing' || !target || !target.alive) return;
  target.hp = Math.max(0, target.hp - dmg);
  // Self-inflicted damage (e.g. own grenade) reports no shooter: no hit marker
  const shooterId = (attacker && attacker.id !== target.id) ? attacker.id : null;
  broadcast(room, {
    type:'hit', targetId: target.id, shooterId,
    damage: dmg, isHeadshot: weapon === 'head',
    targetHp: target.hp, weapon: weapon || 'rifle'
  });
  if(target.hp <= 0){
    target.alive = false;
    const selfKill = !attacker || attacker.id === target.id;
    const killer = selfKill ? target : attacker;
    if(!selfKill) attacker.score++;
    // Rocket ultimate: one charge every 3 kills (server-authoritative)
    if(!selfKill && attacker.score % 3 === 0){
      attacker.rockets = (attacker.rockets || 0) + 1;
      sendTo(attacker, { type:'rocketUpdate', rockets: attacker.rockets });
    }
    broadcast(room, {
      type:'death', id: target.id, killerId: killer.id,
      killerName: killer.name, victimName: target.name,
      killerScore: selfKill ? target.score : attacker.score,
      weapon: weapon || 'rifle',
      isHeadshot: weapon === 'head'
    });
    if(!checkWinCondition(room)){
      if(room.mode !== 'round'){
        setTimeout(()=> respawnPlayer(room, target), room.config.respawnDelay * 1000);
      }
    }
  }
}

function isFiniteVec(v, n){
  return Array.isArray(v) && v.length === n &&
    v.every(x => typeof x === 'number' && isFinite(x));
}

// Server-side grenade flight: floor + outer wall bounces (cover pillars are
// cosmetic-only on the server; the blast is AoE so the small divergence is fine).
function simulateGrenade(room, gid, origin, dir, throwerId, gtype){
  const R = 0.12;
  const WALL = 39.7;
  const pos = origin.slice();
  const norm = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const vel = [
    dir[0]/norm * GRENADE_SPEED,
    dir[1]/norm * GRENADE_SPEED + GRENADE_TOSS_UP,
    dir[2]/norm * GRENADE_SPEED
  ];
  const startT = Date.now();
  let lastT = startT;
  const timer = setInterval(()=>{
    if(!rooms.has(room.code)){ clearInterval(timer); return; }
    const now = Date.now();
    let dt = Math.min(0.1, (now - lastT)/1000);
    lastT = now;
    const steps = 2, s = dt/steps;
    for(let k=0; k<steps; k++){
      vel[1] -= GRENADE_GRAVITY * s;
      pos[0] += vel[0]*s;
      pos[1] += vel[1]*s;
      pos[2] += vel[2]*s;
      if(pos[1] < R){
        pos[1] = R;
        if(vel[1] < 0) vel[1] *= -0.45;
        vel[0] *= 0.72; vel[2] *= 0.72;
      }
      if(pos[0] > WALL){ pos[0] = WALL; vel[0] = -Math.abs(vel[0])*0.5; }
      if(pos[0] < -WALL){ pos[0] = -WALL; vel[0] = Math.abs(vel[0])*0.5; }
      if(pos[2] > WALL){ pos[2] = WALL; vel[2] = -Math.abs(vel[2])*0.5; }
      if(pos[2] < -WALL){ pos[2] = -WALL; vel[2] = Math.abs(vel[2])*0.5; }
      // ICE FORTRESS inner walls/crates bounce grenades too
      if(room.map === 'ice'){
        for(const b of ICE_INNER_AABBS){
          if(pos[0] > b.x1-R && pos[0] < b.x2+R && pos[2] > b.z1-R && pos[2] < b.z2+R && pos[1] < b.y2 && pos[1] > b.y1-R){
            const dl = Math.min(pos[0]-b.x1, b.x2-pos[0], pos[2]-b.z1, b.z2-pos[2]);
            if(dl === pos[0]-b.x1){ pos[0] = b.x1-R; vel[0] = Math.abs(vel[0])*0.5; }
            else if(dl === b.x2-pos[0]){ pos[0] = b.x2+R; vel[0] = -Math.abs(vel[0])*0.5; }
            else if(dl === pos[2]-b.z1){ pos[2] = b.z1-R; vel[2] = Math.abs(vel[2])*0.5; }
            else { pos[2] = b.z2+R; vel[2] = -Math.abs(vel[2])*0.5; }
          }
        }
      }
    }
    if(now - startT >= GRENADE_FUSE*1000){
      clearInterval(timer);
      detonateGrenade(room, gid, pos, throwerId, gtype);
    }
  }, 50);
}

function detonateGrenade(room, gid, pos, throwerId, gtype){
  if(!rooms.has(room.code)) return;
  const gt = gtype === 'flash' ? 'flash' : 'frag';
  // Tell every client to render the blast at the authoritative position
  broadcast(room, { type:'grenadeExplode', id:gid, pos:[pos[0],pos[1],pos[2]], throwerId, gtype:gt });
  if(room.state !== 'playing') return;

  const attacker = room.players.get(throwerId) || null;

  // Flashbang: no damage — broadcast the pop, each client decides from its own
  // camera whether the flash is on-screen (line of sight + facing) and blinds
  // them, or is hidden (masked/back turned) and only shows an edge flare.
  if(gt === 'flash'){
    broadcast(room, { type:'flashBang', pos:[pos[0],pos[1],pos[2]], throwerId });
    return;
  }

  const victims = [];
  for(const tp of room.players.values()){
    if(!tp.alive) continue;
    // No friendly fire in team modes; self-damage from your own grenade is allowed
    if(attacker && tp !== attacker && tp.team && tp.team === attacker.team) continue;
    const dx = tp.pos[0]-pos[0], dy = tp.pos[1]-pos[1], dz = tp.pos[2]-pos[2];
    const d = Math.hypot(dx, dy, dz);
    if(d < GRENADE_RADIUS) victims.push({p:tp, d});
  }
  // Closest takes the most damage; apply sequentially so multi-kills resolve
  victims.sort((a,b)=>a.d-b.d);
  for(const v of victims){
    const dmg = Math.round(110 * (1 - v.d/GRENADE_RADIUS));
    if(dmg > 0) applyDamage(room, v.p, attacker, dmg, 'grenade');
  }
}

// Rocket ultimate: fast straight flight (no gravity), explodes on any contact or
// after ROCKET_MAX_T seconds. Blast is 3x grenade radius & damage.
function simulateRocket(room, gid, origin, dir, throwerId){
  const WALL = 39.7;
  const pos = origin.slice();
  const norm = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const vel = [ dir[0]/norm*ROCKET_SPEED, dir[1]/norm*ROCKET_SPEED, dir[2]/norm*ROCKET_SPEED ];
  const startT = Date.now();
  let lastT = startT;
  const timer = setInterval(()=>{
    if(!rooms.has(room.code)){ clearInterval(timer); return; }
    const now = Date.now();
    let dt = Math.min(0.1, (now - lastT)/1000);
    lastT = now;
    const steps = 2, s = dt/steps;
    for(let k=0; k<steps; k++){
      pos[0] += vel[0]*s;
      pos[1] += vel[1]*s;
      pos[2] += vel[2]*s;
      // Contact detonation on floor / outer walls
      if(pos[1] <= 0 || pos[0] > WALL || pos[0] < -WALL || pos[2] > WALL || pos[2] < -WALL){
        clearInterval(timer);
        detonateRocket(room, gid, pos, throwerId);
        return;
      }
      // ICE FORTRESS inner walls/crates explode the rocket too
      if(room.map === 'ice'){
        for(const b of ICE_INNER_AABBS){
          if(pos[0] > b.x1 && pos[0] < b.x2 && pos[2] > b.z1 && pos[2] < b.z2 && pos[1] < b.y2 && pos[1] > b.y1){
            clearInterval(timer);
            detonateRocket(room, gid, pos, throwerId);
            return;
          }
        }
      }
    }
    if(now - startT >= ROCKET_MAX_T*1000){
      clearInterval(timer);
      detonateRocket(room, gid, pos, throwerId);
    }
  }, 30);
}

function detonateRocket(room, gid, pos, throwerId){
  if(!rooms.has(room.code)) return;
  broadcast(room, { type:'rocketExplode', id:gid, pos:[pos[0],pos[1],pos[2]], throwerId });
  if(room.state !== 'playing') return;
  const attacker = room.players.get(throwerId) || null;
  const victims = [];
  for(const tp of room.players.values()){
    if(!tp.alive) continue;
    // No friendly fire in team modes; self-damage allowed
    if(attacker && tp !== attacker && tp.team && tp.team === attacker.team) continue;
    const dx = tp.pos[0]-pos[0], dy = tp.pos[1]-pos[1], dz = tp.pos[2]-pos[2];
    const d = Math.hypot(dx, dy, dz);
    if(d < ROCKET_RADIUS) victims.push({p:tp, d});
  }
  victims.sort((a,b)=>a.d-b.d);
  for(const v of victims){
    const dmg = Math.round(ROCKET_MAX_DMG * (1 - v.d/ROCKET_RADIUS));
    if(dmg > 0) applyDamage(room, v.p, attacker, dmg, 'rocket');
  }
}

// ═══════════════════════════════════════════════════
// DETERMINISTIC SOLID GEOMETRY — MUST match the client arenas
// (multiplayer.html buildArena). Bullets are blocked by these so shots can't
// pass through walls/cover. The layout is fixed (not random) so every client
// and the server agree on where the cover is.
// ═══════════════════════════════════════════════════
const MULTI_PILLARS = [
  { x:  0,  z:  14, w: 2.4, h: 3.0 },
  { x:  0,  z: -14, w: 2.4, h: 3.0 },
  { x:  14, z:  0,  w: 2.4, h: 3.0 },
  { x: -14, z:  0,  w: 2.4, h: 3.0 },
  { x:  10, z:  10, w: 2.0, h: 2.6 },
  { x: -10, z: -10, w: 2.0, h: 2.6 },
  { x: -10, z:  10, w: 2.0, h: 2.6 },
  { x:  10, z: -10, w: 2.0, h: 2.6 },
];
const WALL_CENTER = 40;            // outer wall center (ARENA_SIZE)
const WALL_THICK = 1.0;            // wall box depth
const WALL_MINY = 0, WALL_MAXY = 10;
const WALL_INNER = WALL_CENTER - WALL_THICK/2;  // 39.5
const WALL_OUTER = WALL_CENTER + WALL_THICK/2;  // 40.5

// ICE FORTRESS ("冰雪堡垒") solids — 田字形, no height differences.
// Two horizontal walls with a central gap keep the middle lane straight
// (long sightline for snipers) and four tall blocks form the central
// crossroads, leaving the lanes fully open. MUST match the clients.
function buildIceSolids(){
  const R = WALL_CENTER, list = [];
  // Central crossroads cover — 4 tall square blocks (14×14×6.3), centre open.
  // Left/right moved out (cx0=11.5): middle lane ~9m, waist ~8m, no overlap.
  const cx0 = 11.5, cz0 = 11, hw = 7, dz = 7;
  for(const [sx,sz] of [[-1,-1],[1,-1],[-1,1],[1,1]]){
    list.push({ x1:sx*cx0-hw, x2:sx*cx0+hw, y1:0, y2:6.3, z1:sz*cz0-dz, z2:sz*cz0+dz });
  }
  // Low cuboid covers (6×3×2.2, body-height), flush along outer edges from
  // each corner, as in the reference sketch. 0.05 offset avoids z-fighting.
  const shw = 3, sdz = 1.5, sch = 2.2;
  const sx0 = 21.55, sz0 = 18;
  for(const [sx,sz] of [[-1,-1],[1,-1],[-1,1],[1,1]]){
    list.push({ x1:sx*sx0-shw, x2:sx*sx0+shw, y1:0, y2:sch, z1:sz*sz0-sdz, z2:sz*sz0+sdz });
  }
  // Walkable ramps (north + south) — stepped AABB approximation of the slopes,
  // so bullets/grenades collide with them. Mirrored around the centre.
  const rw = 3;
  const northHeights = [0.75, 1.5, 2.25, 3];   // z: -34 → -26
  const southHeights = [3, 2.25, 1.5, 0.75];   // z: 26 → 34
  for(let i=0;i<4;i++){
    list.push({ x1:-rw, x2:rw, y1:0, y2:northHeights[i], z1:-34+i*2, z2:-32+i*2 });
    list.push({ x1:-rw, x2:rw, y1:0, y2:southHeights[i], z1:26+i*2, z2:28+i*2 });
  }
  list.push({ x1:-rw, x2:rw, y1:0, y2:3, z1:-26, z2:-24 });   // north landing
  list.push({ x1:-rw, x2:rw, y1:0, y2:3, z1:24, z2:26 });     // south landing
  return list;
}

function buildSolidAABBs(map){
  const S = WALL_CENTER, list = [];
  list.push({ x1:-S-1, x2:S+1, y1:WALL_MINY, y2:WALL_MAXY, z1:WALL_INNER, z2:WALL_OUTER });
  list.push({ x1:-S-1, x2:S+1, y1:WALL_MINY, y2:WALL_MAXY, z1:-WALL_OUTER, z2:-WALL_INNER });
  list.push({ x1:WALL_INNER, x2:WALL_OUTER, y1:WALL_MINY, y2:WALL_MAXY, z1:-S-1, z2:S+1 });
  list.push({ x1:-WALL_OUTER, x2:-WALL_INNER, y1:WALL_MINY, y2:WALL_MAXY, z1:-S-1, z2:S+1 });
  if(map === 'ice'){
    list.push(...buildIceSolids());
  } else {
    for(const p of MULTI_PILLARS){
      const hw = p.w/2;
      list.push({ x1:p.x-hw, x2:p.x+hw, y1:0, y2:p.h, z1:p.z-hw, z2:p.z+hw });
    }
  }
  return list;
}
const SOLID_AABBS = buildSolidAABBs('arena');
const ICE_AABBS = buildSolidAABBs('ice');
const ICE_INNER_AABBS = buildIceSolids(); // grenade bounce targets (no outer walls)
function solidsFor(map){ return map === 'ice' ? ICE_AABBS : SOLID_AABBS; }

// Slab-method ray / AABB intersection. Returns entry distance t (>=0) or null.
function rayIntersectsAABB(ox,oy,oz, dx,dy,dz, x1,y1,z1,x2,y2,z2){
  let tmin = 0, tmax = Infinity;
  const os = [ox,oy,oz], ds = [dx,dy,dz], mn = [x1,y1,z1], mx = [x2,y2,z2];
  for(let i=0;i<3;i++){
    const o = os[i], d = ds[i];
    if(Math.abs(d) < 1e-9){
      if(o < mn[i] || o > mx[i]) return null;
    } else {
      let t1 = (mn[i]-o)/d, t2 = (mx[i]-o)/d;
      if(t1 > t2){ const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if(tmin > tmax) return null;
    }
  }
  return tmin;
}

// Is the shot from `origin` toward `targetPos` blocked by a wall/pillar before
// reaching the target? Returns true if any solid is in the way.
function shotBlocked(origin, targetPos, map){
  const dx = targetPos[0]-origin[0], dy = targetPos[1]-origin[1], dz = targetPos[2]-origin[2];
  const dist = Math.hypot(dx, dy, dz);
  if(dist <= 0) return false;
  const inv = 1/dist;
  const dir = [dx*inv, dy*inv, dz*inv];
  for(const b of solidsFor(map)){
    const t = rayIntersectsAABB(origin[0],origin[1],origin[2], dir[0],dir[1],dir[2],
      b.x1,b.y1,b.z1,b.x2,b.y2,b.z2);
    if(t !== null && t < dist - 0.4) return true;
  }
  return false;
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
        // {type:'create', name, mode, map}
        removePlayer(id); // socket must only ever belong to one room
        let code;
        do { code = Math.random().toString(36).slice(2, 7).toUpperCase(); }
        while(rooms.has(code)); // avoid collision with an existing room
        const mode = ['dm','tdm','round'].includes(msg.mode) ? msg.mode : 'dm';
        const map = (msg.map === 'ice') ? 'ice' : 'arena';
        const room = {
          code, mode, map, hostId: id,
          players: new Map(),
          state: 'lobby',
          roundNum: 0, roundState: null,
          config: defaultConfig(mode)
        };
        rooms.set(code, room);
        const player = {
          id, ws, name: sanitizeName(msg.name, id),
          team: mode === 'tdm' || mode === 'round' ? 'red' : null,
          pos:[0,1.7,0], rot:[0,0], hp:100, alive:true, score:0,
          grenades: GRENADE_MAX_PER_LIFE, lastGrenadeAt: 0,
          rockets: 0,   // rocket ultimate charges (1 per 3 kills)
          weapon: 'rifle'  // current weapon slot, synced to remote players
        };
        room.players.set(id, player);
        sendTo(player, { type:'joinOk', id, code, mode, map, host: true });
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
          team, pos:[0,1.7,0], rot:[0,0], hp:100, alive:true, score:0,
          grenades: GRENADE_MAX_PER_LIFE, lastGrenadeAt: 0,
          rockets: 0,   // rocket ultimate charges (1 per 3 kills)
          weapon: 'rifle'  // current weapon slot, synced to remote players
        };
        room.players.set(id, player);
        sendTo(player, { type:'joinOk', id, code: room.code, mode: room.mode, map: room.map, host: room.hostId === id });
        broadcast(room, { type:'players', players: serializePlayers(room) });
        // If game is in progress, drop newcomer straight into the action
        if(room.state === 'playing'){
          sendTo(player, { type:'matchStart', mode: room.mode, config: room.config, map: room.map });
          const sp = randomSpawn(room.map);
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

      // Host-only: add/remove AI bots
      case 'addBot': {
        const room = getRoomByPlayerId(id);
        if(!room || room.hostId !== id) break;
        const bot = addBotToRoom(room);
        if(bot){
          broadcast(room, { type:'players', players: serializePlayers(room) });
          if(room.state === 'playing'){
            broadcast(room, { type:'spawn', pos:bot.pos, rot:bot.rot, id:bot.id });
            if(room.mode === 'tdm' || room.mode === 'round'){
              broadcast(room, { type:'playerRespawn', id:bot.id, pos:bot.pos });
            }
          }
        } else {
          sendTo({ws}, { type:'error', msg:'Room full (max 8 players)' });
        }
        break;
      }
      case 'removeBot': {
        const room = getRoomByPlayerId(id);
        if(!room || room.hostId !== id) break;
        let removed = false;
        for(const [pid, p] of room.players){
          if(p.isBot){ removed = removeBotFromRoom(room, pid); break; }
        }
        if(removed){ broadcast(room, { type:'players', players: serializePlayers(room) }); }
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

      case 'weapon': {
        // {type:'weapon', weapon:'rifle'|'sniper'|'shotgun'|'knife'|'grenade'}
        const weapon = msg.weapon;
        if(weapon !== 'rifle' && weapon !== 'sniper' && weapon !== 'shotgun' && weapon !== 'knife' && weapon !== 'grenade') break;
        for(const room of rooms.values()){
          const p = room.players.get(id);
          if(p){
            p.weapon = weapon;
            broadcast(room, { type:'weapon', id, weapon });
            break;
          }
        }
        break;
      }

      case 'shoot': {
        // {type:'shoot', origin:[x,y,z], dir:[x,y,z], targetId, isHeadshot, weapon}
        for(const room of rooms.values()){
          const p = room.players.get(id);
          if(p && room.state === 'playing' && p.alive){
            // Forward the shot to other players so they see tracers
            broadcast(room, {
              type:'shoot', shooterId: id,
              origin: msg.origin, dir: msg.dir,
              weapon: (msg.weapon === 'sniper' || msg.weapon === 'shotgun') ? msg.weapon : 'rifle'
            }, id);
            // If a hit was reported, apply damage
            // Bullets are blocked by walls/cover: if a solid lies between the
            // shooter's eye and the target, the shot can't land (server-authoritative
            // wall check — mirrors the client's own raycast).
            const shooterEye = [p.pos[0], p.pos[1] + 1.5, p.pos[2]];
            if(msg.weapon === 'shotgun' && Array.isArray(msg.pellets)){
              // Shotgun: verify every reported pellet (range + wall block) and
              // apply its damage independently. Damage falls off with distance:
              // full burst inside SHOTGUN_FULL_R kills a body shot outright,
              // far pellets only chip (min SHOTGUN_MIN_MUL at max range).
              for(const pl of msg.pellets){
                if(!pl || !pl.targetId) continue;
                const target = room.players.get(pl.targetId);
                if(!target || !target.alive) continue;
                if(target.team && target.team === p.team) continue;
                const dt3 = Math.hypot(target.pos[0]-shooterEye[0], target.pos[1]-shooterEye[1], target.pos[2]-shooterEye[2]);
                if(dt3 > SHOTGUN_RANGE) continue;
                if(shotBlocked(shooterEye, target.pos, room.map)) continue;
                let mul = 1;
                if(dt3 > SHOTGUN_FULL_R){
                  mul = 1 - (1 - SHOTGUN_MIN_MUL) * (dt3 - SHOTGUN_FULL_R) / (SHOTGUN_RANGE - SHOTGUN_FULL_R);
                  if(mul < SHOTGUN_MIN_MUL) mul = SHOTGUN_MIN_MUL;
                }
                const zone = (pl.zone === 'chest') ? 'chest' : (pl.isHeadshot ? 'head' : 'body');
                const base = zone === 'head' ? SHOTGUN_DMG_HEAD : (zone === 'chest' ? SHOTGUN_DMG_CHEST : SHOTGUN_DMG_BODY);
                applyDamage(room, target, p, Math.max(1, Math.round(base * mul)), zone === 'head' ? 'head' : 'shotgun');
              }
            } else if(Array.isArray(msg.targets) && msg.targets.length){
              // Sniper pierce: up to 3 distinct players, nearest first,
              // damage falls off 0.65x per subsequent target
              // Head OR chest = instant kill; other body hits stay heavy (90)
              const seen = new Set();
              let n = 0;
              for(const th of msg.targets){
                if(!th || seen.has(th.targetId)) continue;
                seen.add(th.targetId);
                const target = room.players.get(th.targetId);
                if(n >= 3) break;
                if(!target || !target.alive) continue;
                if(target.team && target.team === p.team) continue;
                if(shotBlocked(shooterEye, target.pos, room.map)) continue; // wall in the way
                const lethal = th.isHeadshot || th.zone === 'chest';
                const dmg = lethal ? 100 : Math.round(90 * Math.pow(0.65, n));
                applyDamage(room, target, p, dmg, th.isHeadshot ? 'head' : 'sniper');
                n++;
              }
            } else if(msg.targetId){
              const target = room.players.get(msg.targetId);
              // No friendly fire in team modes
              const sameTeam = target && target.team && target.team === p.team;
              if(target && target.alive && !sameTeam && !shotBlocked(shooterEye, target.pos, room.map)){
                const isSniper = msg.weapon === 'sniper';
                // Headshot always kills; sniper chest hit also one-shot kills;
                // sniper body hits much harder than rifle
                const lethal = msg.isHeadshot || (isSniper && msg.zone === 'chest');
                const dmg = lethal ? 100 : (isSniper ? 90 : 18);
                applyDamage(room, target, p, dmg, msg.isHeadshot ? 'head' : (isSniper ? 'sniper' : 'rifle'));
              }
            }
            break;
          }
        }
        break;
      }

      case 'knife': {
        // {type:'knife', targetId, heavy?} — melee swing, validated
        // light = 55 dmg, 2.9m / 60°; heavy = 100 dmg, 3.2m / 65°
        const heavy = !!msg.heavy;
        for(const room of rooms.values()){
          const p = room.players.get(id);
          if(p && room.state === 'playing' && p.alive){
            const target = room.players.get(msg.targetId);
            if(!target || !target.alive) break;
            if(target.team && target.team === p.team) break;
            const shooterEye = [p.pos[0], p.pos[1] + 1.5, p.pos[2]];
            const dx = target.pos[0] - p.pos[0], dz = target.pos[2] - p.pos[2];
            const hDist = Math.hypot(dx, dz);
            if(hDist > (heavy ? 3.2 : 2.9)) break;            // horizontal reach
            if(Math.abs(target.pos[1] - p.pos[1]) > 3.4) break; // vertical reach (ramps)
            if(shotBlocked(shooterEye, target.pos, room.map)) break;
            // Facing check via the shooter's yaw (THREE YXZ: facing = (-sin yaw, -cos yaw))
            const yaw = p.rot ? p.rot[0] : 0;
            const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
            const dl = hDist || 1;
            if((fx*dx + fz*dz) / dl < (heavy ? 0.42 : 0.5)) break;
            applyDamage(room, target, p, heavy ? 100 : 55, 'knife');
            break;
          }
        }
        break;
      }

      case 'grenadeThrow': {
        // {type:'grenadeThrow', origin:[x,y,z], dir:[x,y,z], gtype:'frag'|'flash'}
        if(!isFiniteVec(msg.origin, 3) || !isFiniteVec(msg.dir, 3)) break;
        const gtype = msg.gtype === 'flash' ? 'flash' : 'frag';
        for(const room of rooms.values()){
          const p = room.players.get(id);
          if(p && room.state === 'playing' && p.alive){
            const now = Date.now();
            if(p.lastGrenadeAt && now - p.lastGrenadeAt < GRENADE_CD_MS) break;
            if((p.grenades || 0) <= 0) break;
            // Reject a zero / NaN-laden direction
            const dl = Math.hypot(msg.dir[0], msg.dir[1], msg.dir[2]);
            if(!(dl > 0)) break;
            p.lastGrenadeAt = now;
            p.grenades--;
            // Keep the throw origin sane (eye height, inside the arena)
            const origin = [
              Math.max(-40, Math.min(40, msg.origin[0])),
              Math.max(0, Math.min(12, msg.origin[1])),
              Math.max(-40, Math.min(40, msg.origin[2]))
            ];
            room.grenadeSeq = (room.grenadeSeq || 0) + 1;
            const gid = room.grenadeSeq;
            // Broadcast to EVERYONE (including thrower): single sim entry point
            broadcast(room, {
              type:'grenadeThrow', id:gid, throwerId:id,
              origin, dir:[msg.dir[0],msg.dir[1],msg.dir[2]],
              grenades: p.grenades, gtype
            });
            simulateGrenade(room, gid, origin, msg.dir, id, gtype);
            break;
          }
        }
        break;
      }

      case 'rocketFire': {
        // {type:'rocketFire', origin:[x,y,z], dir:[x,y,z]} — rocket ultimate
        if(!isFiniteVec(msg.origin, 3) || !isFiniteVec(msg.dir, 3)) break;
        for(const room of rooms.values()){
          const p = room.players.get(id);
          if(p && room.state === 'playing' && p.alive){
            const now = Date.now();
            if(p.lastRocketAt && now - p.lastRocketAt < ROCKET_CD_MS) break;
            if((p.rockets || 0) <= 0) break;
            const dl = Math.hypot(msg.dir[0], msg.dir[1], msg.dir[2]);
            if(!(dl > 0)) break;
            p.lastRocketAt = now;
            p.rockets--;
            sendTo(p, { type:'rocketUpdate', rockets: p.rockets });
            const origin = [
              Math.max(-40, Math.min(40, msg.origin[0])),
              Math.max(0, Math.min(12, msg.origin[1])),
              Math.max(-40, Math.min(40, msg.origin[2]))
            ];
            room.rocketSeq = (room.rocketSeq || 0) + 1;
            const gid = room.rocketSeq;
            // Everyone (including the shooter) renders the same flying rocket
            broadcast(room, {
              type:'rocketFire', id:gid, throwerId:id,
              origin, dir:[msg.dir[0],msg.dir[1],msg.dir[2]]
            });
            simulateRocket(room, gid, origin, msg.dir, id);
            break;
          }
        }
        break;
      }

      case 'bulletHole': {
        // {type:'bulletHole', pos:[x,y,z], normal:[nx,ny,nz], color?}
        // A bullet hit a wall/cover — relay the hole to everyone else so all
        // clients render the same decal on the same deterministic geometry.
        if(!isFiniteVec(msg.pos, 3) || !isFiniteVec(msg.normal, 3)) break;
        for(const room of rooms.values()){
          if(room.players.has(id)){
            broadcast(room, { type:'bulletHole', pos: msg.pos, normal: msg.normal, color: msg.color }, id);
            break;
          }
        }
        break;
      }

      case 'reload': {
        // {type:'reload'} — player started a reload; tell others so they can
        // animate that player's weapon dip.
        for(const room of rooms.values()){
          const p = room.players.get(id);
          if(p){
            broadcast(room, { type:'reload', id, weapon: p.weapon || 'rifle' }, id);
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
    arr.push({ id:p.id, name:p.name, team:p.team, score:p.score, hp:p.hp, alive:p.alive, isHost: room.hostId === p.id, weapon: p.weapon || 'rifle', isBot: !!p.isBot });
  }
  return arr;
}

// ============ AI BOT 模块 ============
let botNames = ['NovaEcho','Shadow7','Viper','Blaze','Ghost','Raven','Hawk','Frost','Onyx','Zero','Reaper','Loki'];
function pickBotName(room){
  const taken = new Set([...room.players.values()].map(p=>p.name));
  for(const n of botNames){ if(!taken.has(n)) return n; }
  return 'Bot' + Math.floor(Math.random()*9000+1000);
}

// Spawn an AI bot in room. Returns the new player or null if room full.
function addBotToRoom(room){
  if(room.players.size >= 8) return null;
  const id = nextPlayerId++;
  const isTeam = room.mode === 'tdm' || room.mode === 'round';
  let team = null;
  if(isTeam){
    const counts = { red:0, blue:0 };
    for(const p of room.players.values()) counts[p.team]++;
    team = counts.red <= counts.blue ? 'red' : 'blue';
  }
  const bot = {
    id, ws:null, isBot:true,
    name: pickBotName(room),
    team,
    pos: randomSpawn(room.map), rot:[0, 0],
    hp:100, alive:true, score:0,
    grenades: GRENADE_MAX_PER_LIFE, lastGrenadeAt:0,
    rockets: 0, weapon:'rifle',
    // bot internal state
    targetPos: null, targetTimer: 0, state: 'patrol', moveDir: null,
    shootCooldown: 0, aimLead: 0, _map: room.map,
  };
  room.players.set(id, bot);
  // 如果 match 已在进行，bot 也立即出生到场里
  if(room.state === 'playing'){
    bot.pos = randomSpawn(room.map);
    broadcast(room, { type:'spawn', pos: bot.pos, rot: bot.rot, id: bot.id });
    if(isTeam) broadcast(room, { type:'playerRespawn', id: bot.id, pos: bot.pos });
  }
  // 确保房间有 bot tick
  ensureBotTick(room);
  return bot;
}

function removeBotFromRoom(room, botId){
  const bot = room.players.get(botId);
  if(bot && bot.isBot){
    room.players.delete(botId);
    broadcast(room, { type:'players', players: serializePlayers(room) });
    if(bot.ws) try{ bot.ws.close(); }catch(_){}
    return true;
  }
  return false;
}

// Per-room bot tick (50ms). Lazy-created when first bot added; cleared when room destroyed.
function ensureBotTick(room){
  if(room._botTimer) return;
  room._botTimer = setInterval(()=>{ botTick(room); }, 50);
}

function clearBotTick(room){
  if(room._botTimer){ clearInterval(room._botTimer); room._botTimer = null; }
}

// Main AI tick. Every ~50ms each bot does:
//   1) find nearest alive visible enemy (same team check)
//   2) if enemy found -> face them, maybe shoot (blocked by shotBlocked)
//   3) else patrol toward random point
function botTick(room){
  if(!room._botTimer) return;
  const bots = [...room.players.values()].filter(p => p.isBot);
  if(bots.length === 0){ clearBotTick(room); return; }
  if(room.state !== 'playing') return;

  for(const bot of bots){
    if(!bot.alive){
      // AI 不会主动复活 —— 让服务器 respawnPlayer 处理（它只跳过 bot.ws 但仍然调 applyDamage/score 等逻辑）
      continue;
    }

    // 找最近活敌（队友跳过）
    let best = null, bestDist = Infinity;
    for(const p of room.players.values()){
      if(p === bot) continue;
      if(!p.alive) continue;
      if(bot.team && p.team && p.team === bot.team) continue;   // DM mode 没有 team
      const dx = p.pos[0]-bot.pos[0], dy = p.pos[1]-bot.pos[1], dz = p.pos[2]-bot.pos[2];
      const d = Math.hypot(dx, dz);   // 平面距离
      if(d < bestDist){ bestDist = d; best = p; }
    }

    // 瞄准 + 射击
    bot.shootCooldown = Math.max(0, bot.shootCooldown - 0.05);
    if(best && bestDist < 55){
      // 视线检测（复用 server 已有的墙/柱子检测）
      const shooterEye = [bot.pos[0], bot.pos[1] + 1.5, bot.pos[2]];
      const blocked = shotBlocked(shooterEye, best.pos, room.map);
      if(!blocked){
        // 转向敌人（平滑）
        const targetYaw = Math.atan2(best.pos[0]-bot.pos[0], best.pos[2]-bot.pos[2]);
        bot.rot[0] = lerpAngle(bot.rot[0], targetYaw, 0.12);
        bot.rot[1] = 0;  // 不做 pitch 偏移，简化
        // 射击决策（距离越近越容易开枪；带 250~600ms 冷却模拟人枪节奏）
        const inRange = bestDist < 40;
        const facingOk = Math.abs(normalizeAngle(targetYaw - bot.rot[0])) < 0.25;  // ~15° 容差
        if(inRange && facingOk && bot.shootCooldown <= 0 && Math.random() < 0.7){
          bot.shootCooldown = 0.25 + Math.random()*0.35;
          // 以 bot 为攻击者，对 best 造成步枪伤害；爆头概率小（bot 不神）
          const isHeadshot = Math.random() < 0.12;
          const dmg = isHeadshot ? 100 : 18;
          applyDamage(room, best, bot, dmg, isHeadshot ? 'head' : 'rifle');
        }
      }
      // 同时向敌人方向走动（保持 10~25m 交火距离）
      if(!blocked){
        const wantDist = 16;
        const moveMag = bestDist > wantDist ? 3.2 : (bestDist < wantDist-3 ? -2.0 : 0);
        const nx = best.pos[0], nz = best.pos[2];
        moveBot(bot, [nx-bot.pos[0], 0, nz-bot.pos[2]], moveMag);
      } else {
        // 墙挡着 -> 换目标点绕路
        bot.targetTimer = 0;
      }
    } else {
      // 巡逻
      bot.targetTimer -= 0.05;
      if(!bot.targetPos || bot.targetTimer <= 0){
        const p = randomSpawn(room.map);
        bot.targetPos = p;
        bot.targetTimer = 4 + Math.random()*3;
      }
      const dx = bot.targetPos[0]-bot.pos[0], dz = bot.targetPos[2]-bot.pos[2];
      const d = Math.hypot(dx, dz);
      if(d > 1){
        const targetYaw = Math.atan2(dx, dz);
        bot.rot[0] = lerpAngle(bot.rot[0], targetYaw, 0.08);
        moveBot(bot, [dx, 0, dz], 2.5);
      }
    }

    // 广播 bot 最新 pos/rot 给所有真人客户端（每 bot 每 50ms 一次，局域网 OK）
    broadcast(room, { type:'state', id: bot.id, pos: bot.pos.slice(), rot: bot.rot.slice() });
  }
}

function lerpAngle(a, b, t){
  const d = normalizeAngle(b - a);
  return a + d * t;
}
function normalizeAngle(a){
  while(a >  Math.PI) a -= Math.PI*2;
  while(a < -Math.PI) a += Math.PI*2;
  return a;
}

// Check whether a point (with player-radius padding) is inside any solid AABB.
// Used by bot movement so AI can't walk through walls/columns.
const PLAYER_RADIUS = 0.45;
function pointBlocked(x, z, map){
  for(const b of solidsFor(map)){
    if(x > b.x1 - PLAYER_RADIUS && x < b.x2 + PLAYER_RADIUS &&
       z > b.z1 - PLAYER_RADIUS && z < b.z2 + PLAYER_RADIUS){
      // 跳过 y<0 或 y>3 的固体（比如地面/天花板不算障碍，bot 在地面层 y=1.7）
      if(b.y2 < 0.2 || b.y1 > 3.0) continue;
      return true;
    }
  }
  return false;
}

// Move bot in direction dir (dx,dy,dz) by `speed` m/s for 0.05s tick.
// Collides against interior walls/columns with wall-sliding (try X-only, Z-only).
function moveBot(bot, dir, speed){
  if(speed === 0) return;
  const norm = Math.hypot(dir[0], dir[2]) || 1;
  const vx = (dir[0]/norm) * speed;
  const vz = (dir[2]/norm) * speed;
  const dt = 0.05;
  const nx = bot.pos[0] + vx*dt;
  const nz = bot.pos[2] + vz*dt;
  const BOUND = 39.5;
  const map = bot._map || 'arena';

  // 先尝试完整移动
  if(!pointBlocked(nx, nz, map)){
    bot.pos = [clamp(nx), bot.pos[1], clamp(nz)];
    return;
  }
  // 滑墙：只沿 X 轴移动
  if(!pointBlocked(nx, bot.pos[2], map)){
    bot.pos = [clamp(nx), bot.pos[1], clamp(bot.pos[2])];
    return;
  }
  // 滑墙：只沿 Z 轴移动
  if(!pointBlocked(bot.pos[0], nz, map)){
    bot.pos = [clamp(bot.pos[0]), bot.pos[1], clamp(nz)];
    return;
  }
  // 完全卡住 → 不动，强制换巡逻目标
  bot.targetTimer = 0;
}
function clamp(v){ return Math.max(-39.5, Math.min(39.5, v)); }

// ============ END AI BOT ============

server.listen(PORT, ()=>{
  const lan = getLanIPs();
  const ips = ['127.0.0.1'].concat(lan.map(x=>x.ip));
  console.log(`NEON STRIKE multiplayer server listening on port ${PORT}`);
  console.log(`Local:    http://localhost:${PORT}/`);
  for(const ip of ips.slice(1)){
    console.log(`Network:  http://${ip}:${PORT}/  ${ip === lan[0].ip ? '<-- 推荐 / recommended' : ''}`);
  }
  console.log(`\nFriends on same Wi-Fi/LAN open the recommended Network URL above,`);
  console.log(`or open http://<主机IP>:${PORT}/  and type the host IP to join.`);
  console.log(`If friends can't connect, run 开放防火墙.bat on THIS computer once.`);
});
