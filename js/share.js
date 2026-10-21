// Getting notes out of the app. Every function here runs only when the user
// taps a button; nothing is ever sent automatically.

// iOS Mail opens long mailto: links unreliably. Above this length (of the
// encoded URL) the note goes to the clipboard instead.
const MAILTO_MAX = 8000;

export function formatDate(ts) {
  return new Date(ts).toLocaleString('fi-FI', {
    day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function noteTitle(note) {
  return note.title?.trim() || 'Note ' + formatDate(note.createdAt);
}

export function noteAsText(note) {
  return `${noteTitle(note)}\n${formatDate(note.createdAt)}\n\n${(note.text || '').trim()}\n`;
}

export function notesAsText(notes) {
  return notes.map(noteAsText).join('\n----------\n\n');
}

function subjectFor(notes) {
  return notes.length === 1 ? noteTitle(notes[0]) : `Notes (${notes.length})`;
}

function safeFileName(s) {
  return s.replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'note';
}

export async function copy(notes) {
  await navigator.clipboard.writeText(notesAsText(notes));
}

/**
 * Open Mail with the note. Returns 'opened' or 'copied' (too long for a
 * mailto: link: the text went to the clipboard and Mail opens with just the
 * subject, so the user pastes the note in).
 */
export async function email(notes, to = '') {
  const subject = subjectFor(notes);
  const body = notesAsText(notes);
  const base = `mailto:${encodeURIComponent(to.trim()).replace(/%40/g, '@')}?subject=${encodeURIComponent(subject)}`;
  const full = `${base}&body=${encodeURIComponent(body)}`;
  if (full.length <= MAILTO_MAX) {
    window.location.href = full;
    return 'opened';
  }
  await navigator.clipboard.writeText(body);
  window.location.href = base;
  return 'copied';
}

/** iOS share sheet with the text. Returns false if sharing isn't available. */
export async function share(notes) {
  if (!navigator.share) return false;
  try {
    await navigator.share({ title: subjectFor(notes), text: notesAsText(notes) });
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  }
  return true;
}

/** Shares a file through the share sheet ("Save to Files" is there); downloads it where sharing files isn't possible. */
export async function shareFile(blob, fileName) {
  const file = new File([blob], fileName, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      if (err.name !== 'AbortError') throw err;
    }
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function saveTextFile(notes) {
  const name = notes.length === 1 ? safeFileName(noteTitle(notes[0])) : `notes-${new Date().toISOString().slice(0, 10)}`;
  return shareFile(new Blob([notesAsText(notes)], { type: 'text/plain' }), name + '.txt');
}
