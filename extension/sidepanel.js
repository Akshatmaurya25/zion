// ====== CONFIG ======
// Point this at wherever you run server/server.js.
// ws:// for local/plain, wss:// if the server is behind TLS.
// const SIGNALING_URL = "wss://server-unfurling-snowflake-1709.fly.dev";
const SIGNALING_URL = "https://server-unfurling-snowflake-1709.fly.dev/";

const CHUNK_SIZE = 16 * 1024; // 16KB per relayed chunk
const BUFFER_THRESHOLD = 1 * 1024 * 1024; // back off if the socket is buffering > 1MB

const AVATAR_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

// ====== STATE ======
let me = null; // { name, avatar, id }
let ws = null;
let currentRoom = null; // room code string, or null
const roomMembers = new Map(); // id -> { id, name, avatar } for everyone else here
const incomingFiles = new Map(); // "fromId:fileId" -> { name, size, mime, chunks, bytes, rowId }

// ====== DOM ======
const el = (id) => document.getElementById(id);
const screens = {
  setup: el("screen-setup"),
  lobby: el("screen-lobby"),
  room: el("screen-room"),
};
function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add("hidden"));
  screens[name].classList.remove("hidden");
}

function avatarColorFor(letter) {
  const code = letter.charCodeAt(0) || 0;
  return AVATAR_COLORS[code % AVATAR_COLORS.length];
}
function makeAvatar(name) {
  const letter = (name || "?").trim().charAt(0).toUpperCase() || "?";
  return { letter, color: avatarColorFor(letter) };
}
function renderAvatar(target, avatar) {
  if (avatar && avatar.img) {
    target.textContent = "";
    target.style.backgroundImage = `url(${avatar.img})`;
    target.style.backgroundSize = "cover";
    target.style.backgroundPosition = "center";
  } else {
    target.style.backgroundImage = "";
    target.textContent = avatar ? avatar.letter : "?";
    target.style.background = avatar ? avatar.color : "#999";
  }
}

// Downscale any picked image to a small square JPEG data URL (sent once to peer).
function fileToAvatarDataUrl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const size = 96;
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const s = Math.min(img.width, img.height);
      c.getContext("2d").drawImage(
        img,
        (img.width - s) / 2,
        (img.height - s) / 2,
        s,
        s,
        0,
        0,
        size,
        size,
      );
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("bad image"));
    };
    img.src = url;
  });
}

// ====== SETUP SCREEN (first run) ======
async function init() {
  const stored = await chrome.storage.local.get([
    "officeDropName",
    "officeDropAvatar",
  ]);
  if (stored.officeDropName) {
    me = { name: stored.officeDropName, avatar: stored.officeDropAvatar };
    enterLobby();
  } else {
    showScreen("setup");
  }
}

let pickedAvatarImg = null; // data URL if the user uploaded a photo

el("avatar-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    pickedAvatarImg = await fileToAvatarDataUrl(file);
    renderAvatar(el("setup-avatar"), { img: pickedAvatarImg });
  } catch {
    alert("Couldn't read that image.");
  }
  e.target.value = "";
});
// Live-preview the initial letter while typing (until a photo is picked).
el("setup-name").addEventListener("input", () => {
  if (!pickedAvatarImg)
    renderAvatar(el("setup-avatar"), makeAvatar(el("setup-name").value));
});

el("setup-save").addEventListener("click", async () => {
  const name = el("setup-name").value.trim();
  if (!name) return;
  const avatar = makeAvatar(name);
  if (pickedAvatarImg) avatar.img = pickedAvatarImg;
  await chrome.storage.local.set({
    officeDropName: name,
    officeDropAvatar: avatar,
  });
  me = { name, avatar };
  enterLobby();
});
el("setup-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") el("setup-save").click();
});

// ====== LOBBY ======
function enterLobby() {
  renderAvatar(el("me-avatar"), me.avatar);
  el("me-name").textContent = me.name;
  showScreen("lobby");
  connectSignaling();
}

function connectSignaling() {
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  )
    return;
  ws = new WebSocket(SIGNALING_URL);

  ws.addEventListener("open", () => {
    setDot(true);
    send({ type: "hello", name: me.name, avatar: me.avatar });
    send({ type: "list-rooms" });
  });
  ws.addEventListener("close", () => {
    setDot(false);
    setTimeout(connectSignaling, 2000); // auto-reconnect
  });
  ws.addEventListener("error", () => setDot(false));
  ws.addEventListener("message", (evt) =>
    handleSignalMessage(JSON.parse(evt.data)),
  );
}

function setDot(online) {
  const dot = el("conn-dot");
  dot.classList.toggle("online", online);
  dot.classList.toggle("offline", !online);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handleSignalMessage(msg) {
  switch (msg.type) {
    case "rooms":
      renderRoomList(msg.rooms);
      break;
    case "room-joined":
      currentRoom = msg.code;
      me.id = msg.self.id;
      enterRoom(msg.members);
      if (msg.members.length === 0)
        renderAnnouncement(
          `Share code ${currentRoom} to invite people`,
          me.avatar,
        );
      else
        renderAnnouncement(
          `You joined — ${msg.members.length + 1} people here`,
          me.avatar,
        );
      break;
    case "peer-joined":
      roomMembers.set(msg.peer.id, msg.peer);
      renderMembers();
      renderAnnouncement(`${msg.peer.name} joined`, msg.peer.avatar);
      break;
    case "peer-left": {
      const m = roomMembers.get(msg.id);
      if (m) {
        renderAnnouncement(`${m.name} left`, m.avatar);
        roomMembers.delete(msg.id);
        renderMembers();
      }
      break;
    }
    case "relay":
      handleRelay(msg.from, msg.payload);
      break;
    case "error":
      alert(msg.message);
      break;
  }
}

function renderRoomList(rooms) {
  const list = el("room-list");
  list.innerHTML = "";
  const empty = el("room-empty");
  if (!rooms.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  rooms.forEach((r) => {
    const li = document.createElement("li");
    const av = document.createElement("span");
    av.className = "avatar";
    renderAvatar(av, r.hostAvatar);
    const info = document.createElement("div");
    info.className = "room-info";
    info.innerHTML = `<span class="room-host">${escapeHtml(r.hostName)}'s room</span><br><span class="room-code-chip">${r.code} · ${r.count}/40</span>`;
    li.appendChild(av);
    li.appendChild(info);
    li.addEventListener("click", () => joinRoom(r.code));
    list.appendChild(li);
  });
}

// Public / private toggle
let roomVisibility = "public";
el("room-visibility").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-vis]");
  if (!btn) return;
  roomVisibility = btn.dataset.vis;
  el("room-visibility")
    .querySelectorAll("button")
    .forEach((b) => b.classList.toggle("active", b === btn));
});

el("btn-create").addEventListener("click", () =>
  send({ type: "create-room", private: roomVisibility === "private" }),
);

// OTP-style 4-digit code input
const otpInputs = Array.from(el("otp").querySelectorAll("input"));
function otpValue() {
  return otpInputs.map((i) => i.value).join("");
}
otpInputs.forEach((input, i) => {
  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 1);
    if (input.value && i < otpInputs.length - 1) otpInputs[i + 1].focus();
    if (otpValue().length === 4) el("btn-join").click();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" && !input.value && i > 0)
      otpInputs[i - 1].focus();
    if (e.key === "Enter") el("btn-join").click();
  });
  input.addEventListener("paste", (e) => {
    e.preventDefault();
    const digits = (e.clipboardData.getData("text") || "")
      .replace(/\D/g, "")
      .slice(0, 4);
    digits.split("").forEach((d, k) => {
      if (otpInputs[k]) otpInputs[k].value = d;
    });
    otpInputs[Math.min(digits.length, 3)].focus();
    if (digits.length === 4) el("btn-join").click();
  });
});
function clearOtp() {
  otpInputs.forEach((i) => (i.value = ""));
  otpInputs[0].focus();
}

el("btn-join").addEventListener("click", () => {
  const code = otpValue();
  if (code.length === 4) {
    joinRoom(code);
    clearOtp();
  }
});
function joinRoom(code) {
  send({ type: "join-room", code });
}

// ====== ROOM SCREEN ======
function enterRoom(members) {
  el("room-code-label").textContent = currentRoom;
  el("chat-log").innerHTML = "";
  roomMembers.clear();
  incomingFiles.clear();
  (members || []).forEach((m) => roomMembers.set(m.id, m));
  renderMembers();
  showScreen("room");
}

function renderMembers() {
  const bar = el("peers-bar");
  bar.innerHTML = "";
  const all = [
    { name: me.name, avatar: me.avatar, self: true },
    ...roomMembers.values(),
  ];
  all.forEach((m) => {
    const av = document.createElement("span");
    av.className = "avatar";
    renderAvatar(av, m.avatar);
    av.title = m.self ? `${me.name} (you)` : m.name;
    bar.appendChild(av);
  });
  const count = document.createElement("span");
  count.className = "peer-count";
  count.textContent = `${all.length} ${all.length === 1 ? "person" : "people"}`;
  bar.appendChild(count);
}

el("btn-leave").addEventListener("click", () => {
  send({ type: "leave-room" });
  currentRoom = null;
  roomMembers.clear();
  showScreen("lobby");
  send({ type: "list-rooms" });
});

// ====== RELAY (chat / code / files over the server) ======
function relay(payload) {
  send({ type: "relay", payload });
}

function handleRelay(from, p) {
  switch (p.type) {
    case "chat":
      renderChatMessage(p.text, false, from.name, from.avatar);
      break;
    case "code":
      renderCodeMessage(p.text, false, from.name, from.avatar);
      break;
    case "file-start":
      startIncomingFile(from, p);
      break;
    case "file-chunk":
      chunkIncomingFile(from, p);
      break;
    case "file-end":
      finishIncomingFile(from, p);
      break;
  }
}

const fileKey = (fromId, id) => `${fromId}:${id}`;

function startIncomingFile(from, p) {
  const rowId = `t-${from.id}-${p.id}`;
  incomingFiles.set(fileKey(from.id, p.id), {
    name: p.name,
    size: p.size,
    mime: p.mime,
    chunks: [],
    bytes: 0,
    rowId,
  });
  renderTransferRow(rowId, p.name, true, from);
}

function chunkIncomingFile(from, p) {
  const f = incomingFiles.get(fileKey(from.id, p.id));
  if (!f) return;
  const buf = b64ToBuf(p.data);
  f.chunks.push(buf);
  f.bytes += buf.byteLength;
  updateTransferProgress(f.rowId, f.bytes / f.size);
}

function finishIncomingFile(from, p) {
  const key = fileKey(from.id, p.id);
  const f = incomingFiles.get(key);
  if (!f) return;
  const url = URL.createObjectURL(
    new Blob(f.chunks, { type: f.mime || "application/octet-stream" }),
  );
  const row = document.getElementById(f.rowId);
  if (row) {
    row.querySelector(".t-bar").remove();
    const a = document.createElement("a");
    a.href = url;
    a.download = f.name;
    a.textContent = "⬇ Download";
    a.className = "dl-btn";
    row.appendChild(a);
  }
  incomingFiles.delete(key);
}

function b64ToBuf(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
function bufToB64(buf) {
  let bin = "";
  const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
  return btoa(bin);
}

// ====== FILE SENDING ======
// The whole room is a drop target now (no dedicated card).
const roomEl = screens.room;
const dropHint = () => el("drop-hint");
["dragenter", "dragover"].forEach((evt) =>
  roomEl.addEventListener(evt, (e) => {
    e.preventDefault();
    dropHint().classList.remove("hidden");
  }),
);
roomEl.addEventListener("dragleave", (e) => {
  if (!roomEl.contains(e.relatedTarget)) dropHint().classList.add("hidden");
});
roomEl.addEventListener("drop", (e) => {
  e.preventDefault();
  dropHint().classList.add("hidden");
  const files = e.dataTransfer.files;
  if (files.length) sendFile(files[0]);
});
el("file-input").addEventListener("change", (e) => {
  if (e.target.files.length) sendFile(e.target.files[0]);
  e.target.value = "";
});

async function sendFile(file) {
  if (!currentRoom || !ws || ws.readyState !== WebSocket.OPEN) {
    alert("You're not in a room yet.");
    return;
  }
  const id = Math.random().toString(36).slice(2, 10);
  const rowId = "t-me-" + id;
  renderTransferRow(rowId, file.name, false, {
    name: me.name,
    avatar: me.avatar,
  });
  relay({
    type: "file-start",
    id,
    name: file.name,
    size: file.size,
    mime: file.type,
  });

  const buf = await file.arrayBuffer();
  let offset = 0;
  while (offset < buf.byteLength) {
    if (ws.bufferedAmount > BUFFER_THRESHOLD) {
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    const chunk = buf.slice(offset, offset + CHUNK_SIZE);
    relay({ type: "file-chunk", id, data: bufToB64(chunk) });
    offset += chunk.byteLength;
    updateTransferProgress(rowId, offset / file.size);
  }
  relay({ type: "file-end", id });
}

function renderTransferRow(rowId, name, incoming, from) {
  const bubble = msgRow(!incoming, incoming ? from.avatar : me.avatar);
  bubble.classList.add("file-msg");
  bubble.id = rowId;
  bubble.innerHTML = `<span class="who">${incoming ? escapeHtml(from.name) : ""}</span>
    <span class="t-name">📎 ${escapeHtml(name)}</span>
    <div class="t-bar"><div class="t-fill"></div></div>`;
}
function updateTransferProgress(rowId, ratio) {
  const row = document.getElementById(rowId);
  if (!row) return;
  const fill = row.querySelector(".t-fill");
  if (fill) fill.style.width = Math.min(100, Math.round(ratio * 100)) + "%";
}

// ====== CHAT ======
el("chat-send").addEventListener("click", sendChat);
el("chat-code").addEventListener("click", sendCode);
el("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  } // Shift+Enter = newline
});
el("chat-input").addEventListener("input", autoGrow);

function autoGrow() {
  const t = el("chat-input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 120) + "px";
}
function clearInput() {
  el("chat-input").value = "";
  el("chat-input").style.height = "auto";
}

function inRoom() {
  return currentRoom && ws && ws.readyState === WebSocket.OPEN;
}

function sendChat() {
  const text = el("chat-input").value.trim();
  if (!text || !inRoom()) return;
  relay({ type: "chat", text });
  renderChatMessage(text, true, me.name, me.avatar);
  clearInput();
}

// Share the input's content as a code snippet (preview + Copy/Open on the other end).
function sendCode() {
  const text = el("chat-input").value;
  if (!text.trim() || !inRoom()) return;
  relay({ type: "code", text });
  renderCodeMessage(text, true, me.name, me.avatar);
  clearInput();
}

function renderAnnouncement(text, avatar) {
  const log = el("chat-log");
  const row = document.createElement("div");
  row.className = "announce";
  const av = document.createElement("span");
  av.className = "avatar sm";
  renderAvatar(av, avatar || makeAvatar("?"));
  const span = document.createElement("span");
  span.textContent = text;
  row.append(av, span);
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

// Build a chat row with the sender's avatar; returns the bubble to fill in.
function msgRow(isMe, avatar) {
  const log = el("chat-log");
  const row = document.createElement("div");
  row.className = "msg-row " + (isMe ? "me" : "them");
  const av = document.createElement("span");
  av.className = "avatar";
  renderAvatar(av, isMe ? me.avatar : avatar || makeAvatar("?"));
  const bubble = document.createElement("div");
  bubble.className = "msg " + (isMe ? "me" : "them");
  row.appendChild(av);
  row.appendChild(bubble);
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
  return bubble;
}

function renderChatMessage(text, isMe, from, avatar) {
  const bubble = msgRow(isMe, avatar);
  bubble.innerHTML = `${!isMe ? `<span class="who">${escapeHtml(from)}</span>` : ""}${escapeHtml(text)}`;
}

function renderCodeMessage(text, isMe, from, avatar) {
  const bubble = msgRow(isMe, avatar);
  bubble.classList.add("code-msg");
  const peek = (text.split("\n").find((l) => l.trim()) || "")
    .trim()
    .slice(0, 40);
  const lines = text.split("\n").length;
  bubble.innerHTML = `<span class="who">${isMe ? "You" : escapeHtml(from)}</span>
     <span class="code-peek">&lt;/&gt; ${escapeHtml(peek)}${peek.length >= 40 ? "…" : ""}</span>
     <span class="code-meta">${lines} line${lines === 1 ? "" : "s"}</span>
     <div class="code-btns">
       <button class="copy-btn" data-act="copy">Copy</button>
       <button class="copy-btn open" data-act="open">Open</button>
     </div>`;
  bubble.querySelector('[data-act="copy"]').addEventListener("click", (e) => {
    navigator.clipboard.writeText(text).then(() => {
      e.target.textContent = "Copied!";
      setTimeout(() => (e.target.textContent = "Copy"), 1500);
    });
  });
  bubble
    .querySelector('[data-act="open"]')
    .addEventListener("click", () => openCodeModal(text));
}

// ====== CODE PREVIEW MODAL ======
let modalText = "";
function openCodeModal(text) {
  modalText = text;
  el("modal-code").innerHTML = highlightCode(text);
  el("code-modal").classList.remove("hidden");
}
function closeCodeModal() {
  el("code-modal").classList.add("hidden");
}
el("modal-close").addEventListener("click", closeCodeModal);
el("code-modal").addEventListener("click", (e) => {
  if (e.target.id === "code-modal") closeCodeModal();
});
el("modal-copy").addEventListener("click", (e) => {
  navigator.clipboard.writeText(modalText).then(() => {
    e.target.textContent = "Copied!";
    setTimeout(() => (e.target.textContent = "Copy"), 1500);
  });
});

// Minimal, language-agnostic syntax colouring: comments, strings, keywords, numbers.
// ponytail: regex tokenizer, not a real parser — fine for a read-only preview.
function highlightCode(src) {
  const token =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|import|from|export|default|class|new|await|async|type|interface|enum|extends|implements|public|private|protected|static|null|undefined|true|false|this|typeof|instanceof|void|in|of|def|lambda|try|catch|finally|throw)\b|(\b\d[\w.]*\b)/g;
  let out = "",
    last = 0,
    m;
  while ((m = token.exec(src))) {
    out += escapeHtml(src.slice(last, m.index));
    if (m[1]) out += `<span class="tok-c">${escapeHtml(m[1])}</span>`;
    else if (m[2]) out += `<span class="tok-s">${escapeHtml(m[2])}</span>`;
    else if (m[3]) out += `<span class="tok-k">${escapeHtml(m[3])}</span>`;
    else out += `<span class="tok-n">${escapeHtml(m[4])}</span>`;
    last = token.lastIndex;
  }
  out += escapeHtml(src.slice(last));
  return out;
}

// ====== PASTE IMAGE / VIDEO FROM CLIPBOARD ======
document.addEventListener("paste", (e) => {
  if (screens.room.classList.contains("hidden")) return; // only inside a room
  const files = e.clipboardData && e.clipboardData.files;
  if (!files || !files.length) return;
  const file = Array.from(files).find(
    (f) => f.type.startsWith("image/") || f.type.startsWith("video/"),
  );
  if (!file) return;
  e.preventDefault();
  renderPasteConfirm(file);
});

function renderPasteConfirm(file) {
  const isImage = file.type.startsWith("image/");
  const bubble = msgRow(true);
  bubble.classList.add("paste-confirm");
  const url = URL.createObjectURL(file);
  bubble.innerHTML = `<span class="who">Share this ${isImage ? "image" : "video"}?</span>
     ${
       isImage
         ? `<img class="paste-preview" src="${url}" alt="" />`
         : `<video class="paste-preview" src="${url}" controls></video>`
     }
     <div class="code-btns">
       <button class="copy-btn" data-act="send">Send</button>
       <button class="copy-btn cancel" data-act="cancel">Cancel</button>
     </div>`;
  const row = bubble.parentElement;
  bubble.querySelector('[data-act="send"]').addEventListener("click", () => {
    URL.revokeObjectURL(url);
    row.remove();
    const name = file.name || `pasted.${file.type.split("/")[1] || "bin"}`;
    sendFile(
      name === file.name ? file : new File([file], name, { type: file.type }),
    );
  });
  bubble.querySelector('[data-act="cancel"]').addEventListener("click", () => {
    URL.revokeObjectURL(url);
    row.remove();
  });
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

init();
