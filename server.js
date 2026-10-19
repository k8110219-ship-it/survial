'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e6,
  pingInterval: 25000,
  pingTimeout: 20000
});
const PORT = Number(process.env.PORT) || 3000;
const rooms = new Map();
const MAX_PLAYERS = 4;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

function makeCode() {
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    for (let i = 0; i < 5; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('Could not allocate room code');
}
function safeName(value) {
  const name = String(value || 'Player').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 16);
  return name || 'Player';
}
function publicPlayers(room) {
  const result = {};
  for (const [id, player] of room.players) result[id] = { id, name: player.name, x: player.x, y: player.y, hp: player.hp, maxHp: player.maxHp, alive: player.alive };
  return result;
}
function roomError(socket, message) { socket.emit('room-error', { message }); }
function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.roomCode = null;
  if (!room) return;
  room.players.delete(socket.id);
  socket.leave(code);
  if (room.hostId === socket.id) {
    io.to(code).emit('room-closed');
    rooms.delete(code);
    return;
  }
  io.to(code).emit('player-left', { id: socket.id });
  if (room.players.size === 0) rooms.delete(code);
}

io.on('connection', (socket) => {
  socket.on('create-room', (data = {}) => {
    if (socket.data.roomCode) leaveRoom(socket);
    const code = makeCode();
    const player = { id: socket.id, name: safeName(data.name), x: 480, y: 370, hp: 100, maxHp: 100, alive: true };
    const room = { code, hostId: socket.id, players: new Map([[socket.id, player]]), createdAt: Date.now(), latestState: null };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('room-created', { id: socket.id, code, hostId: room.hostId, players: publicPlayers(room) });
  });

  socket.on('join-room', (data = {}) => {
    if (socket.data.roomCode) leaveRoom(socket);
    const code = String(data.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const room = rooms.get(code);
    if (!room) return roomError(socket, 'Комната не найдена. Проверь код или попроси хозяина создать новую.');
    if (room.players.size >= MAX_PLAYERS) return roomError(socket, 'В комнате уже 4 игрока — больше подключить нельзя.');
    const player = { id: socket.id, name: safeName(data.name), x: 480, y: 370, hp: 100, maxHp: 100, alive: true };
    room.players.set(socket.id, player);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('room-joined', { id: socket.id, code, hostId: room.hostId, players: publicPlayers(room) });
    socket.to(code).emit('player-joined', { player });
    if (room.latestState) socket.emit('game-state', room.latestState);
  });

  socket.on('player-input', (data = {}) => {
    const code = socket.data.roomCode;
    const room = code && rooms.get(code);
    if (!room || socket.id === room.hostId) return;
    const input = data.input || {};
    // Accept only the small set of expected primitive input values.
    const clean = {
      up: !!input.up, down: !!input.down, left: !!input.left, right: !!input.right,
      fire: !!input.fire,
      x: Number.isFinite(input.x) ? Math.max(0, Math.min(3000, input.x)) : 480,
      y: Number.isFinite(input.y) ? Math.max(0, Math.min(2000, input.y)) : 300,
      aim: input.aim && ['x','y','ox','oy'].every(k => Number.isFinite(input.aim[k])) ? { x: input.aim.x, y: input.aim.y, ox: input.aim.ox, oy: input.aim.oy } : null,
      move: input.move && ['x','y','ox','oy'].every(k => Number.isFinite(input.move[k])) ? { x: input.move.x, y: input.move.y, ox: input.move.ox, oy: input.move.oy } : null
    };
    io.to(room.hostId).emit('player-input', { id: socket.id, input: clean });
  });

  socket.on('game-state', (state) => {
    const code = socket.data.roomCode;
    const room = code && rooms.get(code);
    if (!room || socket.id !== room.hostId || !state || typeof state !== 'object') return;
    // Keep the host as the sole source of the world state; guests cannot overwrite it.
    room.latestState = state;
    socket.to(code).volatile.emit('game-state', state);
  });

  socket.on('disconnect', () => leaveRoom(socket));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Двенадцать волн multiplayer server listening on port ${PORT}`);
});
