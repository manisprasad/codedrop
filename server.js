// CodeDrop — WebSocket Signaling Server
// Deploy on Render (free tier) as a Web Service
// No data is stored — only WebRTC signaling messages are relayed

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 4040;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('CodeDrop Signaling Server — OK');
});

const wss = new WebSocketServer({ server });

// rooms: roomId -> Map<peerId, ws>
const rooms = new Map();

function getRoomPeers(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  return rooms.get(roomId);
}

function broadcast(roomId, senderId, data) {
  const peers = getRoomPeers(roomId);
  const json = JSON.stringify(data);
  peers.forEach((ws, peerId) => {
    if (peerId !== senderId && ws.readyState === 1) {
      ws.send(json);
    }
  });
}

function sendTo(roomId, targetId, data) {
  const peers = getRoomPeers(roomId);
  const ws = peers.get(targetId);
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

wss.on('connection', (ws) => {
  let myId = null;
  let myRoom = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // JOIN: peer announces itself to a room
    if (msg.type === 'join') {
      myId = msg.peerId;
      myRoom = msg.roomId;
      const peers = getRoomPeers(myRoom);
      
      // Send this peer the list of existing peers
      const existingPeers = [...peers.keys()];
      ws.send(JSON.stringify({ type: 'room-peers', peers: existingPeers }));

      // Add to room
      peers.set(myId, ws);

      // Tell everyone else this peer joined
      broadcast(myRoom, myId, { type: 'peer-joined', peerId: myId, name: msg.name });
      return;
    }

    if (!myId || !myRoom) return;

    // HELLO / ACK: peer metadata exchange
    if (msg.type === 'hello' || msg.type === 'hello-ack') {
      if (msg.to) {
        sendTo(myRoom, msg.to, { ...msg, from: myId });
      } else {
        broadcast(myRoom, myId, { ...msg, from: myId });
      }
      return;
    }

    // WebRTC signaling: offer, answer, ice-candidate
    if (['offer', 'answer', 'ice-candidate'].includes(msg.type)) {
      if (msg.to) {
        sendTo(myRoom, msg.to, { ...msg, from: myId });
      }
      return;
    }

    // MESSAGE: relay chat/code/file messages
    if (msg.type === 'message') {
      if (msg.to) {
        // DM
        sendTo(myRoom, msg.to, { ...msg, from: myId });
      } else {
        // Broadcast
        broadcast(myRoom, myId, { ...msg, from: myId });
      }
      return;
    }

    // BYE: peer leaving
    if (msg.type === 'bye') {
      broadcast(myRoom, myId, { type: 'peer-left', peerId: myId });
    }
  });

  ws.on('close', () => {
    if (myId && myRoom) {
      const peers = getRoomPeers(myRoom);
      peers.delete(myId);
      broadcast(myRoom, myId, { type: 'peer-left', peerId: myId });
      // Clean up empty rooms
      if (peers.size === 0) rooms.delete(myRoom);
    }
  });

  ws.on('error', () => {
    if (myId && myRoom) {
      const peers = getRoomPeers(myRoom);
      peers.delete(myId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`CodeDrop signaling server running on port ${PORT}`);
});
