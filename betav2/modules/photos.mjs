// First Light — modules/photos.mjs
// =============================================================================
// Photo-handling helpers extracted from diary.js during the Phase-1
// modularisation. See MODULARISATION-PLAN.md → Commit G.
//
// Scope (pure or pure-browser; no app-state dependencies):
//   • CULL_PHOTO_SIGN_EXPIRES     — signed-URL TTL (seconds) for the private
//                                   cull-photos bucket
//   • newCullPhotoPath(userId)    — collision-free storage path builder
//   • cullPhotoStoragePath(url)   — legacy URL → bucket-relative path parser
//   • dataUrlToBlob(dataUrl)      — base64 data: URL → Blob (used by the
//                                   offline-queue drain when we need to
//                                   re-upload a photo saved as a data URL
//                                   while the device was offline)
//   • compressPhotoFile(file, …)  — Promise-based canvas pipeline that reads
//                                   a <input type=file> File, downscales to
//                                   a max longest side, re-encodes JPEG, and
//                                   returns the compressed File plus an
//                                   object-URL preview
//
// Explicitly out-of-scope for this commit (they touch app state and stay in
// diary.js until the relevant layer graduates):
//   • handlePhoto()                    — writes the `photoFile` /
//                                        `photoPreviewUrl` globals + DOM slot
//   • resolveCullPhotoDisplayUrls()    — needs `sb` and `currentUser`
//   • saveOfflinePhotoBlob() & co.     — IndexedDB plumbing
//   • offlinePhotoWarn()               — UI confirm
//   • PHOTO_SLOT_EMPTY_HTML / resetPhotoSlot() — DOM markup
//
// All five exports below are either fully pure (the three string / data URL
// helpers run unchanged in Node 18+ and are unit-tested) or pure-browser
// (compressPhotoFile needs Image/Canvas/FileReader — smoke-tested only).
// =============================================================================

/**
 * Signed URL lifetime for private bucket reads (seconds). 86400 = 24h,
 * chosen to comfortably cover one field day of tethered PDF export without
 * forcing the client to re-sign thumbnails mid-session. Bucket is private
 * (RLS gate) so leaking a signed URL is still bounded by this TTL.
 */
export const CULL_PHOTO_SIGN_EXPIRES = 86400;

/**
 * Build a collision-free storage path for a new cull photo.
 * Format: "<userId>/<ms>-<rand6>.jpg".
 *
 * Rationale: Date.now() alone collides when two uploads fire in the same
 * millisecond — realistic during offline-queue drain where several photos
 * can upload back-to-back inside a tight loop. Combined with `upsert: true`
 * the losing upload silently overwrites the winner and two cull_entries
 * rows end up pointing at the same file. The 6-char random suffix brings
 * collision probability to ~1 in 2 billion per millisecond.
 */
export function newCullPhotoPath(userId) {
  var rand = Math.random().toString(36).slice(2, 8);
  return userId + '/' + Date.now() + '-' + rand + '.jpg';
}

/**
 * Return the storage object path within bucket `cull-photos`, i.e. the
 * "<userId>/<file>.jpg" portion that Supabase Storage operations expect.
 *
 * Accepts three input shapes (all of which exist in production data):
 *   1. A bucket-relative path already ("<uuid>/<file>.jpg") — passed through.
 *   2. A full public or signed URL containing "/cull-photos/<path>[?token]".
 *   3. null / empty / junk → returns null (caller must skip cleanly).
 *
 * Legacy note: some very old rows stored the public URL shape; most new rows
 * store the bucket-relative path. Either works everywhere this helper is used.
 */
export function cullPhotoStoragePath(photo_url) {
  if (!photo_url || typeof photo_url !== 'string') return null;
  var s = photo_url.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    if (/^[0-9a-f-]{36}\//i.test(s)) return s;
    return null;
  }
  var m = s.match(/cull-photos\/([^?]+)/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch (e) {
    return m[1];
  }
}

/**
 * Decode a "data:<mime>;base64,<payload>" URL to a Blob without touching
 * fetch(). Used by the offline-queue drain to turn a photo that was saved
 * as a data URL (during the brief window before IndexedDB blob support
 * landed) back into a Blob suitable for supabase.storage.upload().
 *
 * Throws rather than returns null so the queue-drain loop can capture the
 * failure and mark that entry as broken instead of silently dropping the
 * photo. The caller in diary.js wraps this in try/catch.
 */
export function dataUrlToBlob(dataUrl) {
  var arr = (dataUrl || '').split(',');
  var mimeMatch = arr[0] ? arr[0].match(/:(.*?);/) : null;
  if (!mimeMatch || !arr[1]) throw new Error('Malformed photo data URL');
  var mime = mimeMatch[1];
  var bstr = atob(arr[1]);
  var u8arr = new Uint8Array(bstr.length);
  for (var i = 0; i < bstr.length; i++) u8arr[i] = bstr.charCodeAt(i);
  return new Blob([u8arr], { type: mime });
}

/**
 * Read a user-picked File, downscale via a <canvas>, re-encode as JPEG, and
 * resolve to { blob, file, previewUrl, kb, width, height }. Pure-browser —
 * uses FileReader + Image + Canvas. Cannot be Node-tested meaningfully
 * without a headless browser, so we rely on the diary.js smoke-test: pick
 * a 4K photo, verify the slot shows it and "Photo ready · NNN KB" toast.
 *
 * Defaults (800px longest side, quality 0.75) match the prior inline
 * behaviour in `handlePhoto()` — changing them would bump every future
 * upload's size and break our "photos stay under ~200 KB" expectation
 * shipped against the free Supabase Storage tier. Override via opts only
 * for specific call sites (e.g. a future "HQ trophy shot" path).
 *
 * @param {File} file - the raw File from an <input type="file"> change event
 * @param {Object} [opts]
 * @param {number} [opts.maxDim=800]   longest-side pixel cap
 * @param {number} [opts.quality=0.75] JPEG quality (0-1)
 * @param {string} [opts.mimeType='image/jpeg']
 * @param {string} [opts.filename='photo.jpg'] name assigned to the output File
 * @returns {Promise<{ blob: Blob, file: File, previewUrl: string, kb: number, width: number, height: number }>}
 */
export function compressPhotoFile(file, opts) {
  opts = opts || {};
  var maxDim   = opts.maxDim   || 800;
  var quality  = (opts.quality != null) ? opts.quality : 0.75;
  var mimeType = opts.mimeType || 'image/jpeg';
  var filename = opts.filename || 'photo.jpg';

  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onerror = function () {
      reject(reader.error || new Error('FileReader failed'));
    };
    reader.onload = function (ev) {
      var img = new Image();
      img.onerror = function () { reject(new Error('Image decode failed')); };
      img.onload = function () {
        var w = img.width;
        var h = img.height;
        // Downscale the longest side to maxDim; preserve aspect ratio.
        if (w > h) {
          if (w > maxDim) { h = Math.round(h * maxDim / w); w = maxDim; }
        } else {
          if (h > maxDim) { w = Math.round(w * maxDim / h); h = maxDim; }
        }

        var canvas = document.createElement('canvas');
        canvas.width  = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);

        canvas.toBlob(function (blob) {
          if (!blob) { reject(new Error('Canvas toBlob returned null')); return; }
          var compressedFile = new File([blob], filename, { type: mimeType });
          var previewUrl = URL.createObjectURL(blob);
          var kb = Math.round(compressedFile.size / 1024);
          resolve({ blob: blob, file: compressedFile, previewUrl: previewUrl, kb: kb, width: w, height: h });
        }, mimeType, quality);
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}
