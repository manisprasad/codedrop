const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const initSqlJs = require('sql.js');

const PORT = process.env.PORT || 4040;
const DB_PATH = path.join(__dirname, 'codedrop.db');

// ── Database (sql.js — pure JS/WASM, no native deps) ──────────────────────────
let db;

function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

let saveTimer = null;
function saveDb() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = db.export();
    fs.writeFile(DB_PATH, Buffer.from(data), () => {});
  }, 200);
}

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  db.run('CREATE TABLE IF NOT EXISTS rooms (room_id TEXT PRIMARY KEY, admin_id TEXT, save_messages INTEGER DEFAULT 0)');
  db.run('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, room_id TEXT NOT NULL, from_id TEXT NOT NULL, from_name TEXT NOT NULL, msg_type TEXT NOT NULL DEFAULT \'text\', content TEXT, filename TEXT, file_size INTEGER, file_data_id TEXT, lang TEXT, target_peer TEXT, created_at TEXT DEFAULT (datetime(\'now\')))');
  saveDb();
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.get('/health', (_, res) => res.json({ ok: true, uptime: process.uptime() }));

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 25_000,
  pingTimeout: 20_000,
});

const rooms = new Map();

function getPeerList(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return [...room.entries()].map(([id, info]) => ({ peerId: id, name: info.name }));
}

function getSocketIdByPeer(roomId, peerId) {
  return rooms.get(roomId)?.get(peerId)?.socketId;
}

io.on('connection', (socket) => {
  let myId = null;
  let myRoom = null;

  socket.on('join-room', ({ roomId, peerId, name }) => {
    myId = peerId;
    myRoom = roomId;
    socket.join(roomId);

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    const room = rooms.get(roomId);
    room.set(peerId, { socketId: socket.id, name });

    dbRun('INSERT OR IGNORE INTO rooms (room_id, admin_id) VALUES (?, ?)', [roomId, peerId]);
    const roomInfo = dbGet('SELECT * FROM rooms WHERE room_id = ?', [roomId]);

    const existing = [...room.keys()].filter(id => id !== peerId);
    socket.emit('room-peers', { peers: existing });

    socket.to(roomId).emit('peer-joined', { peerId, name });

    const userList = getPeerList(roomId);
    io.to(roomId).emit('user-list', { users: userList });

    socket.emit('admin-status', { isAdmin: roomInfo.admin_id === peerId });
    socket.emit('save-status', { enabled: roomInfo.save_messages === 1 });

    if (roomInfo.save_messages === 1) {
      const msgs = dbAll('SELECT * FROM messages WHERE room_id = ? ORDER BY id ASC', [roomId]);
      socket.emit('saved-messages', { messages: msgs });
    }
  });

  socket.on('signal', ({ to, type, data }) => {
    if (!myRoom || !to) return;
    const targetId = getSocketIdByPeer(myRoom, to);
    if (targetId) {
      io.to(targetId).emit('signal', {
        from: myId, type, data,
        name: rooms.get(myRoom)?.get(myId)?.name,
      });
    }
  });

  socket.on('chat-message', (msg) => {
    if (!myRoom) return;
    const self = rooms.get(myRoom)?.get(myId);
    const payload = { ...msg, from: myId, senderName: self?.name || '?' };

    if (msg.to && msg.to !== 'broadcast') {
      const targetId = getSocketIdByPeer(myRoom, msg.to);
      if (targetId) io.to(targetId).emit('chat-message', payload);
    } else {
      socket.to(myRoom).emit('chat-message', payload);
    }

    const roomInfo = dbGet('SELECT save_messages FROM rooms WHERE room_id = ?', [myRoom]);
    if (roomInfo?.save_messages === 1 && msg.msgType !== 'file') {
      dbRun('INSERT INTO messages (message_id, room_id, from_id, from_name, msg_type, content, filename, file_size, file_data_id, lang, target_peer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        msg.messageId || null, myRoom, myId, self?.name || '?',
        msg.msgType || 'text', msg.content || null, msg.filename || null,
        msg.fileSize || null, msg.fileDataId || null, msg.lang || null,
        msg.targetPeer || null,
      ]);
    }
  });

  socket.on('typing', ({ to, isTyping }) => {
    if (!myRoom) return;
    const self = rooms.get(myRoom)?.get(myId);
    const payload = { from: myId, name: self?.name, isTyping };
    if (to && to !== 'broadcast') {
      const targetId = getSocketIdByPeer(myRoom, to);
      if (targetId) io.to(targetId).emit('typing', payload);
    } else {
      socket.to(myRoom).emit('typing', payload);
    }
  });

  socket.on('mark-read', ({ messageIds, from: senderId }) => {
    if (!myRoom || !senderId) return;
    const targetId = getSocketIdByPeer(myRoom, senderId);
    if (targetId) {
      io.to(targetId).emit('read-receipt', { messageIds, readBy: myId });
    }
  });

  socket.on('toggle-save', ({ enabled }) => {
    if (!myRoom) return;
    dbRun('UPDATE rooms SET save_messages = ? WHERE room_id = ?', [enabled ? 1 : 0, myRoom]);
    io.to(myRoom).emit('save-status', { enabled });
  });

  socket.on('disconnect', () => {
    if (myId && myRoom) {
      const room = rooms.get(myRoom);
      if (room) {
        room.delete(myId);
        socket.to(myRoom).emit('peer-left', { peerId: myId });
        const userList = getPeerList(myRoom);
        io.to(myRoom).emit('user-list', { users: userList });
        if (room.size === 0) rooms.delete(myRoom);
      }
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`CodeDrop v3 (Socket.IO + sql.js) running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
