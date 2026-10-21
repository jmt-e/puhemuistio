// Puhemuistio: private voice notes. UI and app flow.

import * as db from './db.js';
import * as engine from './engine.js';
import * as share from './share.js';
import * as backup from './backup.js';
import { Recorder, MicError, MAX_SECONDS, SAMPLE_RATE, int16ToFloat32, pcmToWav } from './recorder.js';

export const APP_VERSION = '0.1.0';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  settings: null,
  notes: [],
  selecting: false,
  selected: new Set(),
  noteId: null,       // note open in the note view
  note: null,         // that note as last loaded
  jobs: new Map(),    // noteId -> { stage, fraction, partial }
  queue: Promise.resolve(),
};

const recorder = new Recorder();

// ---------- helpers ----------

function fmtTime(sec) {
  sec = Math.floor(sec);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6) return Math.round(b / 1e6) + ' MB';
  return Math.max(1, Math.round(b / 1e3)) + ' kB';
}

const LANG_LABEL = { fi: 'Finnish', en: 'English', auto: 'Auto' };

let toastTimer = null;
function toast(msg, ms = 3000) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

// Bottom sheet. Returns a promise of the value passed to close().
let sheetResolve = null;
function openSheet(build) {
  closeSheet();
  const sheet = $('#sheet');
  sheet.replaceChildren();
  return new Promise((resolve) => {
    sheetResolve = resolve;
    build(sheet, closeSheet);
    sheet.hidden = false;
    $('#sheet-backdrop').hidden = false;
  });
}
function closeSheet(value) {
  $('#sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
  const r = sheetResolve;
  sheetResolve = null;
  r?.(value);
}

function confirmSheet(title, text, okLabel, danger = false) {
  return openSheet((sheet, close) => {
    sheet.append(
      el('h3', {}, title),
      text ? el('p', { class: 'muted' }, text) : null,
      el('div', { class: 'btn-row' },
        el('button', { class: 'wide-btn ' + (danger ? 'danger' : 'primary'), type: 'button', onclick: () => close(true) }, okLabel),
        el('button', { class: 'wide-btn', type: 'button', onclick: () => close(false) }, 'Cancel'),
      ),
    );
  });
}

function showMicHelp(kind) {
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  return openSheet((sheet, close) => {
    if (kind === 'insecure') {
      sheet.append(el('h3', {}, 'Microphone needs a secure page'), el('p', {}, 'Open the app from its https:// address.'));
    } else if (kind === 'unsupported') {
      sheet.append(el('h3', {}, 'Recording is not supported here'), el('p', {}, 'Use Safari on iOS 16.4 or newer.'));
    } else if (kind === 'nomic') {
      sheet.append(el('h3', {}, 'No microphone found'), el('p', {}, 'Check that no other app is using the microphone, then try again.'));
    } else {
      sheet.append(
        el('h3', {}, 'Allow the microphone'),
        el('p', {}, 'The app needs the microphone to record. The audio stays on this phone.'),
        standalone
          ? el('ol', {},
              el('li', {}, 'Open the iPhone Settings app.'),
              el('li', {}, 'Go to Apps → Safari → Microphone (on older iOS: Safari → Microphone).'),
              el('li', {}, 'Choose Ask or Allow.'),
              el('li', {}, 'Close Puhemuistio completely: swipe up from the bottom edge, then swipe the app away.'),
              el('li', {}, 'Open Puhemuistio again and tap record. Tap Allow when asked.'),
            )
          : el('ol', {},
              el('li', {}, 'Tap the page menu button at the left end of the address bar (aA or ☰).'),
              el('li', {}, 'Tap Website Settings.'),
              el('li', {}, 'Set Microphone to Ask or Allow, and tap Done.'),
              el('li', {}, 'Reload the page and tap record again.'),
              el('li', {}, 'If Microphone is missing there: Settings app → Apps → Safari → Microphone → Ask.'),
            ),
        el('p', { class: 'muted small' }, 'If it is still blocked: Settings → Screen Time → Content & Privacy Restrictions → Microphone → Allow Changes.'),
      );
    }
    sheet.append(el('div', { class: 'btn-row' }, el('button', { class: 'wide-btn primary', type: 'button', onclick: () => close() }, 'OK')));
  });
}

// ---------- routing ----------

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route() {
  const hash = location.hash || '#/';
  const [, view, arg] = hash.match(/^#\/?([^/]*)\/?(.*)$/) || [];
  for (const v of $$('.view')) v.hidden = true;
  closeSheet();
  if (view === 'note' && arg) return showNote(decodeURIComponent(arg));
  if (view === 'record') return showRecord(arg ? decodeURIComponent(arg) : null);
  if (view === 'settings') return showSettings();
  return showList();
}

// ---------- list ----------

async function showList() {
  state.noteId = null;
  $('#view-list').hidden = false;
  state.notes = await db.listNotes();
  renderList();
  renderDraftBanner();
}

function noteMatches(note, q) {
  if (!q) return true;
  const hay = (share.noteTitle(note) + '\n' + (note.text || '') + '\n' + share.formatDate(note.createdAt)).toLocaleLowerCase('fi');
  return q.toLocaleLowerCase('fi').split(/\s+/).every((w) => hay.includes(w));
}

function renderList() {
  const q = $('#search').value.trim();
  const list = $('#notes');
  const notes = state.notes.filter((n) => noteMatches(n, q));
  list.replaceChildren(
    ...notes.map((n) => {
      const job = state.jobs.get(n.id);
      const snippet = (n.text || '').trim().slice(0, 200);
      const badge = job
        ? el('span', { class: 'badge' }, job.stage === 'download' ? 'downloading model' : 'transcribing')
        : n.error
          ? el('span', { class: 'badge warn' }, 'not transcribed')
          : n.pendingFrom != null
            ? el('span', { class: 'badge' }, 'waiting')
            : null;
      const item = el('li', {
        class: 'note-item' + (state.selected.has(n.id) ? ' selected' : ''),
        onclick: () => {
          if (state.selecting) {
            if (state.selected.has(n.id)) state.selected.delete(n.id);
            else state.selected.add(n.id);
            renderList();
          } else {
            go('#/note/' + encodeURIComponent(n.id));
          }
        },
      },
      state.selecting ? el('span', { class: 'check-box' }) : null,
      el('div', { class: 'main' },
        el('div', { class: 'title' }, share.noteTitle(n), badge),
        el('div', { class: 'meta' }, share.formatDate(n.createdAt), n.audioSamples ? ' · ' + fmtTime(n.audioSamples / SAMPLE_RATE) : ''),
        snippet ? el('div', { class: 'snippet' }, snippet) : null,
      ));
      return item;
    }),
  );
  $('#empty').hidden = state.notes.length > 0;
  if (state.notes.length > 0 && notes.length === 0) {
    list.append(el('p', { class: 'empty' }, 'No notes match the search.'));
  }
  $('#select-toggle').textContent = state.selecting ? 'Done' : 'Select';
  $('#dock-record').hidden = state.selecting;
  $('#dock-select').hidden = !state.selecting;
  $('#select-count').textContent = `${state.selected.size} selected`;
  for (const b of $$('[data-multi]')) b.disabled = state.selected.size === 0;
}

async function renderDraftBanner() {
  const banner = $('#draft-banner');
  const draft = await db.getDraft();
  const parts = [];
  if (draft) {
    parts.push(
      el('div', {}, el('strong', {}, 'Unfinished recording'), ` (${fmtTime(draft.samples / SAMPLE_RATE)}${draft.title ? ', ' + draft.title : ''}). It is saved; continue or finish it.`),
      el('div', { class: 'btn-row' }, el('button', { class: 'wide-btn primary', type: 'button', onclick: () => go('#/record') }, 'Open recording')),
    );
  } else {
    // Nudge to download the model on Wi-Fi before the first real use.
    try {
      const model = await engine.getModel(state.settings.model);
      if (!model) {
        parts.push(el('div', {}, el('strong', {}, 'No speech model yet.'), ' This test version can record and save notes; speech recognition arrives with the next update.'));
      } else if (!(await engine.isCached(model))) {
        parts.push(
          el('div', {}, el('strong', {}, 'Speech model not on this phone yet'), ` (${fmtBytes(await engine.modelBytes(model))}). Download it once, preferably on Wi-Fi; after that everything works offline.`),
          el('div', { class: 'btn-row' }, el('button', { class: 'wide-btn primary', type: 'button', onclick: () => go('#/settings') }, 'Download in Settings')),
        );
      }
    } catch {
      // models.json missing (offline before first visit cached it): say nothing here.
    }
  }
  banner.replaceChildren(...parts);
  banner.hidden = parts.length === 0;
}

function selectedNotes() {
  return state.notes.filter((n) => state.selected.has(n.id));
}

// ---------- sharing (list and note) ----------

async function doShare(kind, notes) {
  try {
    if (kind === 'copy') {
      await share.copy(notes);
      toast(notes.length > 1 ? `${notes.length} notes copied` : 'Copied');
    } else if (kind === 'email') {
      const how = await share.email(notes, state.settings.email);
      if (how === 'copied') toast('Too long for an email link: the note is copied. Paste it into the message.', 6000);
    } else if (kind === 'share') {
      if (!(await share.share(notes))) {
        await share.copy(notes);
        toast('Sharing is not available here; copied instead');
      }
    } else if (kind === 'file') {
      await share.saveTextFile(notes);
    }
  } catch (err) {
    console.error(err);
    toast('Could not ' + kind + ': ' + err.message, 5000);
  }
}

// ---------- recording ----------

let recordNoteId = null;

async function showRecord(noteId) {
  $('#view-record').hidden = false;
  const draft = recorder.draft || (await db.getDraft());
  if (draft && recorder.state === 'idle') await recorder.adopt(draft);
  // An existing draft decides what we are recording into.
  recordNoteId = draft ? draft.noteId : noteId;
  const target = recordNoteId ? await db.getNote(recordNoteId) : null;

  $('#record-heading').textContent = target ? 'Add to note' : 'New note';
  $('#record-title-field').hidden = !!target;
  $('#record-append').hidden = !target;
  if (target) $('#record-append').textContent = `Adding to “${share.noteTitle(target)}”. The new text goes at the end.`;
  $('#record-title').value = draft?.title || '';
  setLangButtons('#record-lang', draft?.language || state.settings.language);
  renderRecorder();
}

function setLangButtons(sel, lang) {
  for (const b of $$(sel + ' button')) b.setAttribute('aria-checked', String(b.dataset.lang === lang));
}

function recordLanguage() {
  return $('#record-lang button[aria-checked="true"]')?.dataset.lang || state.settings.language;
}

function renderRecorder(message) {
  const s = recorder.state;
  const btn = $('#btn-record');
  const secs = recorder.seconds;
  btn.classList.toggle('recording', s === 'recording');
  btn.setAttribute('aria-label', s === 'recording' ? 'Pause' : s === 'paused' ? 'Continue' : 'Start recording');
  btn.disabled = s === 'paused' && secs >= MAX_SECONDS;
  $('#btn-stop').hidden = s === 'idle';
  $('#timer').textContent = fmtTime(secs);
  const left = MAX_SECONDS - secs;
  $('#limit').textContent = s === 'recording' && left <= 30 ? `${Math.ceil(left)} s left` : `up to ${fmtTime(MAX_SECONDS)}`;
  if (message) $('#record-status').textContent = message;
  else if (s === 'recording') $('#record-status').textContent = 'Recording · tap to pause';
  else if (s === 'paused') $('#record-status').textContent = secs >= MAX_SECONDS ? 'Time limit reached · tap Stop to finish' : 'Paused · tap to continue, or Stop to finish';
  else $('#record-status').textContent = 'Tap to start';
}

recorder.addEventListener('state', () => renderRecorder());
recorder.addEventListener('time', () => {
  if (!$('#view-record').hidden) {
    $('#timer').textContent = fmtTime(recorder.seconds);
    const left = MAX_SECONDS - recorder.seconds;
    if (left <= 30 && recorder.state === 'recording') $('#limit').textContent = `${Math.ceil(left)} s left`;
  }
});
recorder.addEventListener('level', (e) => {
  // Map RMS to a readable bar: speech sits around 0.02-0.2.
  const v = e.detail <= 0 ? 0 : Math.min(1, Math.max(0, (Math.log10(e.detail) + 3) / 2.5));
  $('#meter').style.width = (v * 100).toFixed(0) + '%';
});
recorder.addEventListener('paused', (e) => {
  const why = {
    background: 'Paused because the app went to the background. What you recorded is saved; tap to continue.',
    interrupted: 'Paused by an interruption (call or another app). What you recorded is saved; tap to continue.',
    limit: 'Time limit reached. Tap Stop to finish the note.',
  }[e.detail];
  renderRecorder(why);
});

async function onRecordButton() {
  try {
    if (recorder.state === 'idle') {
      await recorder.start({
        noteId: recordNoteId,
        title: $('#record-title').value.trim(),
        language: recordLanguage(),
      });
      requestPersistence();
    } else if (recorder.state === 'recording') {
      await recorder.pause();
    } else if (recorder.state === 'paused') {
      await recorder.continue();
    }
  } catch (err) {
    if (err instanceof MicError) showMicHelp(err.kind);
    else {
      console.error(err);
      toast('Recording failed: ' + err.message, 5000);
    }
    renderRecorder();
  }
}

async function onStop() {
  const draft = await recorder.stop();
  if (!draft) return;
  draft.title = $('#record-title').value.trim() || draft.title;
  draft.language = recordLanguage();
  if (draft.samples === 0) {
    await db.deleteDraft(draft.id);
    toast('Nothing was recorded');
    go(draft.noteId ? '#/note/' + encodeURIComponent(draft.noteId) : '#/');
    return;
  }
  const note = await db.commitDraft(draft);
  // The draft's language applies to this recording's transcription.
  queueTranscription(note.id, { language: draft.language });
  history.replaceState(null, '', '#/');
  go('#/note/' + encodeURIComponent(note.id));
}

async function onRecordCancel() {
  if (recorder.state === 'idle') return go(recordNoteId ? '#/note/' + encodeURIComponent(recordNoteId) : '#/');
  if (recorder.state === 'recording') await recorder.pause();
  const ok = await confirmSheet('Discard this recording?', `${fmtTime(recorder.seconds)} of audio will be deleted.`, 'Discard recording', true);
  if (!ok) return;
  const back = recordNoteId;
  await recorder.discard();
  go(back ? '#/note/' + encodeURIComponent(back) : '#/');
}

// Keep the draft's title/language current so a reload restores them.
async function saveDraftMeta() {
  if (!recorder.draft) return;
  recorder.draft.title = $('#record-title').value.trim();
  recorder.draft.language = recordLanguage();
  await db.saveDraft(recorder.draft);
}

// ---------- transcription ----------

function queueTranscription(noteId, { replace = false, language = null } = {}) {
  if (state.jobs.has(noteId)) return;
  state.jobs.set(noteId, { stage: 'waiting', fraction: 0 });
  renderJob(noteId);
  state.queue = state.queue.then(() => runTranscription(noteId, { replace, language }));
}

async function runTranscription(noteId, { replace, language }) {
  try {
    let note = await db.getNote(noteId);
    const pcm = note && (await db.getAudio(noteId));
    if (!note || !pcm) return;
    const from = replace ? 0 : note.pendingFrom ?? pcm.length;
    const audio = int16ToFloat32(pcm.subarray(from));
    const lang = language || note.language || state.settings.language;
    // Marker: if Safari kills the page mid-way (usually out of memory), the
    // next start sees it and doesn't retry in a crash loop.
    note.transcribing = true;
    await db.saveNote(note);

    const result = audio.length < SAMPLE_RATE * 0.3
      ? { text: '', language: lang }
      : await engine.transcribe(audio, {
        modelId: state.settings.model,
        language: lang,
        onProgress: (p) => {
          state.jobs.set(noteId, p);
          renderJob(noteId);
        },
      });

    // Re-read: the user may have edited the note while we worked.
    await flushNoteEdits();
    note = await db.getNote(noteId);
    if (!note) return;
    if (replace) {
      note.text = result.text;
    } else if (result.text) {
      const before = (note.text || '').trimEnd();
      note.text = before ? before + '\n\n' + result.text : result.text;
    }
    note.language = note.language === 'auto' || !note.language ? result.language : note.language;
    note.pendingFrom = null;
    note.error = null;
    note.transcribing = false;
    await db.saveNote(note);
    state.jobs.delete(noteId);
    if (!result.text) toast('No speech was recognised in the recording.');
  } catch (err) {
    console.error(err);
    state.jobs.delete(noteId);
    const note = await db.getNote(noteId);
    if (note) {
      note.error = err.message || String(err);
      note.transcribing = false;
      await db.saveNote(note);
    }
  }
  renderJob(noteId, true);
}

function renderJob(noteId, finished = false) {
  if (!$('#view-list').hidden) {
    if (finished) db.listNotes().then((n) => { state.notes = n; renderList(); });
    else renderList();
  }
  if (state.noteId !== noteId || $('#view-note').hidden) return;
  const job = state.jobs.get(noteId);
  const box = $('#note-progress');
  if (!job) {
    box.hidden = true;
    if (finished) refreshNote();
    return;
  }
  box.hidden = false;
  const pct = Math.round((job.fraction || 0) * 100);
  const label = {
    waiting: 'Waiting to transcribe…',
    download: `Downloading the speech model (first time only)… ${pct}%`,
    load: `Loading the speech model… ${pct}%`,
    transcribe: `Transcribing on this phone… ${pct}%`,
  }[job.stage] || 'Working…';
  $('#note-progress-label').textContent = label;
  $('#note-progress-fill').style.width = pct + '%';
}

// ---------- note view ----------

let noteSaveTimer = null;
let audioUrl = null;

async function showNote(id) {
  const note = await db.getNote(id);
  if (!note) {
    toast('Note not found');
    return go('#/');
  }
  state.noteId = id;
  state.note = note;
  $('#view-note').hidden = false;
  $('#note-title').value = note.title || '';
  $('#note-text').value = note.text || '';
  renderNoteMeta(note);
  renderJob(id);
  await renderNoteAudio(note);
}

async function refreshNote() {
  const note = await db.getNote(state.noteId);
  if (!note) return;
  state.note = note;
  // Don't clobber what the user is typing.
  if (document.activeElement !== $('#note-text')) $('#note-text').value = note.text || '';
  renderNoteMeta(note);
  await renderNoteAudio(note);
}

function renderNoteMeta(note) {
  const parts = [share.formatDate(note.createdAt)];
  if (note.audioSamples) parts.push(fmtTime(note.audioSamples / SAMPLE_RATE));
  if (note.language && note.language !== 'auto') parts.push(LANG_LABEL[note.language]);
  if (!note.audioSamples) parts.push('text only');
  $('#note-meta').textContent = parts.join(' · ');

  const errBox = $('#note-error');
  const job = state.jobs.get(note.id);
  if (note.error && !job) {
    errBox.replaceChildren(
      el('div', {}, 'Transcription failed: ' + note.error),
      el('div', { class: 'btn-row' }, el('button', { class: 'wide-btn', type: 'button', onclick: () => queueTranscription(note.id) }, 'Try again')),
    );
    errBox.hidden = false;
  } else if (note.pendingFrom != null && !job) {
    errBox.replaceChildren(
      el('div', {}, 'Part of the audio has not been transcribed yet.'),
      el('div', { class: 'btn-row' }, el('button', { class: 'wide-btn', type: 'button', onclick: () => queueTranscription(note.id) }, 'Transcribe now')),
    );
    errBox.hidden = false;
  } else {
    errBox.hidden = true;
  }
}

async function renderNoteAudio(note) {
  const player = $('#note-player');
  if (audioUrl) {
    URL.revokeObjectURL(audioUrl);
    audioUrl = null;
  }
  const pcm = note.audioSamples ? await db.getAudio(note.id) : null;
  if (!pcm || pcm.length === 0) {
    player.removeAttribute('src');
    $('#note-audio').hidden = true;
    return;
  }
  audioUrl = URL.createObjectURL(pcmToWav(pcm));
  player.src = audioUrl;
  $('#note-audio').hidden = false;
}

function scheduleNoteSave() {
  clearTimeout(noteSaveTimer);
  noteSaveTimer = setTimeout(flushNoteEdits, 400);
}

async function flushNoteEdits() {
  clearTimeout(noteSaveTimer);
  noteSaveTimer = null;
  const id = state.noteId;
  if (!id || $('#view-note').hidden) return;
  const note = await db.getNote(id);
  if (!note) return;
  const title = $('#note-title').value;
  const text = $('#note-text').value;
  if (note.title === title && note.text === text) return;
  note.title = title;
  note.text = text;
  await db.saveNote(note);
}

async function currentNote() {
  await flushNoteEdits();
  return db.getNote(state.noteId);
}

async function onNoteMore() {
  const note = await currentNote();
  const hasAudio = note.audioSamples > 0;
  const busy = state.jobs.has(note.id);
  const choice = await openSheet((sheet, close) => {
    sheet.append(
      el('h3', {}, share.noteTitle(note)),
      el('div', { class: 'btn-row' },
        hasAudio ? el('button', { class: 'wide-btn', type: 'button', disabled: busy, onclick: () => close('retranscribe') }, 'Transcribe again (replaces text)') : null,
        hasAudio ? el('button', { class: 'wide-btn', type: 'button', onclick: () => close('audiofile') }, 'Save audio as file') : null,
        hasAudio ? el('button', { class: 'wide-btn danger', type: 'button', disabled: busy, onclick: () => close('deleteaudio') }, 'Delete audio, keep text') : null,
        el('button', { class: 'wide-btn danger', type: 'button', disabled: busy, onclick: () => close('delete') }, 'Delete note'),
        el('button', { class: 'wide-btn', type: 'button', onclick: () => close(null) }, 'Cancel'),
      ),
    );
  });
  if (choice === 'retranscribe') {
    const lang = await openSheet((sheet, close) => {
      sheet.append(
        el('h3', {}, 'Transcribe again'),
        el('p', { class: 'muted' }, 'The whole recording is transcribed again with the model chosen in Settings. The new text replaces the current text, including your edits.'),
        el('div', { class: 'btn-row' },
          ...['fi', 'en', 'auto'].map((l) => el('button', { class: 'wide-btn', type: 'button', onclick: () => close(l) }, LANG_LABEL[l])),
          el('button', { class: 'wide-btn', type: 'button', onclick: () => close(null) }, 'Cancel'),
        ),
      );
    });
    if (lang) {
      note.language = lang;
      await db.saveNote(note);
      queueTranscription(note.id, { replace: true, language: lang });
    }
  } else if (choice === 'audiofile') {
    const pcm = await db.getAudio(note.id);
    await share.shareFile(pcmToWav(pcm), share.noteTitle(note).replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80) + '.wav');
  } else if (choice === 'deleteaudio') {
    const extra = note.pendingFrom != null ? ' Part of it has not been transcribed yet; that part will be lost.' : '';
    if (await confirmSheet('Delete the audio?', 'The text stays. You can no longer play or re-transcribe this note.' + extra, 'Delete audio', true)) {
      await db.deleteAudio(note.id);
      await refreshNote();
      toast('Audio deleted');
    }
  } else if (choice === 'delete') {
    if (await confirmSheet('Delete this note?', 'The text and audio are deleted from this phone.', 'Delete note', true)) {
      await db.deleteNote(note.id);
      state.noteId = null;
      toast('Note deleted');
      go('#/');
    }
  }
}

// ---------- settings ----------

let downloadAbort = null;

async function showSettings() {
  $('#view-settings').hidden = false;
  setLangButtons('#settings-lang', state.settings.language);
  $('#settings-email').value = state.settings.email;
  $('#backup-audio').checked = state.settings.backupAudio;
  $('#settings-gpu').checked = state.settings.device !== 'wasm';
  $('#settings-gpu').disabled = !navigator.gpu;
  $('#version-info').textContent = `Version ${APP_VERSION}`;
  renderStorage();
  const dev = await engine.pickDevice();
  $('#device-info').textContent = dev === 'webgpu'
    ? 'This phone runs the model on its graphics chip (WebGPU).'
    : 'This phone runs the model on its processor (WebAssembly).';
  await renderModels();
}

async function renderModels(progress = null) {
  const box = $('#model-list');
  let models;
  try {
    models = await engine.models();
  } catch {
    box.replaceChildren(el('p', { class: 'muted' }, 'Model list unavailable. Connect to the internet once and reopen Settings.'));
    return;
  }
  if (models.length === 0) {
    box.replaceChildren(el('p', { class: 'muted' }, 'No speech model is installed in this version yet.'));
    return;
  }
  const active = (await engine.getModel(state.settings.model)).id;
  const cards = [];
  for (const m of models) {
    const have = await engine.cachedBytes(m);
    const bytes = await engine.modelBytes(m);
    const cached = have === bytes;
    const isActive = m.id === active;
    const p = progress?.id === m.id ? progress : null;
    cards.push(el('div', { class: 'model-card' + (isActive ? ' active' : '') },
      el('div', { class: 'head' }, el('span', { class: 'name' }, `${m.label}: ${m.name}`), el('span', { class: 'size' }, fmtBytes(bytes))),
      el('p', {}, m.description),
      el('div', { class: 'actions' },
        isActive ? null : el('button', { type: 'button', onclick: () => chooseModel(m.id) }, 'Use this'),
        cached || p ? null : el('button', { type: 'button', class: isActive ? 'primary' : '', onclick: () => downloadModel(m) }, have ? 'Finish download' : 'Download'),
        p ? el('button', { type: 'button', onclick: () => downloadAbort?.abort() }, 'Stop') : null,
        cached && !p ? el('button', { type: 'button', onclick: () => removeModel(m) }, 'Remove from phone') : null,
      ),
      el('div', { class: 'status ' + (cached ? '' : 'muted') },
        p ? `Downloading… ${Math.round((p.loaded / p.total) * 100)}% (${fmtBytes(p.loaded)} of ${fmtBytes(p.total)})`
          : cached ? (isActive ? '✓ On this phone · in use' : '✓ On this phone')
            : have ? `Partly downloaded (${fmtBytes(have)})` : 'Not downloaded',
      ),
      p ? el('div', { class: 'progress' }, Object.assign(el('div', { class: 'progress-fill' }), {})) : null,
    ));
    if (p) cards.at(-1).querySelector('.progress-fill').style.width = ((p.loaded / p.total) * 100).toFixed(1) + '%';
  }
  box.replaceChildren(...cards);
}

async function chooseModel(id) {
  state.settings.model = id;
  await db.setSetting('model', id);
  renderModels();
}

async function downloadModel(m) {
  downloadAbort?.abort();
  downloadAbort = new AbortController();
  requestPersistence();
  let last = 0;
  try {
    await engine.prepare(m.id, (p) => {
      const now = Date.now();
      if (now - last > 250 || p.loaded === p.total) {
        last = now;
        renderModels({ id: m.id, ...p });
      }
    }, downloadAbort.signal);
    toast('Speech model downloaded. It now works offline.');
  } catch (err) {
    if (err.name !== 'AbortError') toast('Download failed: ' + err.message, 5000);
  }
  downloadAbort = null;
  renderModels();
  renderStorage();
}

async function removeModel(m) {
  if (!(await confirmSheet('Remove this model from the phone?', 'Your notes are not affected. The model is downloaded again when needed.', 'Remove', true))) return;
  await engine.remove(m.id);
  renderModels();
  renderStorage();
}

async function renderStorage() {
  const info = $('#storage-info');
  const lines = [];
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) lines.push(`Using ${fmtBytes(est.usage || 0)} of the space the browser allows (${fmtBytes(est.quota || 0)}).`);
    const persisted = await navigator.storage?.persisted?.();
    lines.push(persisted
      ? 'Storage is marked as persistent: iOS will not clear it to save space.'
      : 'Storage is not yet marked as persistent. Add the app to your Home Screen and use it from there so iOS keeps your notes.');
  } catch {
    lines.push('Storage information unavailable.');
  }
  info.textContent = lines.join(' ');
}

async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    // Not supported: nothing more we can do from a web page.
  }
}

// ---------- backup ----------

async function onExport() {
  try {
    const { blob, name, count } = await backup.exportBackup($('#backup-audio').checked);
    await share.shareFile(blob, name);
    toast(`Backup of ${count} notes created`);
  } catch (err) {
    console.error(err);
    toast('Export failed: ' + err.message, 5000);
  }
}

async function onImportFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const r = await backup.importBackup(file);
    toast(`Imported: ${r.added} new, ${r.updated} updated, ${r.skipped} unchanged`, 5000);
    state.notes = await db.listNotes();
  } catch (err) {
    console.error(err);
    toast('Import failed: ' + err.message, 6000);
  }
}

// ---------- wiring ----------

function wire() {
  window.addEventListener('hashchange', route);
  $('#sheet-backdrop').addEventListener('click', () => closeSheet());

  // list
  $('#search').addEventListener('input', renderList);
  $('#new-note').addEventListener('click', () => go('#/record'));
  $('#open-settings').addEventListener('click', () => go('#/settings'));
  $('#select-toggle').addEventListener('click', () => {
    state.selecting = !state.selecting;
    state.selected.clear();
    renderList();
  });
  for (const b of $$('[data-multi]')) {
    b.addEventListener('click', () => doShare(b.dataset.multi, selectedNotes()));
  }

  // record
  $('#btn-record').addEventListener('click', onRecordButton);
  $('#btn-stop').addEventListener('click', onStop);
  $('#record-cancel').addEventListener('click', onRecordCancel);
  $('#record-title').addEventListener('change', saveDraftMeta);
  for (const b of $$('#record-lang button')) {
    b.addEventListener('click', () => {
      setLangButtons('#record-lang', b.dataset.lang);
      saveDraftMeta();
    });
  }

  // note
  $('#note-back').addEventListener('click', async () => {
    await flushNoteEdits();
    go('#/');
  });
  $('#note-title').addEventListener('input', scheduleNoteSave);
  $('#note-text').addEventListener('input', scheduleNoteSave);
  $('#note-text').addEventListener('blur', flushNoteEdits);
  $('#note-more').addEventListener('click', onNoteMore);
  $('#note-add').addEventListener('click', async () => {
    await flushNoteEdits();
    if (await db.getDraft()) {
      toast('Finish the unfinished recording first');
      return go('#/record');
    }
    go('#/record/' + encodeURIComponent(state.noteId));
  });
  for (const b of $$('[data-share]')) {
    b.addEventListener('click', () => {
      // Build from the fields on screen, synchronously: iOS only allows
      // clipboard and share in the tap itself, not after waiting on storage.
      const note = state.note || { createdAt: Date.now() };
      const live = { ...note, title: $('#note-title').value, text: $('#note-text').value };
      flushNoteEdits();
      doShare(b.dataset.share, [live]);
    });
  }

  // settings
  $('#settings-back').addEventListener('click', () => go('#/'));
  for (const b of $$('#settings-lang button')) {
    b.addEventListener('click', async () => {
      state.settings.language = b.dataset.lang;
      setLangButtons('#settings-lang', b.dataset.lang);
      await db.setSetting('language', b.dataset.lang);
    });
  }
  $('#settings-email').addEventListener('change', async (e) => {
    state.settings.email = e.target.value.trim();
    await db.setSetting('email', state.settings.email);
  });
  $('#settings-gpu').addEventListener('change', async (e) => {
    state.settings.device = e.target.checked ? 'auto' : 'wasm';
    await db.setSetting('device', state.settings.device);
    engine.setDevicePreference(state.settings.device);
    showSettings();
  });
  $('#backup-audio').addEventListener('change', async (e) => {
    state.settings.backupAudio = e.target.checked;
    await db.setSetting('backupAudio', e.target.checked);
  });
  $('#backup-export').addEventListener('click', onExport);
  $('#backup-import').addEventListener('click', () => $('#backup-file').click());
  $('#backup-file').addEventListener('change', onImportFile);

  // Save edits before iOS suspends or closes the app.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNoteEdits();
  });
}

async function resumeUnfinishedJobs() {
  let modelReady = false;
  try {
    const model = await engine.getModel(state.settings.model);
    modelReady = !!model && (await engine.isCached(model));
  } catch {
    // No model list: nothing can be transcribed now anyway.
  }
  for (const n of await db.listNotes()) {
    if (n.transcribing) {
      // The app stopped in the middle of this one. Don't retry on our own:
      // if it ran out of memory, it would just happen again.
      n.transcribing = false;
      n.error = 'The app closed during transcription, possibly because the phone ran out of memory. Try again, or choose the Fast model in Settings.';
      await db.saveNote(n);
    } else if (n.pendingFrom != null && !n.error && n.audioSamples > 0 && modelReady) {
      // Waiting from an earlier session (e.g. app closed before it started).
      // Only when the model is already here: never start a big download unasked.
      queueTranscription(n.id);
    }
  }
}

async function main() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker failed', err));
  }
  state.settings = await db.getSettings();
  engine.setDevicePreference(state.settings.device);
  wire();
  await route();
  resumeUnfinishedJobs();
}

main().catch((err) => {
  console.error(err);
  document.body.prepend(el('div', { class: 'banner warn' }, 'The app failed to start: ' + err.message));
});
