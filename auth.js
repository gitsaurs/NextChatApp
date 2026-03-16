// ═══════════════════════════════════════════════
//  auth.js  —  Authentication Logic
//  Handles: Email login/signup, Google OAuth,
//  password reset, Firestore user profile init
// ═══════════════════════════════════════════════

import {
  auth, db, googleProvider
} from "./firebase.js";

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  sendPasswordResetEmail,
  updateProfile,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import {
  doc, setDoc, getDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Toast ─────────────────────────────────────────
function toast(msg, type = '') {
  const wrap = document.getElementById('toastWrap');
  const el   = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Error messages ────────────────────────────────
const AUTH_ERRORS = {
  'auth/email-already-in-use':   'This email is already registered. Sign in instead.',
  'auth/invalid-email':          'Please enter a valid email address.',
  'auth/weak-password':          'Password must be at least 8 characters.',
  'auth/user-not-found':         'No account found with this email.',
  'auth/wrong-password':         'Incorrect password. Try again.',
  'auth/too-many-requests':      'Too many attempts. Please wait a moment.',
  'auth/popup-closed-by-user':   'Google sign-in was cancelled.',
  'auth/network-request-failed': 'Network error. Check your connection.',
  'auth/invalid-credential':     'Invalid email or password.',
};
function friendlyError(code) {
  return AUTH_ERRORS[code] || 'Something went wrong. Please try again.';
}

// ── Show/hide error banner ────────────────────────
function showError(formId, msg) {
  const el = document.getElementById(formId + 'Error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearError(formId) {
  const el = document.getElementById(formId + 'Error');
  if (el) { el.textContent = ''; el.classList.add('hidden'); }
}

// ── Button loading state ──────────────────────────
function setLoading(btnId, loading, defaultText) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  btn.innerHTML = loading
    ? `<div class="btn-spinner"></div> Please wait...`
    : defaultText;
}

// ── Create / update Firestore user document ───────
async function ensureUserDoc(user, extraData = {}) {
  const ref  = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    // Brand new user — create full document
    await setDoc(ref, {
      uid:       user.uid,
      name:      user.displayName || extraData.name || 'Anonymous',
      email:     user.email,
      photoURL:  user.photoURL || null,
      status:    'Hey there! I am using NexChat 👋',
      online:    true,
      lastSeen:  serverTimestamp(),
      createdAt: serverTimestamp(),
      fcmToken:  null,
      typingTo:  null,
    });
  } else {
    // Existing user — only update login-time fields
    await setDoc(ref, {
      online:   true,
      lastSeen: serverTimestamp(),
      email:    user.email,
    }, { merge: true });
  }
}

// ── Tab switcher ──────────────────────────────────
window.switchTab = function(tab) {
  const loginForm  = document.getElementById('loginForm');
  const signupForm = document.getElementById('signupForm');
  const tabLogin   = document.getElementById('tabLogin');
  const tabSignup  = document.getElementById('tabSignup');

  if (tab === 'login') {
    loginForm.classList.remove('hidden');
    signupForm.classList.add('hidden');
    tabLogin.classList.add('active');
    tabSignup.classList.remove('active');
    clearError('login');
  } else {
    signupForm.classList.remove('hidden');
    loginForm.classList.add('hidden');
    tabSignup.classList.add('active');
    tabLogin.classList.remove('active');
    clearError('signup');
  }
};

// ── Password strength meter ───────────────────────
window.checkPasswordStrength = function(pw) {
  const bars  = [1, 2, 3, 4].map(i => document.getElementById('pwBar' + i));
  const score = [
    pw.length >= 8,
    /[A-Z]/.test(pw),
    /[0-9]/.test(pw),
    /[^A-Za-z0-9]/.test(pw),
  ].filter(Boolean).length;

  const classes = ['', 'weak', 'fair', 'fair', 'strong'];
  bars.forEach((b, i) => {
    b.className = 'pw-bar';
    if (i < score) b.classList.add(classes[score]);
  });
};

// ── Email Login ───────────────────────────────────
window.handleLogin = async function(e) {
  e.preventDefault();
  clearError('login');
  const email    = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  setLoading('loginBtn', true, 'Sign In');

  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    await ensureUserDoc(cred.user);
    toast('Welcome back! 👋', 'success');
    setTimeout(() => window.location.href = 'chat.html', 600);
  } catch (err) {
    showError('login', friendlyError(err.code));
    setLoading('loginBtn', false, 'Sign In');
  }
};

// ── Email Signup ──────────────────────────────────
window.handleSignup = async function(e) {
  e.preventDefault();
  clearError('signup');

  const name     = document.getElementById('signupName').value.trim();
  const email    = document.getElementById('signupEmail').value.trim();
  const password = document.getElementById('signupPassword').value;
  const confirm  = document.getElementById('signupConfirm').value;

  if (password !== confirm) {
    showError('signup', 'Passwords do not match.');
    return;
  }
  if (password.length < 8) {
    showError('signup', 'Password must be at least 8 characters.');
    return;
  }

  setLoading('signupBtn', true, 'Create Account');

  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);

    // Update Firebase Auth profile FIRST
    await updateProfile(cred.user, { displayName: name });

    // Force reload so displayName is fresh
    await cred.user.reload();

    // Create Firestore doc with explicit name (don't rely on displayName timing)
    const ref = doc(db, 'users', cred.user.uid);
    await setDoc(ref, {
      uid:       cred.user.uid,
      name:      name,
      email:     email,
      photoURL:  null,
      status:    'Hey there! I am using NexChat 👋',
      online:    true,
      lastSeen:  serverTimestamp(),
      createdAt: serverTimestamp(),
      fcmToken:  null,
      typingTo:  null,
    });

    toast('Account created! Welcome to NexChat 🎉', 'success');
    setTimeout(() => window.location.href = 'chat.html', 800);
  } catch (err) {
    showError('signup', friendlyError(err.code));
    setLoading('signupBtn', false, 'Create Account');
  }
};

// ── Google Sign-in ────────────────────────────────
window.handleGoogle = async function() {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    await ensureUserDoc(result.user);
    toast('Signed in with Google! 👋', 'success');
    setTimeout(() => window.location.href = 'chat.html', 600);
  } catch (err) {
    toast(friendlyError(err.code), 'error');
  }
};

// ── Forgot Password ───────────────────────────────
window.handleForgotPassword = async function(e) {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  if (!email) {
    showError('login', 'Enter your email address first, then click Forgot password.');
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    toast('Password reset email sent! Check your inbox.', 'success');
  } catch (err) {
    toast(friendlyError(err.code), 'error');
  }
};

// ── Auth state guard ──────────────────────────────
// If already logged in, skip auth page
onAuthStateChanged(auth, (user) => {
  if (user) {
    window.location.href = 'chat.html';
  }
});