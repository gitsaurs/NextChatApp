// ═══════════════════════════════════════════════
//  storage.js  —  Cloudinary Free Upload
//  No Firebase Storage needed!
//  Free plan: 25GB storage, 25GB bandwidth/month
//
//  🔧 SETUP (free, no credit card):
//  1. Go to https://cloudinary.com/users/register/free
//  2. Sign up for free
//  3. Go to Dashboard → copy your "Cloud name"
//  4. Go to Settings → Upload → Add upload preset
//     → Set signing mode to "Unsigned" → Save
//  5. Replace CLOUD_NAME and UPLOAD_PRESET below
// ═══════════════════════════════════════════════

const CLOUD_NAME    = "dm4zff7pt";      // 🔧 e.g. "dxyz1234"
const UPLOAD_PRESET = "f3ddcynz";   // 🔧 e.g. "nexchat_unsigned"

const MAX_IMAGE_MB = 10;
const MAX_FILE_MB  = 25;

export function formatBytes(bytes) {
  if (bytes < 1024)     return bytes + ' B';
  if (bytes < 1048576)  return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

export function fileCategory(file) {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  return 'file';
}

// ── Upload to Cloudinary (free, unsigned) ─────────
export function uploadFile(file, chatId, uid, onProgress) {
  return new Promise((resolve, reject) => {
    const maxMB = file.type.startsWith('image/') ? MAX_IMAGE_MB : MAX_FILE_MB;
    if (file.size > maxMB * 1024 * 1024) {
      reject(new Error(`File too large. Max ${maxMB}MB.`));
      return;
    }

    const formData = new FormData();
    formData.append('file',           file);
    formData.append('upload_preset',  UPLOAD_PRESET);
    formData.append('folder',         `nexchat/${chatId}`);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/auto/upload`);

    xhr.upload.onprogress = e => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status === 200) {
        const data = JSON.parse(xhr.responseText);
        resolve({
          url:  data.secure_url,
          name: file.name,
          size: formatBytes(file.size),
          type: fileCategory(file),
        });
      } else {
        reject(new Error('Upload failed. Check your Cloudinary config.'));
      }
    };

    xhr.onerror = () => reject(new Error('Network error during upload.'));
    xhr.send(formData);
  });
}

// ── Upload avatar to Cloudinary ───────────────────
export function uploadAvatar(file, uid, onProgress) {
  return new Promise((resolve, reject) => {
    if (file.size > 5 * 1024 * 1024) {
      reject(new Error('Photo too large. Max 5MB.'));
      return;
    }

    const formData = new FormData();
    formData.append('file',           file);
    formData.append('upload_preset',  UPLOAD_PRESET);
    formData.append('folder',         'nexchat/avatars');
    formData.append('public_id',      `avatar_${uid}`);
    formData.append('transformation', 'w_200,h_200,c_fill,g_face');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`);

    xhr.upload.onprogress = e => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status === 200) {
        resolve(JSON.parse(xhr.responseText).secure_url);
      } else {
        reject(new Error('Avatar upload failed.'));
      }
    };

    xhr.onerror = () => reject(new Error('Network error.'));
    xhr.send(formData);
  });
}