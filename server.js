// CodeDrop — WebSocket Signaling Server (v2)
// Deploy on Render (free tier) as a Web Service
// No data is stored — only WebRTC signaling messages are relayed

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 4040;

// ── Heartbeat config ──────────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL = 25_000; // ping every 25s
const HEARTBEAT_TIMEOUT  = 35_000; // consider dead after 35s without pong

// ── Data structures ───────────────────────────────────────────────────────────
// rooms: roomId -> Map<peerId, { ws, name, lastSeen }>
const rooms = new Map();

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('CodeDrop Signaling Server v2 — OK');
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

// ── Room helpers ──────────────────────────────────────────────────────────────
function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  return rooms.get(roomId);
}

function cleanRoom(roomId) {
  const room = rooms.get(roomId);
  if (room && room.size === 0) rooms.delete(roomId);
}

/**
 * Build a serialisable user list for a room.
 * Each entry: { peerId, name }
 */
function buildUserList(roomId) {
  const room = getRoom(roomId);
  return [...room.entries()].map(([peerId, info]) => ({
    peerId,
    name: info.name,
  }));
}

/**
 * Broadcast to everyone in a room except (optionally) one sender.
 */
function broadcast(roomId, data, excludeId = null) {
  const room = getRoom(roomId);
  const json = JSON.stringify(data);
  room.forEach((info, peerId) => {
    if (peerId !== excludeId && info.ws.readyState === 1 /* OPEN */) {
      info.ws.send(json);
    }
  });
}

/**
 * Send to one specific peer.
 */
function sendTo(roomId, targetId, data) {
  const room = getRoom(roomId);
  const info = room.get(targetId);
  if (info && info.ws.readyState === 1) {
    info.ws.send(JSON.stringify(data));
  }
}

// ── Connection handler ────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let myId   = null;
  let myRoom = null;

  // Per-connection heartbeat state
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // ── Message router ──────────────────────────────────────────────────────────
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── JOIN ─────────────────────────────────────────────────────────────────
    if (msg.type === 'join') {
      myId   = msg.peerId;
      myRoom = msg.roomId;

      const room = getRoom(myRoom);

      // Send this peer the list of existing peers (IDs only, for WebRTC)
      const existingPeers = [...room.keys()];
      ws.send(JSON.stringify({ type: 'room-peers', peers: existingPeers }));

      // Register the peer
      room.set(myId, { ws, name: msg.name || myId.slice(0, 6), lastSeen: Date.now() });

      // Notify everyone else this peer joined
      broadcast(myRoom, { type: 'peer-joined', peerId: myId, name: msg.name }, myId);

      // Broadcast updated user list to ALL (including the new peer)
      const userList = buildUserList(myRoom);
      broadcast(myRoom, { type: 'user-list', users: userList });
      ws.send(JSON.stringify({ type: 'user-list', users: userList }));

      return;
    }

    // Guard: must be joined before doing anything else
    if (!myId || !myRoom) return;

    // Update last-seen timestamp
    const room = getRoom(myRoom);
    const self = room.get(myId);
    if (self) self.lastSeen = Date.now();

    // ── HELLO / ACK ──────────────────────────────────────────────────────────
    if (msg.type === 'hello' || msg.type === 'hello-ack') {
      const payload = { ...msg, from: myId };
      if (msg.to) sendTo(myRoom, msg.to, payload);
      else        broadcast(myRoom, payload, myId);
      return;
    }

    // ── WebRTC SIGNALING ─────────────────────────────────────────────────────
    if (['offer', 'answer', 'ice-candidate'].includes(msg.type)) {
      if (msg.to) sendTo(myRoom, msg.to, { ...msg, from: myId });
      return;
    }

    // ── CHAT MESSAGE ─────────────────────────────────────────────────────────
    if (msg.type === 'message') {
      const payload = { ...msg, from: myId };
      if (msg.to) sendTo(myRoom, msg.to, payload);
      else        broadcast(myRoom, payload, myId);
      return;
    }

    // ── TYPING INDICATOR ─────────────────────────────────────────────────────
    // Client sends: { type: 'typing', to?: peerId, isTyping: bool }
    if (msg.type === 'typing') {
      const payload = { type: 'typing', from: myId, name: self?.name, isTyping: !!msg.isTyping };
      if (msg.to) sendTo(myRoom, msg.to, payload);
      else        broadcast(myRoom, payload, myId);
      return;
    }

    // ── BYE ──────────────────────────────────────────────────────────────────
    if (msg.type === 'bye') {
      broadcast(myRoom, { type: 'peer-left', peerId: myId }, myId);
      leaveRoom();
    }
  });

  // ── Clean up on close ───────────────────────────────────────────────────────
  ws.on('close', () => leaveRoom());

  ws.on('error', (err) => {
    console.error(`[ws] error for ${myId}:`, err.message);
    leaveRoom();
  });

  function leaveRoom() {
    if (!myId || !myRoom) return;
    const room = rooms.get(myRoom);
    if (!room) return;

    room.delete(myId);
    broadcast(myRoom, { type: 'peer-left', peerId: myId });

    // Broadcast updated user list
    const userList = buildUserList(myRoom);
    broadcast(myRoom, { type: 'user-list', users: userList });

    cleanRoom(myRoom);
    myId = myRoom = null; // prevent double-call
  }
});

// ── Heartbeat sweeper ─────────────────────────────────────────────────────────
// Pings every connected socket; if no pong returned before the next tick → terminate.
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate(); // triggers 'close' → leaveRoom()
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

wss.on('close', () => clearInterval(heartbeatInterval));

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`CodeDrop signaling server v2 running on port ${PORT}`);
});
