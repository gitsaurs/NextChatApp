// ═══════════════════════════════════════════════
//  chat.js  —  NexChat Main Engine (Clean Rewrite)
// ═══════════════════════════════════════════════

import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  collection, doc, getDoc, getDocs, setDoc, addDoc,
  updateDoc, deleteDoc, query, orderBy, limit, where,
  onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { uploadFile, uploadAvatar } from "./storage.js";
import { initNotifications, showLocalNotif, playSound } from "./notifications.js";

// ══════════════════════════════════════════════
//  ENCRYPTION  (AES-GCM via Web Crypto API)
// ══════════════════════════════════════════════
const ENC = 'ENC::';

async function getKey(cid) {
  const raw  = new TextEncoder().encode('nexchat_' + cid);
  const base = await crypto.subtle.importKey('raw', raw, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name:'PBKDF2', salt:raw.slice(0,16), iterations:1000, hash:'SHA-256' },
    base, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']
  );
}
async function encrypt(txt, cid) {
  try {
    const key = await getKey(cid);
    const iv  = crypto.getRandomValues(new Uint8Array(12));
    const enc = await crypto.subtle.encrypt({name:'AES-GCM',iv}, key, new TextEncoder().encode(txt));
    const out = new Uint8Array(12 + enc.byteLength);
    out.set(iv); out.set(new Uint8Array(enc), 12);
    return ENC + btoa(String.fromCharCode(...out));
  } catch { return txt; }
}
async function decrypt(cipher, cid) {
  if (!cipher || !cipher.startsWith(ENC)) return cipher || '';
  try {
    const key  = await getKey(cid);
    const data = Uint8Array.from(atob(cipher.slice(ENC.length)), c => c.charCodeAt(0));
    const dec  = await crypto.subtle.decrypt({name:'AES-GCM',iv:data.slice(0,12)}, key, data.slice(12));
    return new TextDecoder().decode(dec);
  } catch { return '[encrypted]'; }
}

// ══════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════
const S = {
  me:          null,   // { uid, name, email, photoURL, status }
  chatId:      null,   // current open chat id
  peer:        null,   // current peer user object
  unsubMsgs:   null,
  unsubPeer:   null,
  pendingFiles:[],
  notif:       true,
  sound:       true,
  searchHits:  [],
  searchIdx:   0,
  typingTimer: null,
  isTyping:    false,
};

// ══════════════════════════════════════════════
//  DOM
// ══════════════════════════════════════════════
const $ = id => document.getElementById(id);

// ══════════════════════════════════════════════
//  MOBILE NAVIGATION
// ══════════════════════════════════════════════
function isMobile() { return window.innerWidth <= 768; }

function showChat() {
  if (!isMobile()) return;
  $('sidebar').classList.add('mobile-hide');
  $('main').classList.add('mobile-show');
}

function showSidebar() {
  if (!isMobile()) return;
  $('main').classList.remove('mobile-show');
  $('sidebar').classList.remove('mobile-hide');
}

// Back button
document.addEventListener('DOMContentLoaded', () => {
  const backBtn = $('backBtn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      showSidebar();
      // Unsub from current chat when going back
      if (S.unsubMsgs) { S.unsubMsgs(); S.unsubMsgs = null; }
      if (S.unsubPeer)  { S.unsubPeer();  S.unsubPeer  = null; }
      S.chatId = null; S.peer = null;
      $('chatPanel').classList.add('hidden');
      $('welcomeScreen').classList.remove('hidden');
      document.querySelectorAll('.user-item').forEach(el => el.classList.remove('active'));
    });
  }
});

// Handle resize — reset mobile classes if window grows
window.addEventListener('resize', () => {
  if (!isMobile()) {
    $('sidebar').classList.remove('mobile-hide');
    $('main').classList.remove('mobile-show');
  }
});

// ══════════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════════
function esc(s) {
  return String(s||'')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function initials(name) {
  return (name||'?').trim().split(/\s+/).map(w=>w[0]).join('').toUpperCase().slice(0,2)||'?';
}
function fmtTime(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
}
function fmtChatTime(ts) {
  if (!ts) return '';
  const d   = ts.toDate ? ts.toDate() : new Date(ts);
  const now = new Date();
  const diff= Math.floor((now-d)/86400000);
  if (diff===0) return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  if (diff===1) return 'Yesterday';
  if (diff<7)   return d.toLocaleDateString([],{weekday:'short'});
  return d.toLocaleDateString([],{day:'2-digit',month:'2-digit',year:'2-digit'});
}
function fmtDateLabel(ts) {
  if (!ts) return '';
  const d   = ts.toDate ? ts.toDate() : new Date(ts);
  const now = new Date();
  const diff= Math.floor((now-d)/86400000);
  if (diff===0) return 'Today';
  if (diff===1) return 'Yesterday';
  return d.toLocaleDateString([],{weekday:'long',day:'numeric',month:'long'});
}
function setAv(el, name, photo) {
  if (!el) return;
  if (photo) {
    el.innerHTML = `<img src="${esc(photo)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.parentNode.textContent='${initials(name)}'"/>`;
  } else {
    el.textContent = initials(name);
  }
}
function toast(msg, type='') {
  const w  = $('toastWrap');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  w.appendChild(el);
  setTimeout(()=>el.remove(), 3500);
}
function chatIdFor(a, b) { return [a,b].sort().join('_'); }

// ══════════════════════════════════════════════
//  TICK SVGs
// ══════════════════════════════════════════════
function tick(ack) {
  const grey = 'fill:var(--c-text-3)';
  const blue = 'fill:#53bdeb';
  if (!ack||ack==='sent')
    return `<span class="tick sent"><svg viewBox="0 0 16 11" style="${grey}"><path d="M15.01.42a1 1 0 0 0-1.42 0L6 8.99 2.41 5.41A1 1 0 0 0 1 6.83l4 4a1 1 0 0 0 1.42 0l9-9a1 1 0 0 0 0-1.41z"/></svg></span>`;
  if (ack==='delivered')
    return `<span class="tick delivered"><svg viewBox="0 0 20 11" style="${grey}"><path d="M19.01.42a1 1 0 0 0-1.42 0L8 9.99 4.41 6.41A1 1 0 0 0 3 7.83l4 4a1 1 0 0 0 1.42 0l11-11a1 1 0 0 0 0-1.41z"/><path d="M14.01.42a1 1 0 0 0-1.42 0l-1.3 1.3 1.42 1.4 1.3-1.29a1 1 0 0 0 0-1.41z" opacity=".4"/></svg></span>`;
  if (ack==='read')
    return `<span class="tick read"><svg viewBox="0 0 20 11" style="${blue}"><path d="M19.01.42a1 1 0 0 0-1.42 0L8 9.99 4.41 6.41A1 1 0 0 0 3 7.83l4 4a1 1 0 0 0 1.42 0l11-11a1 1 0 0 0 0-1.41z"/><path d="M14.01.42a1 1 0 0 0-1.42 0l-1.3 1.3 1.42 1.4 1.3-1.29a1 1 0 0 0 0-1.41z"/></svg></span>`;
  return '';
}

// ══════════════════════════════════════════════
//  USER LIST — load all users from Firestore
// ══════════════════════════════════════════════
async function loadSidebar() {
  const ul = $('userList');
  ul.innerHTML = `<div style="padding:20px;display:flex;justify-content:center;">
    <div style="width:22px;height:22px;border:2px solid var(--c-border);border-top-color:var(--c-accent);border-radius:50%;animation:spin .7s linear infinite;"></div>
  </div>`;

  try {
    // Get ALL users except self
    const snap  = await getDocs(collection(db, 'users'));
    const users = snap.docs
      .map(d => d.data())
      .filter(u => u.uid && u.uid !== S.me.uid);

    if (!users.length) {
      ul.innerHTML = `<div style="padding:28px;text-align:center;color:var(--c-text-3);font-size:13px;">
        No other users yet.<br>Ask friends to sign up!
      </div>`;
      return;
    }

    // For each user, get last message preview
    const items = await Promise.all(users.map(async u => {
      const cid = chatIdFor(S.me.uid, u.uid);
      let lastText = '', lastTs = null;
      try {
        const q    = query(collection(db,'chats',cid,'messages'), orderBy('createdAt','desc'), limit(1));
        const msgs = await getDocs(q);
        if (!msgs.empty) {
          const d = msgs.docs[0].data();
          lastTs  = d.createdAt;
          if      (d.type==='text')  lastText = await decrypt(d.text, cid);
          else if (d.type==='image') lastText = 'Photo';
          else if (d.type==='video') lastText = 'Video';
          else                       lastText = d.fileName || 'File';
        }
      } catch {}
      return { ...u, cid, lastText, lastTs };
    }));

    // Sort: those with messages first (newest), then rest alphabetically
    items.sort((a,b)=>{
      const ta = a.lastTs?.seconds||0, tb = b.lastTs?.seconds||0;
      if (tb!==ta) return tb-ta;
      return (a.name||'').localeCompare(b.name||'');
    });

    renderSidebar(items);

    // Live updates — re-render when new messages arrive
    items.forEach(u => {
      const cid = u.cid;
      const q   = query(collection(db,'chats',cid,'messages'), orderBy('createdAt','desc'), limit(1));
      onSnapshot(q, async snap => {
        if (snap.empty) return;
        const d = snap.docs[0].data();
        u.lastTs = d.createdAt;
        if      (d.type==='text')  u.lastText = await decrypt(d.text, cid);
        else if (d.type==='image') u.lastText = 'Photo';
        else if (d.type==='video') u.lastText = 'Video';
        else                       u.lastText = d.fileName||'File';
        // Notify if not current chat
        if (d.senderId !== S.me.uid && cid !== S.chatId) {
          u.unread = (u.unread||0)+1;
          if (S.sound) playSound();
          showLocalNotif(u.name||'NexChat', u.lastText, u.photoURL||'');
        }
        items.sort((a,b)=>{
          const ta=a.lastTs?.seconds||0,tb=b.lastTs?.seconds||0;
          return tb-ta;
        });
        renderSidebar(items);
      });
    });

  } catch(err) {
    ul.innerHTML = `<div style="padding:20px;text-align:center;color:var(--c-danger);font-size:12px;">
      Error loading users:<br>${err.message}
    </div>`;
    console.error('loadSidebar error:', err);
  }
}

function renderSidebar(users) {
  const ul = $('userList');
  const q  = ($('searchInput').value||'').toLowerCase().trim();
  const list = q ? users.filter(u=>
    (u.name||'').toLowerCase().includes(q) ||
    (u.email||'').toLowerCase().includes(q)
  ) : users;

  ul.innerHTML = '';
  if (!list.length) {
    ul.innerHTML = `<div style="padding:28px;text-align:center;color:var(--c-text-3);font-size:13px;">No results</div>`;
    return;
  }

  list.forEach(u => {
    const item = document.createElement('div');
    item.className = 'user-item' + (u.cid===S.chatId?' active':'');
    item.dataset.cid = u.cid;

    const badge = (u.unread>0) ? `<span class="unread-badge">${u.unread}</span>` : '';
    const dot   = u.online ? 'online-dot' : 'online-dot offline';

    item.innerHTML = `
      <div class="avatar-wrap">
        <div class="avatar avatar-md"></div>
        <span class="${dot}"></span>
      </div>
      <div class="user-item-info">
        <div class="user-item-top">
          <span class="user-item-name">${esc(u.name||'Unknown')}</span>
          <span class="user-item-time">${fmtChatTime(u.lastTs)}</span>
        </div>
        <div class="user-item-bottom">
          <span class="user-item-preview">${esc(u.lastText||'No messages yet')}</span>
          ${badge}
        </div>
      </div>`;

    setAv(item.querySelector('.avatar'), u.name||'?', u.photoURL||null);
    item.addEventListener('click', () => {
      u.unread = 0;
      openChat(u);
      renderSidebar(list.length===users.length ? users : list.map(x=>x));
    });
    ul.appendChild(item);
  });
}

// Sidebar search
$('searchInput').addEventListener('input', () => {
  // Re-trigger render with current allUsers — store ref on window for this
  if (window._sidebarUsers) renderSidebar(window._sidebarUsers);
});

// Patch renderSidebar to store users
const _origRender = renderSidebar;
// (We'll just save inside loadSidebar instead)

// ══════════════════════════════════════════════
//  OPEN CHAT
// ══════════════════════════════════════════════
async function openChat(peer) {
  if (S.unsubMsgs) S.unsubMsgs();
  if (S.unsubPeer)  S.unsubPeer();

  S.chatId = chatIdFor(S.me.uid, peer.uid);
  S.peer   = peer;

  // Sidebar active state
  document.querySelectorAll('.user-item').forEach(el=>
    el.classList.toggle('active', el.dataset.cid===S.chatId)
  );

  // Ensure chat document exists
  await setDoc(doc(db,'chats',S.chatId), {
    members:  [S.me.uid, peer.uid],
    updatedAt: serverTimestamp(),
  }, {merge:true});

  // Header
  setAv($('chatHeaderAvatar'), peer.name||'?', peer.photoURL||null);
  $('chatHeaderName').textContent = peer.name || 'Unknown';

  // Show panel
  $('welcomeScreen').classList.add('hidden');
  $('chatPanel').classList.remove('hidden');
  closeChatSearch();
  closeEmoji();
  // On mobile — slide to chat view
  showChat();

  // Loading spinner
  $('messagesArea').innerHTML = `
    <div style="display:flex;justify-content:center;padding:40px;">
      <div style="width:26px;height:26px;border:3px solid var(--c-border);border-top-color:var(--c-accent);border-radius:50%;animation:spin .7s linear infinite;"></div>
    </div>`;

  // Watch peer online status
  S.unsubPeer = onSnapshot(doc(db,'users',peer.uid), snap => {
    if (!snap.exists()) return;
    const d = snap.data();
    const online = d.online === true;
    const dot1 = $('chatOnlineDot'), dot2 = $('chatStatusDot');
    if (dot1) dot1.className = `online-dot${online?'':' offline'}`;
    if (dot2) dot2.className = `dot${online?'':' offline'}`;
    const sub = $('chatStatusText');
    if (sub) {
      if (online) {
        sub.textContent = 'online';
      } else {
        const seen = d.lastSeen?.toDate?.();
        sub.textContent = seen
          ? 'last seen ' + seen.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})
          : 'offline';
      }
    }
    // Typing
    if (d.typingTo === S.chatId) showTyping(); else hideTyping();
  });

  // Mark peer messages as read
  markRead();

  // Subscribe to messages
  subMessages();
}

// ══════════════════════════════════════════════
//  MESSAGES — real-time
// ══════════════════════════════════════════════
function subMessages() {
  const q = query(
    collection(db,'chats',S.chatId,'messages'),
    orderBy('createdAt','asc')
  );

  let firstLoad = true;

  S.unsubMsgs = onSnapshot(q, async snap => {
    const area = $('messagesArea');

    if (firstLoad) {
      firstLoad = false;
      area.innerHTML = '';
      let lastDate = null;
      for (const ch of snap.docs) {
        const msg = {id: ch.id, ...ch.doc ? ch.doc.data() : ch.data()};
        // snap.docs are QueryDocumentSnapshot
        const data = ch.data();
        const m = {id: ch.id, ...data};
        if (m.type==='text') m.text = await decrypt(m.text, S.chatId);
        const label = fmtDateLabel(m.createdAt);
        if (label && label!==lastDate) {
          area.appendChild(mkSep(label));
          lastDate = label;
        }
        area.appendChild(mkBubble(m));
      }
      scrollBot();
      return;
    }

    // Incremental
    for (const ch of snap.docChanges()) {
      const data = ch.doc.data();
      const m    = {id: ch.doc.id, ...data};

      if (ch.type==='added') {
        if (m.type==='text') m.text = await decrypt(m.text, S.chatId);
        area.appendChild(mkBubble(m));
        scrollBot();
        markRead();
      }
      if (ch.type==='modified') {
        if (m.type==='text') m.text = await decrypt(m.text, S.chatId);
        const old = area.querySelector(`[data-id="${m.id}"]`);
        if (old) old.replaceWith(mkBubble(m));
      }
      if (ch.type==='removed') {
        area.querySelector(`[data-id="${m.id}"]`)?.remove();
      }
    }
  });
}

function mkSep(label) {
  const el = document.createElement('div');
  el.className = 'date-sep';
  el.innerHTML = `<span>${esc(label)}</span>`;
  return el;
}

function mkBubble(m) {
  const isMe = m.senderId === S.me.uid;
  const row  = document.createElement('div');
  row.className  = `bubble-row ${isMe?'out':'in'}`;
  row.dataset.id = m.id;

  // Reaction picker
  const emojiOpts = ['❤️','😂','👍','😮','😢','🔥'];
  const picker    = `<div class="reaction-picker">${emojiOpts.map(e=>
    `<button class="reaction-opt" data-e="${e}" data-id="${m.id}">${e}</button>`
  ).join('')}</div>`;

  // Content
  let body = '';
  if (m.type==='image') {
    body = `<div class="bubble" style="padding:6px;">${picker}
      <img class="bubble-img" src="${esc(m.fileUrl)}" data-full="${esc(m.fileUrl)}" style="max-width:240px;border-radius:10px;cursor:pointer;display:block;"/>
    </div>`;
  } else if (m.type==='video') {
    body = `<div class="bubble" style="padding:6px;">
      <video controls style="max-width:240px;border-radius:10px;display:block;">
        <source src="${esc(m.fileUrl)}">
      </video>
    </div>`;
  } else if (m.type==='file') {
    body = `<div class="bubble">
      <div class="bubble-file" onclick="window.open('${esc(m.fileUrl)}','_blank')">
        <svg viewBox="0 0 24 24" style="width:28px;height:28px;fill:var(--c-accent);flex-shrink:0;">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/>
        </svg>
        <div class="bubble-file-info">
          <div class="bubble-file-name">${esc(m.fileName||'File')}</div>
          <div class="bubble-file-size">${esc(m.fileSize||'')}</div>
        </div>
      </div>
    </div>`;
  } else {
    body = `<div class="bubble">${picker}
      <span class="bubble-text">${esc(m.text||'')}</span>
    </div>`;
  }

  // Reactions
  const reacts = m.reactions||{};
  const counts = {};
  Object.values(reacts).forEach(e=>{ counts[e]=(counts[e]||0)+1; });
  const myR = reacts[S.me.uid];
  const reactHtml = Object.keys(counts).length
    ? `<div class="reactions">${Object.entries(counts).map(([e,n])=>
        `<span class="reaction-chip${e===myR?' mine':''}" data-e="${e}" data-id="${m.id}">${e}<span>${n}</span></span>`
      ).join('')}</div>`
    : `<div class="reactions"></div>`;

  // Meta
  const t     = `<span>${fmtTime(m.createdAt)}</span>`;
  const tk    = isMe ? tick(m.ack) : '';
  const meta  = `<div class="bubble-meta">${t}${tk}</div>`;

  row.innerHTML = body + reactHtml + meta;

  // Bind reaction picker buttons
  row.querySelectorAll('.reaction-opt').forEach(btn=>{
    btn.addEventListener('click', e=>{ e.stopPropagation(); doReact(btn.dataset.id, btn.dataset.e); });
  });
  // Bind reaction chips
  row.querySelectorAll('.reaction-chip').forEach(chip=>{
    chip.addEventListener('click', ()=> doReact(chip.dataset.id, chip.dataset.e));
  });
  // Image lightbox
  row.querySelectorAll('.bubble-img').forEach(img=>{
    img.addEventListener('click', ()=>openLightbox(img.dataset.full));
  });
  // Right-click menu
  row.addEventListener('contextmenu', e=>showCtx(e, m, isMe));

  return row;
}

function scrollBot() {
  const a = $('messagesArea');
  a.scrollTop = a.scrollHeight;
}

async function markRead() {
  if (!S.chatId || !S.peer) return;
  try {
    const q    = query(collection(db,'chats',S.chatId,'messages'), where('senderId','==',S.peer.uid));
    const snap = await getDocs(q);
    for (const d of snap.docs) {
      if (d.data().ack !== 'read') {
        await setDoc(d.ref, {ack:'read'}, {merge:true});
      }
    }
  } catch {}
}

// Typing indicator
function showTyping() {
  if ($('typingInd')) return;
  const el   = document.createElement('div');
  el.id      = 'typingInd';
  el.className = 'typing-indicator';
  el.innerHTML = `<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>`;
  $('messagesArea').appendChild(el);
  scrollBot();
}
function hideTyping() { $('typingInd')?.remove(); }

// ══════════════════════════════════════════════
//  SEND MESSAGE
// ══════════════════════════════════════════════
async function sendMsg() {
  const inp  = $('messageInput');
  const text = inp.value.trim();
  if (!text && !S.pendingFiles.length) return;
  if (!S.chatId) { toast('Open a chat first!','error'); return; }

  inp.value = '';
  inp.style.height = 'auto';
  stopTyping();
  closeEmoji();

  const ref = collection(db,'chats',S.chatId,'messages');

  // Upload pending files
  for (const f of S.pendingFiles) {
    try {
      const fd = await uploadFile(f, S.chatId, S.me.uid, null);
      await addDoc(ref, {
        senderId: S.me.uid, type: fd.type,
        fileUrl: fd.url, fileName: fd.name, fileSize: fd.size,
        ack:'sent', reactions:{}, createdAt: serverTimestamp(),
      });
    } catch(e) { toast('Upload failed: '+e.message,'error'); }
  }
  clearFiles();

  // Send text
  if (text) {
    const enc = await encrypt(text, S.chatId);
    await addDoc(ref, {
      senderId: S.me.uid, type:'text', text: enc,
      ack:'sent', reactions:{}, createdAt: serverTimestamp(),
    });
    // Update chat doc with last message info
    await setDoc(doc(db,'chats',S.chatId), {
      lastMsg: enc, lastAt: serverTimestamp(),
    }, {merge:true});
  }
}

$('sendBtn').addEventListener('click', sendMsg);
$('messageInput').addEventListener('keydown', e=>{
  if (e.key==='Enter'&&!e.shiftKey) { e.preventDefault(); sendMsg(); }
});
$('messageInput').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight,120)+'px';
  if (this.value && S.chatId) {
    startTyping();
    clearTimeout(S.typingTimer);
    S.typingTimer = setTimeout(stopTyping, 2000);
  } else { stopTyping(); }
});

// Typing presence
async function startTyping() {
  if (S.isTyping) return;
  S.isTyping = true;
  await setDoc(doc(db,'users',S.me.uid),{typingTo:S.chatId},{merge:true}).catch(()=>{});
}
async function stopTyping() {
  if (!S.isTyping) return;
  S.isTyping = false;
  await setDoc(doc(db,'users',S.me.uid),{typingTo:null},{merge:true}).catch(()=>{});
}

// ══════════════════════════════════════════════
//  REACTIONS
// ══════════════════════════════════════════════
async function doReact(msgId, emoji) {
  if (!S.chatId||!msgId) return;
  const ref  = doc(db,'chats',S.chatId,'messages',msgId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const reacts = snap.data().reactions||{};
  const updated = {...reacts};
  if (updated[S.me.uid]===emoji) delete updated[S.me.uid];
  else updated[S.me.uid] = emoji;
  await setDoc(ref, {reactions:updated}, {merge:true});
}

// ══════════════════════════════════════════════
//  FILE UPLOAD
// ══════════════════════════════════════════════
$('attachBtn').addEventListener('click', ()=>$('fileInput').click());
$('fileInput').addEventListener('change', e=>{
  [...e.target.files].forEach(f=>addFile(f));
  e.target.value='';
});

// Drag & drop
$('messagesArea').addEventListener('dragover', e=>{ e.preventDefault(); });
$('messagesArea').addEventListener('drop', e=>{
  e.preventDefault();
  if (!S.chatId) return;
  [...e.dataTransfer.files].forEach(f=>addFile(f));
});

function addFile(f) {
  S.pendingFiles.push(f);
  const strip = $('filePreviewStrip');
  strip.classList.remove('hidden');
  const chip = document.createElement('div');
  chip.className = 'file-preview-chip';
  const isImg = f.type.startsWith('image/');
  chip.innerHTML = (isImg?`<img src="${URL.createObjectURL(f)}" alt=""/>`:
    `<svg viewBox="0 0 24 24" width="28" height="28" fill="var(--c-accent)"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/></svg>`)
    +`<span class="fname">${esc(f.name)}</span>`
    +`<button onclick="removeFile('${esc(f.name)}',this)">✕</button>`;
  strip.appendChild(chip);
}
window.removeFile = (name,btn)=>{
  S.pendingFiles = S.pendingFiles.filter(f=>f.name!==name);
  btn.closest('.file-preview-chip').remove();
  if (!S.pendingFiles.length) $('filePreviewStrip').classList.add('hidden');
};
function clearFiles() {
  S.pendingFiles=[];
  const s=$('filePreviewStrip');
  s.classList.add('hidden'); s.innerHTML='';
}

// ══════════════════════════════════════════════
//  EMOJI PICKER
// ══════════════════════════════════════════════
const EMOJIS={
  Smileys:  ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😉','😊','😇','🥰','😍','🤩','😘','😋','😛','😜','🤪','😝','🤑','🤗','🤔','😐','😑','😶','😏','😒','🙄','😬','😔','😪','😴','😷','🤒','🤕','🤢','🤧','🥵','🥶','😵','🤯','🤠','🥳','😎','🤓','😕','😟','🙁','😮','😲','😳','🥺','😦','😰','😢','😭','😱','😤','😡','😠','🤬','😈'],
  Gestures: ['👋','🤚','🖐','✋','👌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','👍','👎','✊','👊','👏','🙌','🤲','🤝','🙏','💪'],
  Hearts:   ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝'],
  Animals:  ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🐢','🐍','🦎','🐙','🦑','🐡','🐠','🐟','🐬','🐳','🦈','🐊','🐅','🐆','🦓','🦍','🐘','🦛','🦏','🐪','🦒','🦘','🐃','🐄','🐎'],
  Food:     ['🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶️','🧄','🧅','🥔','🍠','🥐','🍞','🥖','🧀','🥚','🍳','🥞','🧇','🥓','🥩','🍗','🍖','🌭','🍔','🍟','🍕','🌮','🌯','🍜','🍝','🍛','🍣','🍱','🍤','🧁','🍰','🎂','🍩','🍪','🍫','🍭','🍬','🍿','☕','🍵','🍺','🍻','🥂','🥃','🍷','🍸','🍹','🧃','🥤'],
  Objects:  ['⌚','📱','💻','⌨️','🖥️','📷','📸','📹','🎥','📺','📻','🧭','⏰','💡','🔦','🔋','🔌','🔧','🔨','🔩','🧲','💊','🩺','🩹','💉','🔬','🔭','📊','📈','📉','📋','📁','📂','📓','📔','📒','📕','📗','📘','📙','📚','📖','🔖','💰','💳','✉️','📧','📦','📝','📌','📍','📎','✂️'],
  Symbols:  ['❤️','✅','❌','⭕','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','💯','➕','➖','✖️','➗','🔃','🔄','❓','❔','❕','❗','⁉️','‼️','🔔','🔕','🎵','🎶','💲'],
};

let emojiBuilt=false;
function buildEmoji(){
  if(emojiBuilt)return; emojiBuilt=true;
  const cats=$('emojiCats'), grid=$('emojiGrid');
  Object.keys(EMOJIS).forEach((cat,i)=>{
    const b=document.createElement('button');
    b.className='emoji-cat-btn'+(i===0?' active':'');
    b.textContent=cat;
    b.onclick=()=>{
      cats.querySelectorAll('.emoji-cat-btn').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      fillGrid(cat);
    };
    cats.appendChild(b);
  });
  fillGrid(Object.keys(EMOJIS)[0]);
}
function fillGrid(cat){
  const g=$('emojiGrid'); g.innerHTML='';
  (EMOJIS[cat]||[]).forEach(em=>{
    const b=document.createElement('button');
    b.className='emoji-btn'; b.textContent=em;
    b.onclick=()=>insertEmoji(em);
    g.appendChild(b);
  });
}
function insertEmoji(em){
  const inp=$('messageInput'), pos=inp.selectionStart;
  inp.value=inp.value.slice(0,pos)+em+inp.value.slice(pos);
  inp.setSelectionRange(pos+em.length,pos+em.length);
  inp.focus();
}
$('emojiBtn').addEventListener('click',e=>{
  e.stopPropagation(); buildEmoji();
  $('emojiPanel').classList.toggle('hidden');
});
$('emojiSearchInput').addEventListener('input',function(){
  const q=this.value.toLowerCase(), g=$('emojiGrid');
  g.innerHTML='';
  const all=Object.values(EMOJIS).flat();
  (q?all:Object.values(EMOJIS)[0]||all.slice(0,64)).forEach(em=>{
    const b=document.createElement('button');
    b.className='emoji-btn'; b.textContent=em;
    b.onclick=()=>insertEmoji(em);
    g.appendChild(b);
  });
});
function closeEmoji(){ $('emojiPanel').classList.add('hidden'); }
document.addEventListener('click',e=>{ if(!$('inputBar').contains(e.target)) closeEmoji(); });

// ══════════════════════════════════════════════
//  IN-CHAT SEARCH
// ══════════════════════════════════════════════
$('chatSearchBtn').addEventListener('click',()=>{
  $('chatSearchBar').classList.toggle('hidden');
  if(!$('chatSearchBar').classList.contains('hidden')) $('chatSearchInput').focus();
  else closeChatSearch();
});
$('chatSearchClose').addEventListener('click', closeChatSearch);
function closeChatSearch(){
  $('chatSearchBar').classList.add('hidden');
  clearHL(); S.searchHits=[]; S.searchIdx=0;
  $('chatSearchCount').textContent='';
}
$('chatSearchInput').addEventListener('input',function(){
  clearHL();
  const q=this.value.trim().toLowerCase();
  S.searchHits=[]; S.searchIdx=0;
  if(!q){ $('chatSearchCount').textContent=''; return; }
  document.querySelectorAll('.bubble-text').forEach(el=>{
    if(el.textContent.toLowerCase().includes(q)){
      S.searchHits.push(el);
      el.innerHTML=el.textContent.replace(
        new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),
        m=>`<mark style="background:#f0b429;color:#000;border-radius:2px;padding:0 1px;">${m}</mark>`
      );
    }
  });
  $('chatSearchCount').textContent=S.searchHits.length?`1/${S.searchHits.length}`:'0 results';
  if(S.searchHits.length) goMatch(0);
});
$('chatSearchNext').addEventListener('click',()=>{
  if(!S.searchHits.length)return;
  goMatch((S.searchIdx+1)%S.searchHits.length);
});
$('chatSearchPrev').addEventListener('click',()=>{
  if(!S.searchHits.length)return;
  goMatch((S.searchIdx-1+S.searchHits.length)%S.searchHits.length);
});
function goMatch(i){
  S.searchIdx=i;
  S.searchHits[i]?.closest('.bubble-row')?.scrollIntoView({behavior:'smooth',block:'center'});
  $('chatSearchCount').textContent=`${i+1}/${S.searchHits.length}`;
}
function clearHL(){
  document.querySelectorAll('.bubble-text mark').forEach(m=>{
    m.parentNode.replaceChild(document.createTextNode(m.textContent),m);
    m.parentNode.normalize();
  });
}

// ══════════════════════════════════════════════
//  NEW CHAT MODAL
// ══════════════════════════════════════════════
$('newChatBtn').addEventListener('click', async ()=>{
  $('newChatModal').classList.remove('hidden');
  $('newChatSearch').value='';
  const list=$('newChatList');
  list.innerHTML='<div style="padding:24px;display:flex;justify-content:center;"><div style="width:22px;height:22px;border:2px solid var(--c-border);border-top-color:var(--c-accent);border-radius:50%;animation:spin .7s linear infinite;"></div></div>';
  setTimeout(()=>$('newChatSearch').focus(),100);
  await showAllUsers();
});
$('closeNewChat').addEventListener('click',()=>$('newChatModal').classList.add('hidden'));
$('newChatModal').addEventListener('click',e=>{ if(e.target===$('newChatModal')) $('newChatModal').classList.add('hidden'); });

async function showAllUsers(filter=''){
  const list=$('newChatList');
  try{
    const snap=await getDocs(collection(db,'users'));
    let users=snap.docs.map(d=>d.data())
      .filter(u=>u.uid&&u.uid!==S.me.uid&&u.name);
    if(filter) users=users.filter(u=>
      (u.name||'').toLowerCase().includes(filter)||
      (u.email||'').toLowerCase().includes(filter)
    );
    if(!users.length){
      list.innerHTML='<div style="padding:24px;text-align:center;color:var(--c-text-3);font-size:13px;">'
        +(filter?'No users found for <strong>'+esc(filter)+'</strong>':'No other users yet. Ask friends to sign up!')
        +'</div>';
      return;
    }
    list.innerHTML='';
    users.forEach(u=>{
      const item=document.createElement('div');
      item.className='new-chat-item';
      item.innerHTML=
        '<div class="avatar avatar-md" style="flex-shrink:0;"></div>'+
        '<div class="new-chat-item-info">'+
          '<div class="new-chat-item-name">'+esc(u.name)+'</div>'+
          '<div class="new-chat-item-email">'+esc(u.email||'')+'</div>'+
        '</div>';
      setAv(item.querySelector('.avatar'),u.name,u.photoURL||null);
      item.addEventListener('click',()=>{
        $('newChatModal').classList.add('hidden');
        openChat(u);
      });
      list.appendChild(item);
    });
  }catch(e){
    list.innerHTML='<div style="padding:24px;text-align:center;color:var(--c-danger);font-size:13px;">Error: '+e.message+'</div>';
    console.error('showAllUsers error:',e);
  }
}

let ncTimer=null;
$('newChatSearch').addEventListener('input',function(){
  clearTimeout(ncTimer);
  ncTimer=setTimeout(()=>showAllUsers(this.value.trim().toLowerCase()),300);
});

// ══════════════════════════════════════════════
//  CONTEXT MENU
// ══════════════════════════════════════════════
let ctxM=null;
function showCtx(e,m,isMe){
  e.preventDefault();
  ctxM=m;
  const menu=$('ctxMenu');
  menu.style.display='block';
  menu.style.top=Math.min(e.clientY,window.innerHeight-140)+'px';
  menu.style.left=Math.min(e.clientX,window.innerWidth-180)+'px';
  $('ctxDelete').style.display=isMe?'block':'none';
}
document.addEventListener('click',()=>{ $('ctxMenu').style.display='none'; });
$('ctxReact').addEventListener('click',()=>{ if(ctxM) doReact(ctxM.id,'❤️'); });
$('ctxCopy').addEventListener('click',()=>{
  if(ctxM&&ctxM.text) navigator.clipboard.writeText(ctxM.text).then(()=>toast('Copied!'));
});
$('ctxDelete').addEventListener('click',async()=>{
  if(!ctxM||!S.chatId) return;
  if(!confirm('Delete this message?')) return;
  await deleteDoc(doc(db,'chats',S.chatId,'messages',ctxM.id));
  toast('Deleted');
});

// ══════════════════════════════════════════════
//  LIGHTBOX
// ══════════════════════════════════════════════
function openLightbox(src){
  $('lightboxImg').src=src;
  $('lightbox').classList.remove('hidden');
}
$('lightboxClose').addEventListener('click',()=>$('lightbox').classList.add('hidden'));
$('lightbox').addEventListener('click',e=>{ if(e.target===$('lightbox')) $('lightbox').classList.add('hidden'); });

// ══════════════════════════════════════════════
//  PROFILE PANEL
// ══════════════════════════════════════════════
$('profileBtn').addEventListener('click',()=>{
  if(S.me){
    setAv($('profileAvatar'),S.me.name,S.me.photoURL);
    $('profileName').textContent=S.me.name||'User';
    $('profileStatusDisplay').textContent=S.me.status||'';
    $('profileStatusSub').textContent=S.me.status||'Set a status';
  }
  $('profilePanel').classList.add('open');
});
$('closeProfile').addEventListener('click',()=>$('profilePanel').classList.remove('open'));

// Avatar upload
$('profileAvatarWrap').addEventListener('click',()=>$('avatarInput').click());
$('avatarInput').addEventListener('change',async e=>{
  const f=e.target.files[0]; if(!f) return;
  toast('Uploading…');
  try{
    const url=await uploadAvatar(f,S.me.uid);
    await setDoc(doc(db,'users',S.me.uid),{photoURL:url},{merge:true});
    S.me.photoURL=url;
    setAv($('profileAvatar'),S.me.name,url);
    setAv($('myAvatar'),S.me.name,url);
    toast('Photo updated!','success');
  }catch(err){ toast(err.message,'error'); }
  e.target.value='';
});

// Status
$('editStatusBtn').addEventListener('click',()=>{
  $('statusInput').value=S.me?.status||'';
  $('statusModal').classList.remove('hidden');
  $('profilePanel').classList.remove('open');
});
$('closeStatusModal').addEventListener('click',()=>$('statusModal').classList.add('hidden'));
$('statusModal').addEventListener('click',e=>{ if(e.target===$('statusModal')) $('statusModal').classList.add('hidden'); });
window.setStatusQuick=txt=>{ $('statusInput').value=txt; };
$('saveStatusBtn').addEventListener('click',async()=>{
  const s=$('statusInput').value.trim(); if(!s) return;
  await setDoc(doc(db,'users',S.me.uid),{status:s},{merge:true});
  S.me.status=s;
  $('myStatus').textContent=s;
  $('statusModal').classList.add('hidden');
  toast('Status updated!','success');
});

// Settings toggles
$('toggleNotifItem').addEventListener('click',()=>{
  S.notif=!S.notif;
  $('notifToggle').classList.toggle('on',S.notif);
  if(S.notif) initNotifications();
  toast('Notifications '+(S.notif?'on':'off'));
});
$('toggleSoundItem').addEventListener('click',()=>{
  S.sound=!S.sound;
  $('soundToggle').classList.toggle('on',S.sound);
  toast('Sound '+(S.sound?'on':'off'));
});

// Logout
$('logoutBtn').addEventListener('click',async()=>{
  if(!confirm('Sign out?')) return;
  await setDoc(doc(db,'users',S.me.uid),{online:false,lastSeen:serverTimestamp()},{merge:true}).catch(()=>{});
  await signOut(auth);
  window.location.href='index.html';
});

// ══════════════════════════════════════════════
//  PRESENCE
// ══════════════════════════════════════════════
function setPresence(online){
  if(!S.me) return;
  setDoc(doc(db,'users',S.me.uid),{online,lastSeen:serverTimestamp()},{merge:true}).catch(()=>{});
}
document.addEventListener('visibilitychange',()=>setPresence(document.visibilityState==='visible'));
window.addEventListener('beforeunload',()=>setPresence(false));

// ══════════════════════════════════════════════
//  CHAT HEADER MENU
// ══════════════════════════════════════════════
$('chatMenuBtn').addEventListener('click',e=>{
  e.stopPropagation();
  const old=document.querySelector('.hctx'); if(old){old.remove();return;}
  const m=document.createElement('div');
  m.className='hctx';
  m.style.cssText='position:fixed;z-index:400;background:rgba(14,14,22,.97);backdrop-filter:blur(20px);border:1px solid var(--c-border-2);border-radius:var(--r-md);min-width:160px;box-shadow:var(--shadow-lg);overflow:hidden;';
  const rect=e.target.closest('.btn-icon').getBoundingClientRect();
  m.style.top=(rect.bottom+4)+'px'; m.style.right='16px';
  const style='padding:11px 18px;font-size:14px;cursor:pointer;transition:background .15s;';
  m.innerHTML=`
    <div style="${style}" id="hctxSrch" onmouseover="this.style.background='var(--c-surface-2)'" onmouseout="this.style.background=''">Search messages</div>
    <div style="${style}" id="hctxClr"  onmouseover="this.style.background='var(--c-surface-2)'" onmouseout="this.style.background=''">Clear local messages</div>
    <div style="${style}" id="hctxCls"  onmouseover="this.style.background='var(--c-surface-2)'" onmouseout="this.style.background=''">Close chat</div>`;
  document.body.appendChild(m);
  m.querySelector('#hctxSrch').onclick=()=>{ $('chatSearchBar').classList.remove('hidden'); $('chatSearchInput').focus(); m.remove(); };
  m.querySelector('#hctxClr').onclick=()=>{ $('messagesArea').innerHTML=''; toast('Cleared locally'); m.remove(); };
  m.querySelector('#hctxCls').onclick=()=>{
    $('chatPanel').classList.add('hidden');
    $('welcomeScreen').classList.remove('hidden');
    S.chatId=null; S.peer=null;
    document.querySelectorAll('.user-item').forEach(el=>el.classList.remove('active'));
    showSidebar();
    m.remove();
  };
  setTimeout(()=>document.addEventListener('click',()=>m.remove(),{once:true}),50);
});

// ══════════════════════════════════════════════
//  AUTH GUARD + INIT
// ══════════════════════════════════════════════
onAuthStateChanged(auth, async user => {
  if (!user) { window.location.href='index.html'; return; }

  console.log('Auth user:', user.uid, user.email, user.displayName);

  // Retry loading user doc up to 8 times (handles new user timing)
  let userData = null;
  for (let i=0; i<8; i++) {
    const snap = await getDoc(doc(db,'users',user.uid));
    if (snap.exists()) { userData=snap.data(); break; }
    console.log('Waiting for user doc... attempt', i+1);
    await new Promise(r=>setTimeout(r,500));
  }

  if (!userData) {
    // Create doc now if still missing
    console.log('Creating user doc from auth data');
    userData = {
      uid:       user.uid,
      name:      user.displayName || user.email?.split('@')[0] || 'User',
      email:     user.email,
      photoURL:  user.photoURL || null,
      status:    'Hey there! I am using NexChat 👋',
      online:    true,
      lastSeen:  serverTimestamp(),
      createdAt: serverTimestamp(),
      typingTo:  null,
    };
    await setDoc(doc(db,'users',user.uid), userData);
  }

  S.me = {
    uid:      user.uid,
    name:     userData.name     || user.displayName || user.email?.split('@')[0] || 'User',
    email:    user.email,
    photoURL: userData.photoURL || user.photoURL    || null,
    status:   userData.status   || 'Hey there!',
  };

  console.log('Loaded as:', S.me.name, S.me.email);

  setPresence(true);

  // Bottom bar
  setAv($('myAvatar'), S.me.name, S.me.photoURL);
  $('myName').textContent   = S.me.name;
  $('myStatus').textContent = S.me.status;

  // Notifications
  if (S.notif) initNotifications().catch(()=>{});

  // Load sidebar
  await loadSidebar();
});
