// ═══════════════════════════════════════════════
//  notifications.js  —  Push Notification Setup
// ═══════════════════════════════════════════════

import { messaging, VAPID_KEY, db, auth } from "./firebase.js";
import {
  getToken, onMessage,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js";
import {
  doc, setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Register service worker + get FCM token ───────
export async function initNotifications() {
  if (!('Notification' in window)) return null;

  try {
    // Register service worker
    const reg = await navigator.serviceWorker.register('/sw.js');

    // Request permission
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return null;

    // Get FCM token
    const token = await getToken(messaging, {
      vapidKey:          VAPID_KEY,
      serviceWorkerRegistration: reg,
    });

    if (token && auth.currentUser) {
      // Save token to Firestore so other users can send notifs
      await setDoc(
        doc(db, 'users', auth.currentUser.uid),
        { fcmToken: token },
        { merge: true }
      );
    }

    return token;
  } catch (err) {
    console.warn('Notifications not available:', err.message);
    return null;
  }
}

// ── Handle foreground messages ────────────────────
export function onForegroundMessage(callback) {
  try {
    return onMessage(messaging, (payload) => {
      callback(payload);
    });
  } catch (_) {
    return () => {};
  }
}

// ── Show a local browser notification ────────────
export function showLocalNotif(title, body, icon = '') {
  if (Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return; // don't show if tab is focused
  new Notification(title, { body, icon, badge: '/icon.png' });
}

// ── Play notification sound ───────────────────────
export function playSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  } catch (_) {}
}