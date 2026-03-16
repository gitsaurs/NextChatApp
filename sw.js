// ═══════════════════════════════════════════════
//  sw.js  —  Service Worker
//  Handles background push notifications via FCM
// ═══════════════════════════════════════════════

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// ── Firebase config (must match firebase.js) ──────
// 🔧 Replace with your actual config
firebase.initializeApp({
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID",
});

const messaging = firebase.messaging();

// ── Background message handler ────────────────────
messaging.onBackgroundMessage((payload) => {
  const { title, body, icon } = payload.notification || {};
  self.registration.showNotification(title || 'NexChat', {
    body:    body  || 'New message',
    icon:    icon  || '/icon.png',
    badge:   '/badge.png',
    tag:     'nexchat-message',
    renotify: true,
    data:    payload.data,
    actions: [
      { action: 'reply',  title: 'Reply'  },
      { action: 'ignore', title: 'Ignore' },
    ],
  });
});

// ── Notification click handler ────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'ignore') return;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes('chat.html') && 'focus' in c);
      if (existing) return existing.focus();
      return clients.openWindow('/chat.html');
    })
  );
});

// ── Cache app shell for offline ───────────────────
const CACHE = 'nexchat-v1';
const SHELL = ['/', '/index.html', '/chat.html', '/style.css', '/auth.js', '/chat.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});