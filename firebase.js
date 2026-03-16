// ═══════════════════════════════════════════════
//  firebase.js  —  Config + Service Exports
//  🔧 REPLACE the firebaseConfig values below
//     with your own from Firebase Console
// ═══════════════════════════════════════════════

import { initializeApp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, GoogleAuthProvider }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getMessaging }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js";

// ── 🔧 YOUR FIREBASE CONFIG ──────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyAcNS8AxxI91yO62mh2ONDrnVG4cewNkW4",
  authDomain:        "chatapp-6ac7b.firebaseapp.com",
  projectId:         "chatapp-6ac7b",
  storageBucket:     "chatapp-6ac7b.firebasestorage.app",
  messagingSenderId: "174299749452",
  appId:             "1:174299749452:web:11e2d42dae7d419d6ce8e9",
};
// ─────────────────────────────────────────────────

const app            = initializeApp(firebaseConfig);
const auth           = getAuth(app);
const db             = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

// Messaging — wrapped in try/catch (requires HTTPS)
let messaging = null;
try {
  messaging = getMessaging(app);
} catch (_) {}

// Your FCM VAPID key (optional — only needed for push notifications)
export const VAPID_KEY = "BE123MOf19noJ6u_tKUKVb-qOCi-5ChchmERpZxZjgfzv3wak_dP_9LjzAH6RRub72AuaX4O4uf7MjY3hEOoztE";

export { app, auth, db, messaging, googleProvider };