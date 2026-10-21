// IndexedDB storage. Everything the app knows lives here, on the phone.
//
// Stores:
//   notes    { id, title, createdAt, updatedAt, text, language, audioSamples,
//              pendingFrom, error }
//            pendingFrom: sample offset where untranscribed audio starts
//            (null when the text is up to date with the audio).
//   audio    { noteId, pcm }  16 kHz mono Int16 PCM as an ArrayBuffer
//   drafts   { id, noteId, title, language, createdAt, samples }
//            A recording in progress or paused. Survives reloads.
//   chunks   { draftId, seq, pcm }  The draft's audio, saved every second
//            so a screen lock or crash loses at most a second.
//   settings { key, value }

const DB_NAME = 'puhemuistio';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('notes')) {
        const notes = db.createObjectStore('notes', { keyPath: 'id' });
        notes.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'noteId' });
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) {
        const chunks = db.createObjectStore('chunks', { autoIncrement: true });
        chunks.createIndex('draft', 'draftId');
      }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgraded the schema: close so it isn't blocked.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

function result(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function get(store, key) {
  const db = await open();
  return result(db.transaction(store).objectStore(store).get(key));
}

async function getAll(store) {
  const db = await open();
  return result(db.transaction(store).objectStore(store).getAll());
}

async function put(store, value) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return done(tx);
}

async function del(store, key) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return done(tx);
}

export function newId() {
  return Date.now().toString(36) + '-' + crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
}

// ---------- notes ----------

export async function listNotes() {
  const notes = await getAll('notes');
  return notes.sort((a, b) => b.createdAt - a.createdAt);
}

export const getNote = (id) => get('notes', id);

export async function saveNote(note) {
  note.updatedAt = Date.now();
  await put('notes', note);
  return note;
}

export async function deleteNote(id) {
  const db = await open();
  const tx = db.transaction(['notes', 'audio'], 'readwrite');
  tx.objectStore('notes').delete(id);
  tx.objectStore('audio').delete(id);
  return done(tx);
}

// ---------- audio ----------

/** @returns {Promise<Int16Array|null>} */
export async function getAudio(noteId) {
  const row = await get('audio', noteId);
  return row ? new Int16Array(row.pcm) : null;
}

export async function deleteAudio(noteId) {
  const db = await open();
  const tx = db.transaction(['notes', 'audio'], 'readwrite');
  tx.objectStore('audio').delete(noteId);
  const notes = tx.objectStore('notes');
  const req = notes.get(noteId);
  req.onsuccess = () => {
    const note = req.result;
    if (!note) return;
    note.audioSamples = 0;
    note.pendingFrom = null;
    note.updatedAt = Date.now();
    notes.put(note);
  };
  return done(tx);
}

/**
 * Save a note together with its audio in one transaction, so a note never
 * points at audio that wasn't written.
 */
export async function saveNoteWithAudio(note, pcm) {
  const db = await open();
  note.updatedAt = Date.now();
  const tx = db.transaction(['notes', 'audio'], 'readwrite');
  tx.objectStore('notes').put(note);
  tx.objectStore('audio').put({ noteId: note.id, pcm: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) });
  return done(tx);
}

// ---------- drafts (recording in progress) ----------

export async function getDraft() {
  const drafts = await getAll('drafts');
  return drafts[0] || null;
}

export const saveDraft = (draft) => put('drafts', draft);

export async function appendChunk(draft, seq, pcm) {
  const db = await open();
  const tx = db.transaction(['chunks', 'drafts'], 'readwrite');
  tx.objectStore('chunks').add({ draftId: draft.id, seq, pcm: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) });
  tx.objectStore('drafts').put(draft);
  return done(tx);
}

/** @returns {Promise<Int16Array>} All of the draft's audio joined in order. */
export async function getDraftAudio(draftId) {
  const db = await open();
  const rows = await result(db.transaction('chunks').objectStore('chunks').index('draft').getAll(draftId));
  rows.sort((a, b) => a.seq - b.seq);
  let total = 0;
  for (const r of rows) total += r.pcm.byteLength / 2;
  const out = new Int16Array(total);
  let off = 0;
  for (const r of rows) {
    const part = new Int16Array(r.pcm);
    out.set(part, off);
    off += part.length;
  }
  return out;
}

export async function deleteDraft(draftId) {
  const db = await open();
  const tx = db.transaction(['chunks', 'drafts'], 'readwrite');
  tx.objectStore('drafts').delete(draftId);
  const idx = tx.objectStore('chunks').index('draft');
  const req = idx.openKeyCursor(IDBKeyRange.only(draftId));
  req.onsuccess = () => {
    const cursor = req.result;
    if (!cursor) return;
    tx.objectStore('chunks').delete(cursor.primaryKey);
    cursor.continue();
  };
  return done(tx);
}

/**
 * Turn a finished draft into a note (new, or appended to an existing one) in
 * a single transaction, then drop the draft. Returns the note.
 */
export async function commitDraft(draft) {
  const newPcm = await getDraftAudio(draft.id);
  const db = await open();
  let note;
  let pcm;
  if (draft.noteId) {
    note = await getNote(draft.noteId);
  }
  if (note) {
    const old = (await getAudio(note.id)) || new Int16Array(0);
    pcm = new Int16Array(old.length + newPcm.length);
    pcm.set(old, 0);
    pcm.set(newPcm, old.length);
    // Text so far still matches the old audio; only the new part needs work.
    // If an earlier part was never transcribed, keep the earlier start.
    note.pendingFrom = note.pendingFrom != null ? Math.min(note.pendingFrom, old.length) : old.length;
    note.audioSamples = pcm.length;
  } else {
    pcm = newPcm;
    note = {
      id: draft.noteId || newId(),
      title: draft.title || '',
      createdAt: draft.createdAt,
      text: '',
      language: draft.language,
      audioSamples: pcm.length,
      pendingFrom: 0,
    };
  }
  note.error = null;
  note.updatedAt = Date.now();
  const tx = db.transaction(['notes', 'audio', 'drafts', 'chunks'], 'readwrite');
  tx.objectStore('notes').put(note);
  tx.objectStore('audio').put({ noteId: note.id, pcm: pcm.buffer });
  tx.objectStore('drafts').delete(draft.id);
  const req = tx.objectStore('chunks').index('draft').openKeyCursor(IDBKeyRange.only(draft.id));
  req.onsuccess = () => {
    const cursor = req.result;
    if (!cursor) return;
    tx.objectStore('chunks').delete(cursor.primaryKey);
    cursor.continue();
  };
  await done(tx);
  return note;
}

// ---------- settings ----------

const DEFAULTS = {
  language: 'fi',     // 'fi' | 'en' | 'auto'
  model: null,        // model id, null = default from engine
  email: '',
  backupAudio: true,
};

export async function getSettings() {
  const rows = await getAll('settings');
  const s = { ...DEFAULTS };
  for (const r of rows) s[r.key] = r.value;
  return s;
}

export const setSetting = (key, value) => put('settings', { key, value });

// ---------- backup ----------

export async function getAllForBackup(includeAudio) {
  const notes = await listNotes();
  const audio = includeAudio ? await getAll('audio') : [];
  return { notes, audio };
}

/** Insert notes from a backup. Existing notes win unless the backup copy is newer. */
export async function importNotes(notes, audioByNote) {
  const db = await open();
  const existing = new Map((await getAll('notes')).map((n) => [n.id, n]));
  let added = 0, updated = 0, skipped = 0;
  const tx = db.transaction(['notes', 'audio'], 'readwrite');
  for (const n of notes) {
    const cur = existing.get(n.id);
    if (cur && (cur.updatedAt || 0) >= (n.updatedAt || 0)) { skipped++; continue; }
    const pcm = audioByNote.get(n.id);
    const hasOldAudio = cur && cur.audioSamples > 0;
    if (pcm) {
      tx.objectStore('audio').put({ noteId: n.id, pcm: pcm.buffer });
    } else if (!hasOldAudio) {
      n.audioSamples = 0;
      n.pendingFrom = null;
    } else {
      // Backup has no audio but the phone does: keep the phone's audio.
      n.audioSamples = cur.audioSamples;
    }
    tx.objectStore('notes').put(n);
    if (cur) updated++; else added++;
  }
  await done(tx);
  return { added, updated, skipped };
}
