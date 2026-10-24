export {};

interface Cue {
  id: string;
  start: number;
  end: number;
  text: string;
  speaker: string;
  warnings: string[];
}
interface ReviewSession {
  version: 1;
  title: string;
  description: string;
  duration: number;
  subtitleSha256: string;
  video: string;
  srt: string;
  vtt: string;
  language?: string;
  subtitleLabel?: string;
  alternateReview?: { session: string; label: string };
  cues: Cue[];
}
interface CueNote {
  text: string;
  flagged: boolean;
}
interface SavedReview {
  version: 1;
  subtitleSha256: string;
  position: number;
  notes: Record<string, CueNote>;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
};
const video = $<HTMLVideoElement>('film');
const track = $<HTMLTrackElement>('subtitles');
const list = $('cueList');
const search = $<HTMLInputElement>('search');
const filter = $<HTMLSelectElement>('filter');
const note = $<HTMLTextAreaElement>('cueNote');
const needsFix = $<HTMLInputElement>('needsFix');
const loop = $<HTMLInputElement>('loopCue');
const warningNames: Record<string, string> = {
  reading_speed: 'Fast reading',
  short_duration: 'Short cue',
  long_duration: 'Long cue',
  duration_exceeds_limit: 'Long cue',
  line_length: 'Long line',
  zero_duration_word: 'Zero-duration word',
  estimated_zero_duration_cue: 'Timing repair',
  unusually_long_word: 'Long word timing',
};
let session: ReviewSession;
let saved: SavedReview;
let storageKey = '';
let selected = 0;
let active = -1;
let lastPersisted = -1;
let storageFailed = false;
const rows = new Map<number, HTMLButtonElement>();

function labelTime(seconds: number, milliseconds = false): string {
  const total = Math.max(0, Math.round(seconds * 1000));
  const hour = Math.floor(total / 3600000);
  const minute = Math.floor((total % 3600000) / 60000);
  const second = Math.floor((total % 60000) / 1000);
  return `${hour ? `${hour.toString().padStart(2, '0')}:` : ''}${minute.toString().padStart(2, '0')}:${second.toString().padStart(2, '0')}${milliseconds ? `.${(total % 1000).toString().padStart(3, '0')}` : ''}`;
}
function status(message: string, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}
function make<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}
function persist() {
  if (!saved) return;
  saved.position = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  try {
    localStorage.setItem(storageKey, JSON.stringify(saved));
    storageFailed = false;
  } catch {
    storageFailed = true;
  }
  $('saveStatus').textContent = storageFailed
    ? 'Browser storage is unavailable. Export your notes before closing this page.'
    : 'Saved in this browser. Export notes to share or keep a separate copy.';
}
function cueAt(time: number): number {
  // Binary search by start time, then check the end. Gaps do not get captions.
  let lo = 0,
    hi = session.cues.length - 1,
    candidate = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (session.cues[mid].start <= time) {
      candidate = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (candidate < 0) return -1;
  for (let i = candidate; i >= 0; i--) {
    if (session.cues[i].end > time) return i;
    if (session.cues[i].start < time - 60) break;
  }
  return -1;
}
function isNoted(cue: Cue): boolean {
  const item = saved.notes[cue.id];
  return Boolean(item?.flagged || item?.text.trim());
}
function tags(cue: Cue) {
  const box = make('span', '', 'cue-tags');
  if (cue.warnings.length) box.append(make('span', `${cue.warnings.length} checks`));
  if (isNoted(cue))
    box.append(make('span', saved.notes[cue.id].flagged ? 'Needs correction' : 'Note', 'noted'));
  return box;
}
function renderList() {
  const query = search.value.trim().toLocaleLowerCase('tr');
  const fragment = document.createDocumentFragment();
  rows.clear();
  session.cues.forEach((cue, index) => {
    if (
      query &&
      !cue.text.toLocaleLowerCase('tr').includes(query) &&
      cue.id !== query.replace(/^#/, '')
    )
      return;
    if (filter.value === 'warnings' && !cue.warnings.length) return;
    if (filter.value === 'notes' && !isNoted(cue)) return;
    const row = make('button', '', 'cue-row');
    row.type = 'button';
    row.dataset.cueId = cue.id;
    row.setAttribute(
      'aria-label',
      `Cue ${cue.id}, ${labelTime(cue.start)}, ${cue.text.replace(/\n/g, ' ')}`,
    );
    const meta = make('span', '', 'cue-meta');
    meta.append(
      make('span', `#${cue.id}`),
      make('span', labelTime(cue.start, true)),
      make('span', cue.speaker.replace('speaker_', 'Voice '), 'speaker'),
    );
    row.append(meta, make('span', cue.text, 'cue-text'), tags(cue));
    row.addEventListener('click', () => selectCue(index, true));
    row.classList.toggle('active', index === active);
    row.classList.toggle('selected', index === selected);
    if (index === active) row.setAttribute('aria-current', 'true');
    const wrapper = make('div', '');
    wrapper.setAttribute('role', 'listitem');
    wrapper.append(row);
    fragment.append(wrapper);
    rows.set(index, row);
  });
  if (!rows.size) fragment.append(make('p', 'No cues match this view.', 'empty-state'));
  list.replaceChildren(fragment);
  updateSummary();
}
function updateSummary() {
  const count = session.cues.filter(isNoted).length;
  $('listSummary').textContent =
    `${rows.size} of ${session.cues.length} cues · ${count} with your notes or flags`;
  $<HTMLButtonElement>('exportNotes').disabled = false;
}
function selectCue(index: number, seek = false) {
  rows.get(selected)?.classList.remove('selected');
  selected = Math.max(0, Math.min(session.cues.length - 1, index));
  const cue = session.cues[selected];
  rows.get(selected)?.classList.add('selected');
  $('selectedTitle').textContent = `Cue ${cue.id}`;
  $('selectedMeta').textContent =
    `${labelTime(cue.start, true)} → ${labelTime(cue.end, true)} · ${(cue.end - cue.start).toFixed(3)}s · ${cue.speaker.replace('speaker_', 'Voice ')}`;
  $('selectedText').textContent = cue.text;
  $('selectedFlags').replaceChildren(
    ...[...new Set(cue.warnings.map((code) => warningNames[code] ?? code))].map((text) =>
      make('span', text),
    ),
  );
  note.value = saved.notes[cue.id]?.text ?? '';
  needsFix.checked = saved.notes[cue.id]?.flagged ?? false;
  $<HTMLButtonElement>('previousCue').disabled = selected === 0;
  $<HTMLButtonElement>('nextCue').disabled = selected === session.cues.length - 1;
  if (seek) seekTo(Math.max(0, cue.start - 1));
}
function seekTo(time: number) {
  const limit = Math.min(
    session.duration,
    Number.isFinite(video.duration) ? video.duration : session.duration,
  );
  video.currentTime = Math.max(0, Math.min(limit - 0.02, time));
}
async function play() {
  try {
    await video.play();
  } catch {
    status('Playback could not start. Try the video’s Play button or reload the page.', true);
  }
}
function replay() {
  seekTo(session.cues[selected].start - 1);
  void play();
}
function saveNote() {
  const cue = session.cues[selected];
  if (!note.value.trim() && !needsFix.checked) delete saved.notes[cue.id];
  else saved.notes[cue.id] = { text: note.value, flagged: needsFix.checked };
  persist();
  const row = rows.get(selected);
  row?.querySelector('.cue-tags')?.replaceWith(tags(cue));
  if (filter.value === 'notes') renderList();
  else updateSummary();
}
function markCurrent() {
  video.pause();
  const current = cueAt(video.currentTime);
  if (current < 0) {
    status('No subtitle is active at this moment. Select a cue in Dialogue to leave a note.');
    return;
  }
  selectCue(current);
  needsFix.checked = true;
  saveNote();
  note.focus();
}
function tick() {
  if (!session) return;
  $('clock').textContent = `${labelTime(video.currentTime)} / ${labelTime(session.duration)}`;
  if (loop.checked && !video.paused) {
    const cue = session.cues[selected];
    if (video.currentTime >= Math.min(session.duration, cue.end + 0.75)) {
      seekTo(cue.start - 1);
      return;
    }
  }
  const next = cueAt(video.currentTime);
  if (next !== active) {
    const previous = rows.get(active);
    previous?.classList.remove('active');
    previous?.removeAttribute('aria-current');
    active = next;
    const row = rows.get(active);
    row?.classList.add('active');
    row?.setAttribute('aria-current', 'true');
    if (row && $<HTMLInputElement>('followPlayback').checked) {
      const bounds = row.getBoundingClientRect(),
        viewport = list.getBoundingClientRect();
      if (bounds.top < viewport.top || bounds.bottom > viewport.bottom)
        list.scrollTop += bounds.top - viewport.top - list.clientHeight / 3;
    }
  }
  const bucket = Math.floor(video.currentTime / 5);
  if (bucket !== lastPersisted) {
    lastPersisted = bucket;
    persist();
  }
}
function exportNotes() {
  const lines = [
    `# ${session.title} — review notes`,
    '',
    `Exported: ${new Date().toISOString()}`,
    `Source SRT SHA-256: ${session.subtitleSha256}`,
    '',
    'Original subtitle text and timestamps are unchanged. Speaker IDs are tentative.',
    '',
  ];
  for (const cue of session.cues.filter(isNoted)) {
    const item = saved.notes[cue.id];
    lines.push(
      `## Cue ${cue.id} · ${labelTime(cue.start, true)} → ${labelTime(cue.end, true)}`,
      '',
      `Speaker: ${cue.speaker}. Needs correction: ${item.flagged ? 'yes' : 'not flagged'}.`,
      '',
      ...cue.text.split('\n').map((line) => `> ${line}`),
      '',
    );
    if (cue.warnings.length) lines.push(`Automatic checks: ${cue.warnings.join(', ')}.`, '');
    if (item.text.trim()) lines.push(item.text, '');
  }
  if (!session.cues.some(isNoted)) lines.push('No notes or manual flags yet.', '');
  const url = URL.createObjectURL(
    new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }),
  );
  const link = make('a', '');
  link.href = url;
  const slug =
    session.title
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'film';
  link.download = `${slug}-subtitle-review-notes-${session.language || 'tr'}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function safeFile(value: string, root: URL): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)) throw new Error('Invalid review asset filename');
  return new URL(value, root).href;
}
function readSaved(): SavedReview {
  const fallback: SavedReview = {
    version: 1,
    subtitleSha256: session.subtitleSha256,
    position: 0,
    notes: {},
  };
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (parsed?.version !== 1 || parsed.subtitleSha256 !== session.subtitleSha256) return fallback;
    if (
      Number.isFinite(parsed.position) &&
      parsed.position >= 0 &&
      parsed.position < session.duration
    )
      fallback.position = parsed.position;
    for (const cue of session.cues) {
      const entry = parsed.notes?.[cue.id];
      if (entry && typeof entry.text === 'string' && typeof entry.flagged === 'boolean')
        fallback.notes[cue.id] = { text: entry.text, flagged: entry.flagged };
    }
  } catch {
    /* A damaged or unavailable browser store must not prevent playback. */
  }
  return fallback;
}
async function initialize() {
  const parameters = new URLSearchParams(location.search);
  if (parameters.has('job')) {
    const { startEditor } = await import('./review-editor.js');
    return startEditor(parameters.get('job')!);
  }
  document.querySelector('#filter option[value="changed"]')?.remove();
  const id = parameters.get('session');
  if (!id) throw new Error('Open a film using Watch & correct in the studio.');
  if (!/^[a-z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid screening ID');
  const root = new URL(`./review-sessions/${id}/`, location.href);
  const response = await fetch(new URL('session.json', root));
  if (response.status === 401)
    throw new Error('Sign in through Back to studio, then return to this screening.');
  if (!response.ok) throw new Error('This screening has not been prepared.');
  session = await response.json();
  if (
    session.version !== 1 ||
    !Array.isArray(session.cues) ||
    !session.cues.length ||
    !/^[a-f0-9]{64}$/.test(session.subtitleSha256) ||
    !Number.isFinite(session.duration) ||
    session.duration <= 0
  )
    throw new Error('Invalid screening data');
  const language = session.language ?? 'tr';
  if (!/^[a-z]{2,3}$/.test(language)) throw new Error('Invalid subtitle language');
  const ids = new Set<string>();
  let previousStart = -1;
  for (const cue of session.cues) {
    if (
      !/^\d+$/.test(cue.id) ||
      ids.has(cue.id) ||
      !Number.isFinite(cue.start) ||
      !Number.isFinite(cue.end) ||
      cue.start < previousStart ||
      cue.end <= cue.start ||
      cue.end > session.duration + 0.1 ||
      typeof cue.text !== 'string' ||
      typeof cue.speaker !== 'string' ||
      !Array.isArray(cue.warnings)
    )
      throw new Error('Invalid subtitle cue data');
    ids.add(cue.id);
    previousStart = cue.start;
  }
  storageKey = `yesilcam-review-v1:${id}:${session.subtitleSha256}`;
  saved = readSaved();
  const requestedPosition = parameters.has('time') ? Number(parameters.get('time')) : NaN;
  const resumePosition =
    Number.isFinite(requestedPosition) &&
    requestedPosition >= 0 &&
    requestedPosition < session.duration
      ? requestedPosition
      : saved.position;
  $('filmTitle').textContent = session.title;
  $('filmDescription').textContent = session.description;
  document.title = `${session.title} · Subtitle review`;
  $('cueCount').textContent = `${session.cues.length} cues`;
  const download = $<HTMLAnchorElement>('downloadSrt');
  download.href = safeFile(session.srt, root);
  download.textContent = `Download SRT (${language})`;
  download.hidden = false;
  track.srclang = language;
  track.label = session.subtitleLabel || (language === 'tr' ? 'Turkish · Scribe v2' : language);
  $('selectedText').lang = language;
  if (session.alternateReview) {
    if (!/^[a-z0-9_-]{1,80}$/.test(session.alternateReview.session))
      throw new Error('Invalid alternate screening ID');
    const alternate = $<HTMLAnchorElement>('alternateReview');
    const destination = new URL('./review-player.html', location.href);
    destination.searchParams.set('session', session.alternateReview.session);
    alternate.href = destination.href;
    alternate.textContent = session.alternateReview.label;
    alternate.hidden = false;
    alternate.addEventListener('click', () => {
      persist();
      destination.searchParams.set('time', video.currentTime.toFixed(3));
      alternate.href = destination.href;
    });
  }
  video.addEventListener(
    'loadedmetadata',
    () => {
      if (resumePosition > 0) {
        seekTo(resumePosition);
        const current = cueAt(resumePosition);
        if (current >= 0) selectCue(current);
      }
      tick();
    },
    { once: true },
  );
  video.addEventListener('error', () =>
    status('The film could not be loaded. Check the local server and reload the page.', true),
  );
  track.addEventListener('load', () => {
    track.track.mode = $<HTMLInputElement>('showSubtitles').checked ? 'showing' : 'hidden';
    status(
      `${session.cues.length} subtitles loaded. Click a cue to jump, or press N while watching to note a flaw.`,
    );
  });
  track.addEventListener('error', () =>
    status(
      'The subtitle track could not be loaded. Download the original SRT or reload the page.',
      true,
    ),
  );
  track.src = safeFile(session.vtt, root);
  video.src = safeFile(session.video, root);
  track.track.mode = 'showing';
  renderList();
  selectCue(0);
  $('workspace').hidden = false;
  $('playPause').addEventListener('click', () => (video.paused ? void play() : video.pause()));
  video.addEventListener('play', () => {
    $('playPause').textContent = 'Pause';
  });
  video.addEventListener('pause', () => {
    $('playPause').textContent = 'Play';
    persist();
  });
  video.addEventListener('timeupdate', tick);
  video.addEventListener('seeked', tick);
  $('backFive').addEventListener('click', () => seekTo(video.currentTime - 5));
  $('forwardFive').addEventListener('click', () => seekTo(video.currentTime + 5));
  $('speed').addEventListener('change', () => {
    video.playbackRate = Number($<HTMLSelectElement>('speed').value);
  });
  $('showSubtitles').addEventListener('change', () => {
    track.track.mode = $<HTMLInputElement>('showSubtitles').checked ? 'showing' : 'hidden';
  });
  $('previousCue').addEventListener('click', () => selectCue(selected - 1, true));
  $('nextCue').addEventListener('click', () => selectCue(selected + 1, true));
  $('replayCue').addEventListener('click', replay);
  loop.addEventListener('change', () => {
    if (loop.checked) replay();
  });
  $('markCurrent').addEventListener('click', markCurrent);
  $('timeForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = $<HTMLInputElement>('jumpTime').value.trim();
    if (!/^(?:\d+:)?[0-5]?\d:[0-5]\d(?:\.\d{1,3})?$/.test(value)) {
      status('Use a time such as 29:14 or 00:29:14.256.', true);
      return;
    }
    const time = value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
    if (time >= session.duration) {
      status('That time is outside this screening.', true);
      return;
    }
    loop.checked = false;
    seekTo(time);
    const index = cueAt(time);
    if (index >= 0) selectCue(index);
    status(`Jumped to ${labelTime(time)}.`);
  });
  search.addEventListener('input', renderList);
  filter.addEventListener('change', renderList);
  note.addEventListener('input', saveNote);
  needsFix.addEventListener('change', saveNote);
  $('exportNotes').addEventListener('click', exportNotes);
  window.addEventListener('pagehide', persist);
  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      target.closest('input, textarea, select, [contenteditable]')
    )
      return;
    const key = event.key.toLowerCase();
    // Preserve native button/link/video activation; letter shortcuts still work after a click.
    if ((key === ' ' || key.startsWith('arrow')) && target.closest('button, a, video')) return;
    if (![' ', 'arrowleft', 'arrowright', '[', ']', 'r', 'n'].includes(key)) return;
    event.preventDefault();
    if (key === ' ') video.paused ? void play() : video.pause();
    else if (key === 'arrowleft') seekTo(video.currentTime - 5);
    else if (key === 'arrowright') seekTo(video.currentTime + 5);
    else if (key === '[') selectCue(selected - 1, true);
    else if (key === ']') selectCue(selected + 1, true);
    else if (key === 'r') replay();
    else markCurrent();
  });
  status('Film ready. Loading subtitle track…');
}
void initialize().catch((error) => status(error.message, true));
