// Backup file: every note as JSON, optionally with its audio (16 kHz
// 16-bit PCM, base64). Import merges by note id; the newer copy of a note wins.

import * as db from './db.js';

const FORMAT = 'puhemuistio-backup';
const VERSION = 1;

function toBase64(bytes) {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(s);
}

function fromBase64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function exportBackup(includeAudio) {
  const { notes, audio } = await db.getAllForBackup(includeAudio);
  // Built in parts so a backup with lots of audio never has to exist as one
  // giant string in memory.
  const parts = [`{"format":"${FORMAT}","version":${VERSION},"exportedAt":${Date.now()},"notes":${JSON.stringify(notes)},"audio":{`];
  audio.forEach((row, i) => {
    parts.push(`${i ? ',' : ''}${JSON.stringify(row.noteId)}:"`);
    parts.push(toBase64(new Uint8Array(row.pcm)));
    parts.push('"');
  });
  parts.push('}}');
  const blob = new Blob(parts, { type: 'application/json' });
  const name = `puhemuistio-backup-${new Date().toISOString().slice(0, 10)}.json`;
  return { blob, name, count: notes.length };
}

export async function importBackup(file) {
  const data = JSON.parse(await file.text());
  if (data.format !== FORMAT || !Array.isArray(data.notes)) {
    throw new Error('This is not a Puhemuistio backup file.');
  }
  if (data.version > VERSION) throw new Error('This backup is from a newer version of the app.');
  const audio = new Map();
  for (const [noteId, b64] of Object.entries(data.audio || {})) {
    audio.set(noteId, new Int16Array(fromBase64(b64).buffer));
  }
  const notes = data.notes.filter((n) => n && typeof n.id === 'string' && typeof n.createdAt === 'number');
  return db.importNotes(notes, audio);
}
