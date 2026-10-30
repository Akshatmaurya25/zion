// Zoin relay server
// Group rooms (up to 40 people) over a star topology: the server fans out
// every chat/code/file message to the other members of the sender's room.
// Everything is in-memory — nothing is written to disk or a database.
// Restarting the process clears all rooms.

const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const MAX_ROOMS = 9000;   // 4-digit codes: 1000–9999
const MAX_MEMBERS = 40;   // people per room

const wss = new WebSocketServer({ port: PORT });

// code -> { isPrivate, createdAt, hostName, hostAvatar, members: Map<id,{ws,name,avatar}> }
const rooms = new Map();

let seq = 0;
function genId() { return "u" + (seq++).toString(36) + Date.now().toString(36).slice(-4); }

function generateCode() {
  if (rooms.size >= MAX_ROOMS) return null; // all 4-digit codes in use
  let code;
  do { code = Math.floor(1000 + Math.random() * 9000).toString(); } while (rooms.has(code));
  return code;
}

function publicRoomList() {
  return Array.from(rooms.entries())
    .filter(([, r]) => !r.isPrivate && r.members.size < MAX_MEMBERS) // listed, with room to spare
    .map(([code, r]) => ({ code, hostName: r.hostName, hostAvatar: r.hostAvatar, count: r.members.size, createdAt: r.createdAt }));
}

function broadcastRoomList() {
  const payload = JSON.stringify({ type: "rooms", rooms: publicRoomList() });
  wss.clients.forEach((c) => { if (c.readyState === c.OPEN) c.send(payload); });
}

function send(ws, obj) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }

function otherMembers(room, exceptId) {
  const out = [];
  for (const [id, m] of room.members) if (id !== exceptId) out.push({ id, name: m.name, avatar: m.avatar });
  return out;
}

function broadcastToRoom(room, obj, exceptWs) {
  const payload = JSON.stringify(obj);
  for (const m of room.members.values()) {
    if (m.ws !== exceptWs && m.ws.readyState === m.ws.OPEN) m.ws.send(payload);
  }
}

function leaveCurrentRoom(ws) {
  const code = ws.meta.roomCode;
  ws.meta.roomCode = null;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  room.members.delete(ws.meta.id);
  if (room.members.size === 0) rooms.delete(code);           // last one out closes the room
  else broadcastToRoom(room, { type: "peer-left", id: ws.meta.id });
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.meta = { id: genId(), name: null, avatar: null, roomCode: null };

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case "hello": {
        ws.meta.name = String(msg.name || "Guest").slice(0, 20);
        ws.meta.avatar = msg.avatar || { letter: "?", color: "#999" };
        break;
      }

      case "list-rooms": {
        send(ws, { type: "rooms", rooms: publicRoomList() });
        break;
      }

      case "create-room": {
        const code = generateCode();
        if (!code) { send(ws, { type: "error", message: "No room available for creation right now — try again later." }); return; }
        if (ws.meta.roomCode) leaveCurrentRoom(ws);
        const room = {
          isPrivate: !!msg.private,
          createdAt: Date.now(),
          hostName: ws.meta.name,
          hostAvatar: ws.meta.avatar,
          members: new Map(),
        };
        room.members.set(ws.meta.id, { ws, name: ws.meta.name, avatar: ws.meta.avatar });
        rooms.set(code, room);
        ws.meta.roomCode = code;
        send(ws, { type: "room-joined", code, self: { id: ws.meta.id }, members: [] });
        broadcastRoomList();
        break;
      }

      case "join-room": {
        const code = String(msg.code || "").trim();
        const room = rooms.get(code);
        if (!room) { send(ws, { type: "error", message: "That room code doesn't exist." }); return; }
        if (room.members.has(ws.meta.id)) return; // already in it
        if (room.members.size >= MAX_MEMBERS) { send(ws, { type: "error", message: `That room is full (${MAX_MEMBERS} people).` }); return; }
        if (ws.meta.roomCode) leaveCurrentRoom(ws);

        const existing = otherMembers(room);
        room.members.set(ws.meta.id, { ws, name: ws.meta.name, avatar: ws.meta.avatar });
        ws.meta.roomCode = code;

        send(ws, { type: "room-joined", code, self: { id: ws.meta.id }, members: existing });
        broadcastToRoom(room, { type: "peer-joined", peer: { id: ws.meta.id, name: ws.meta.name, avatar: ws.meta.avatar } }, ws);
        broadcastRoomList();
        break;
      }

      case "leave-room": {
        leaveCurrentRoom(ws);
        broadcastRoomList();
        break;
      }

      case "relay": {
        // Fan a chat/code/file message out to everyone else in the sender's room.
        const room = rooms.get(ws.meta.roomCode);
        if (!room) return;
        broadcastToRoom(room, {
          type: "relay",
          from: { id: ws.meta.id, name: ws.meta.name, avatar: ws.meta.avatar },
          payload: msg.payload,
        }, ws);
        break;
      }
    }
  });

  ws.on("close", () => {
    leaveCurrentRoom(ws);
    broadcastRoomList();
  });
});

// Heartbeat: drop dead sockets (their close handler frees their room slot).
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(heartbeat));

console.log(`Zoin relay server listening on ws://localhost:${PORT} (up to ${MAX_MEMBERS}/room)`);
