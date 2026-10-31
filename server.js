const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { Room } = require('./src/room');

const PORT = process.env.PORT || 3000;
const ROOM_TTL_MS = 3 * 60 * 60 * 1000;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const pub = path.join(__dirname, 'public');
app.use(express.static(pub));
app.get('/host', (req, res) => res.sendFile(path.join(pub, 'host.html')));
app.get('/play', (req, res) => res.sendFile(path.join(pub, 'play.html')));

const rooms = new Map();

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function broadcast(room) {
  const hv = room.hostView();
  for (const sid of room.hostSockets) io.to(sid).emit('host:state', hv);
  for (const p of room.players.values()) {
    if (p.socketId) io.to(p.socketId).emit('player:state', room.playerView(p.id));
  }
}

function createRoom() {
  const code = newCode();
  const room = new Room(code, () => broadcast(room));
  rooms.set(code, room);
  return room;
}

const reply = (cb, data) => typeof cb === 'function' && cb(data);

io.on('connection', (socket) => {
  const room = () => rooms.get(socket.data.code);

  socket.on('host:create', (_, cb) => {
    const r = createRoom();
    socket.data = { role: 'host', code: r.code };
    r.hostSockets.add(socket.id);
    reply(cb, { code: r.code });
    broadcast(r);
  });

  socket.on('host:resume', ({ code } = {}, cb) => {
    const r = rooms.get(String(code || '').toUpperCase());
    if (!r) return reply(cb, { error: 'Room not found' });
    socket.data = { role: 'host', code: r.code };
    r.hostSockets.add(socket.id);
    reply(cb, { code: r.code });
    broadcast(r);
  });

  socket.on('host:qr', ({ url } = {}, cb) => {
    QRCode.toDataURL(String(url), { margin: 1, width: 400 })
      .then((dataUrl) => reply(cb, { dataUrl }))
      .catch(() => reply(cb, { error: 'QR failed' }));
  });

  socket.on('host:action', ({ action } = {}, cb) => {
    const r = room();
    if (!r || socket.data.role !== 'host') return reply(cb, { error: 'No room' });
    const error = r.hostAction(action);
    reply(cb, { error: error || null });
    broadcast(r);
  });

  socket.on('player:join', ({ code, name, playerId } = {}, cb) => {
    const r = rooms.get(String(code || '').trim().toUpperCase());
    if (!r) return reply(cb, { error: 'Room not found — check the code on the TV' });
    const { player, error } = r.join(name, playerId);
    if (error) return reply(cb, { error });

    // Kick a stale socket still bound to this seat (e.g. old tab).
    if (player.socketId && player.socketId !== socket.id) {
      io.to(player.socketId).emit('player:replaced');
    }
    player.socketId = socket.id;
    player.connected = true;
    socket.data = { role: 'player', code: r.code, playerId: player.id };
    r.touch();
    reply(cb, { code: r.code, playerId: player.id });
    broadcast(r);
  });

  socket.on('player:action', (msg = {}, cb) => {
    const r = room();
    if (!r || socket.data.role !== 'player') return reply(cb, { error: 'Not in a room' });
    if (msg.type === 'kick') {
      if (socket.data.playerId !== r.vipId) return reply(cb, { error: 'Only the ♛ VIP can do that' });
      if (msg.name === r.players.get(socket.data.playerId)?.name) return reply(cb, { error: "You can't remove yourself" });
      const { player, error } = r.kick(msg.name);
      if (player?.socketId) io.to(player.socketId).emit('player:kicked');
      reply(cb, { error: error || null });
      return broadcast(r);
    }
    const error = r.playerAction(socket.data.playerId, msg);
    reply(cb, { error: error || null });
    broadcast(r);
  });

  socket.on('disconnect', () => {
    const r = room();
    if (!r) return;
    if (socket.data.role === 'host') {
      r.hostSockets.delete(socket.id);
    } else if (socket.data.role === 'player') {
      const p = r.players.get(socket.data.playerId);
      if (p && p.socketId === socket.id) {
        p.connected = false;
        p.socketId = null;
      }
    }
    broadcast(r);
  });
});

// Drop rooms nobody has touched in a while.
setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, r] of rooms) {
    if (r.lastActive < cutoff && r.hostSockets.size === 0) {
      r.clearTimer();
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`Smuggler running on http://localhost:${PORT}`));
}

module.exports = { server, rooms };
