interface Cue {
  id: string;
  start: number;
  end: number;
  texts: Record<string, string>;
  speaker: string;
  warnings: string[];
  note: string;
  flagged: boolean;
  omitted: boolean;
  changed?: boolean;
}
interface Screening {
  version: 2;
  id: string;
  title: string;
  revision: number;
  position: number;
  duration: number;
  languages: string[];
  sourceLanguage: string;
  targetLanguage: string;
  media: string | null;
  mediaMessage: string;
  cues: Cue[];
  original: Cue[];
}
type Edit = Partial<Pick<Cue, 'start' | 'end' | 'texts' | 'note' | 'flagged' | 'omitted'>> & {
  id: string;
};
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className = '') => {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = className;
  return element;
};
const input = (id: string) => $<HTMLInputElement>(id);
const area = (id: string) => $<HTMLTextAreaElement>(id);
function clock(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
function seconds(value: string) {
  const clean = value.trim().replace(',', '.');
  if (!/^(?:\d+:)?[0-5]?\d:[0-5]\d(?:\.\d{1,3})?$/.test(clean))
    throw new Error('Use a time such as 00:29:14.256.');
  return clean.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
}

export async function startEditor(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid job ID');
  const root = new URL('./', location.href);
  const api = new URL(`api/reviews/${id}`, root);
  const video = $<HTMLVideoElement>('film');
  const draftKey = `yesilcam-corrections-v2:${root.pathname}:${id}`;
  const pending = new Map<string, { edit: Edit; generation: number }>();
  const invalidTiming = new Map<string, { start: string; end: string }>();
  let generation = 0,
    selected = '',
    active = '',
    language = '',
    timer = 0;
  let document: Screening;
  let saving: Promise<boolean> | null = null;
  let blocked = false,
    commandBusy = false,
    storageFailed = false,
    loading = false;
  let positionAt = 0,
    localUrl = '';
  let captionTrack: TextTrack;
  const rows = new Map<string, HTMLButtonElement>();
  const status = (message: string, error = false) => {
    $('status').textContent = message;
    $('status').classList.toggle('error', error);
  };
  const saveStatus = (message: string, error = false) => {
    $('saveStatus').textContent = message;
    $('saveStatus').classList.toggle('error', error);
  };
  async function request(url: URL, body?: unknown, keepalive = false) {
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      keepalive,
      headers: {
        'X-Yesilcam-Request': '1',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401)
      throw Object.assign(
        new Error(
          'Session expired. Sign in through Back to studio; your unsaved edits stay in this browser.',
        ),
        { status: 401 },
      );
    const data = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(data.error || `Request failed (${response.status})`), {
        status: response.status,
      });
    return data;
  }
  function persistDraft() {
    try {
      if (pending.size || invalidTiming.size)
        localStorage.setItem(
          draftKey,
          JSON.stringify({
            revision: document.revision,
            edits: [...pending.values()].map((entry) => entry.edit),
            timings: [...invalidTiming],
          }),
        );
      else localStorage.removeItem(draftKey);
      storageFailed = false;
    } catch {
      storageFailed = true;
    }
  }
  const effective = (cue: Cue): Cue => {
    const edit = pending.get(cue.id)?.edit;
    return edit ? { ...cue, ...edit, texts: { ...cue.texts, ...edit.texts }, changed: true } : cue;
  };
  const cues = () =>
    document.cues.map(effective).sort((a, b) => a.start - b.start || Number(a.id) - Number(b.id));
  const current = () => effective(document.cues.find((cue) => cue.id === selected)!);
  function recovery(message: string, conflict = false) {
    $('draftRecovery').hidden = false;
    $('draftMessage').textContent = message;
    $('keepDraft').hidden = !conflict;
    $('retryEdits').hidden = conflict;
  }
  async function flush(): Promise<boolean> {
    clearTimeout(timer);
    if (saving) {
      if (!(await saving)) return false;
      return flush();
    }
    if (blocked) return false;
    if (invalidTiming.size) {
      saveStatus(
        `Timing for cue ${invalidTiming.keys().next().value} is unfinished. Correct it before downloading.`,
        true,
      );
      return false;
    }
    if (!pending.size) return true;
    const batch = [...pending.entries()];
    saving = (async () => {
      saveStatus('Saving corrections…');
      try {
        document = await request(api, {
          revision: document.revision,
          edits: batch.map(([, entry]) => entry.edit),
        });
        for (const [cueId, entry] of batch)
          if (pending.get(cueId)?.generation === entry.generation) pending.delete(cueId);
        persistDraft();
        $('draftRecovery').hidden = true;
        renderList();
        renderCaptions();
        if (!pending.size && !invalidTiming.size)
          saveStatus('Saved to the server. Downloads include your corrections.');
        return true;
      } catch (error) {
        blocked = error.status === 409;
        saveStatus(`Not saved: ${error.message}`, true);
        recovery(error.message, blocked);
        return false;
      } finally {
        saving = null;
      }
    })();
    const ok = await saving;
    return ok && pending.size ? flush() : ok;
  }
  function stage(edit: Edit) {
    if (loading || commandBusy) return;
    const previous = pending.get(edit.id)?.edit;
    pending.set(edit.id, {
      edit: {
        ...previous,
        ...edit,
        ...(edit.texts || previous?.texts ? { texts: { ...previous?.texts, ...edit.texts } } : {}),
      },
      generation: ++generation,
    });
    persistDraft();
    saveStatus(
      blocked
        ? 'Resolve the conflicting saved version before these edits can be saved.'
        : storageFailed
          ? 'Unsaved changes; browser backup is unavailable. Keep this page open until saved.'
          : 'Unsaved changes…',
      blocked || storageFailed,
    );
    renderCaptions();
    clearTimeout(timer);
    if (!blocked)
      timer = window.setTimeout(() => {
        void flush();
      }, 700);
  }
  function renderCaptions() {
    if (!captionTrack) return;
    for (const cue of Array.from(captionTrack.cues ?? [])) captionTrack.removeCue(cue);
    for (const cue of cues()) {
      if (
        cue.omitted ||
        !Number.isFinite(cue.start) ||
        !Number.isFinite(cue.end) ||
        cue.start < 0 ||
        cue.end <= cue.start ||
        !cue.texts[language]
      )
        continue;
      // Native caption markup is parsed by the browser, never inserted as page HTML.
      const caption = new VTTCue(cue.start, cue.end, cue.texts[language]);
      caption.id = cue.id;
      captionTrack.addCue(caption);
    }
    captionTrack.mode = input('showSubtitles').checked ? 'showing' : 'hidden';
  }
  function renderList() {
    const query = input('search').value.trim().toLocaleLowerCase('tr');
    const filter = $<HTMLSelectElement>('filter').value;
    const fragment = window.document.createDocumentFragment();
    rows.clear();
    for (const cue of cues()) {
      if (
        query &&
        cue.id !== query.replace(/^#/, '') &&
        !Object.values(cue.texts).some((text) => text.toLocaleLowerCase('tr').includes(query))
      )
        continue;
      if (filter === 'warnings' && !cue.warnings.length) continue;
      if (filter === 'notes' && !cue.flagged && !cue.note) continue;
      if (filter === 'changed' && !cue.changed) continue;
      const row = node('button', '', 'cue-row');
      row.type = 'button';
      row.dataset.cueId = cue.id;
      row.classList.toggle('selected', cue.id === selected);
      row.classList.toggle('active', cue.id === active);
      row.classList.toggle('omitted', cue.omitted);
      row.append(
        node(
          'span',
          `#${cue.id} · ${clock(cue.start)} · ${cue.speaker.replace('speaker_', 'Voice ')}`,
          'cue-meta',
        ),
        node('span', cue.texts[language], 'cue-text'),
      );
      const flags = [
        cue.omitted ? 'Excluded' : '',
        cue.changed ? 'Edited' : '',
        cue.flagged ? 'For later' : '',
        cue.warnings.length ? `${cue.warnings.length} checks` : '',
      ].filter(Boolean);
      const tags = node('span', '', 'cue-tags');
      for (const flag of flags) tags.append(node('span', flag));
      row.append(tags);
      row.onclick = () => {
        video.pause();
        select(cue.id);
        seek(cue.start - 1);
      };
      const wrapper = node('div', '');
      wrapper.setAttribute('role', 'listitem');
      wrapper.append(row);
      fragment.append(wrapper);
      rows.set(cue.id, row);
    }
    if (!rows.size) fragment.append(node('p', 'No cues match this view.', 'empty-state'));
    $('cueList').replaceChildren(fragment);
    $('cueCount').textContent = `${document.cues.filter((cue) => !cue.omitted).length} cues`;
    $('listSummary').textContent =
      `${rows.size} shown · ${cues().filter((cue) => cue.flagged).length} marked for later`;
  }
  function select(cueId: string) {
    if (!document.cues.some((cue) => cue.id === cueId)) return;
    rows.get(selected)?.classList.remove('selected');
    selected = cueId;
    rows.get(selected)?.classList.add('selected');
    const cue = current();
    loading = true;
    $('selectedTitle').textContent = `Cue ${cue.id}`;
    $('selectedMeta').textContent =
      `${clock(cue.start)} → ${clock(cue.end)} · ${cue.speaker.replace('speaker_', 'Voice ')}`;
    area('sourceText').value = cue.texts[document.sourceLanguage];
    area('targetText').value = cue.texts[document.targetLanguage] ?? '';
    input('cueStart').value = invalidTiming.get(cue.id)?.start ?? clock(cue.start);
    input('cueEnd').value = invalidTiming.get(cue.id)?.end ?? clock(cue.end);
    area('cueNote').value = cue.note;
    input('needsFix').checked = cue.flagged;
    input('omitCue').checked = cue.omitted;
    $('selectedFlags').replaceChildren(
      ...cue.warnings.map((warning) => node('span', warning.replaceAll('_', ' '))),
    );
    const original = document.original.find((entry) => entry.id === cue.id);
    $('originalCue').textContent = original
      ? `${clock(original.start)} → ${clock(original.end)}\n${Object.entries(original.texts)
          .map(([lang, text]) => `${lang.toUpperCase()}: ${text}`)
          .join('\n\n')}`
      : 'Added during review.';
    $<HTMLButtonElement>('restoreCue').disabled = !original;
    input('shiftFrom').value = cue.id;
    input('shiftTo').value = cue.id;
    loading = false;
  }
  function seek(time: number) {
    if (!video.src) return;
    video.currentTime = Math.max(
      0,
      Math.min((Number.isFinite(video.duration) ? video.duration : document.duration) - 0.02, time),
    );
  }
  async function play() {
    try {
      await video.play();
    } catch {
      status('Choose the matching film or check that the screening media is available.', true);
    }
  }
  function replay() {
    seek(current().start - 1);
    void play();
  }
  function adjacent(direction: number) {
    const ordered = cues(),
      index = ordered.findIndex((cue) => cue.id === selected);
    const cue = ordered[Math.max(0, Math.min(ordered.length - 1, index + direction))];
    select(cue.id);
    seek(cue.start - 1);
  }
  function editCurrent() {
    video.pause();
    const cue = cues().findLast(
      (cue) => !cue.omitted && cue.start <= video.currentTime && cue.end > video.currentTime,
    );
    if (!cue) {
      status('No cue here. Use Add missing dialogue to insert one.');
      return;
    }
    select(cue.id);
    area(document.languages.length > 1 ? 'targetText' : 'sourceText').focus();
  }
  async function command(body: Record<string, unknown>) {
    if (commandBusy || !(await flush()) || commandBusy) return false;
    commandBusy = true;
    const controls = [
      ...window.document.querySelectorAll<
        HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement
      >('#correctionEditor input, #correctionEditor textarea, #correctionEditor button'),
    ];
    controls.forEach((control) => {
      control.disabled = true;
    });
    try {
      document = await request(api, { revision: document.revision, ...body });
      persistDraft();
      renderList();
      renderCaptions();
      select(selected);
      saveStatus('Saved to the server. Downloads include your corrections.');
      return true;
    } catch (error) {
      status(error.message, true);
      return false;
    } finally {
      commandBusy = false;
      controls.forEach((control) => {
        control.disabled = false;
      });
      select(selected);
    }
  }
  function download(content: string, filename: string, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = node('a', '');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportNotes() {
    download(
      `# ${document.title} — corrections and notes\n\nSaved revision: ${document.revision}\n\n` +
        cues()
          .filter((cue) => cue.changed || cue.note || cue.flagged)
          .map(
            (cue) =>
              `## Cue ${cue.id} · ${clock(cue.start)} → ${clock(cue.end)}\n\n${Object.entries(
                cue.texts,
              )
                .map(([lang, text]) => `**${lang}:** ${text}`)
                .join(
                  '\n\n',
                )}\n\n${cue.omitted ? 'Excluded from exports.\n\n' : ''}${cue.flagged ? 'Marked for later.\n\n' : ''}${cue.note}\n`,
          )
          .join('\n'),
      `${id}-review-notes.md`,
      'text/markdown',
    );
  }
  function exportLink(link: HTMLAnchorElement, lang: string, format: string, original = false) {
    link.href = new URL(
      `api/reviews/${id}/subtitles/${lang}.${format}${original ? '?original=1' : ''}`,
      root,
    ).href;
    link.hidden = false;
    link.download = '';
    link.onclick = (event) => {
      if (original) return;
      event.preventDefault();
      void flush().then((ok) => {
        if (ok) window.location.assign(link.href);
      });
    };
  }
  function languageChanged() {
    language = $<HTMLSelectElement>('subtitleLanguage').value;
    exportLink($<HTMLAnchorElement>('downloadSrt'), language, 'srt');
    exportLink($<HTMLAnchorElement>('downloadAss'), language, 'ass');
    $('downloadSrt').textContent = `Download SRT (${language})`;
    $('downloadAss').textContent = `Download ASS (${language})`;
    renderList();
    renderCaptions();
  }
  function savePosition(keepalive = false) {
    if (!Number.isFinite(video.currentTime) || video.currentTime > document.duration + 0.1) return;
    void request(
      new URL(`${api.pathname}/position`, api),
      { position: video.currentTime },
      keepalive,
    ).catch(() => {});
  }
  function tick() {
    $('clock').textContent = `${clock(video.currentTime)} / ${clock(document.duration)}`;
    const cue = cues().findLast(
      (cue) => !cue.omitted && cue.start <= video.currentTime && cue.end > video.currentTime,
    );
    if (active !== (cue?.id ?? '')) {
      rows.get(active)?.classList.remove('active');
      active = cue?.id ?? '';
      rows.get(active)?.classList.add('active');
      const row = rows.get(active),
        list = $('cueList');
      if (row && input('followPlayback').checked) {
        const bounds = row.getBoundingClientRect(),
          viewport = list.getBoundingClientRect();
        if (bounds.top < viewport.top || bounds.bottom > viewport.bottom)
          list.scrollTop += bounds.top - viewport.top - list.clientHeight / 3;
      }
    }
    if (
      input('loopCue').checked &&
      !video.paused &&
      video.currentTime >= Math.min(document.duration, current().end + 0.75)
    )
      seek(current().start - 1);
    if (Date.now() - positionAt > 10000) {
      positionAt = Date.now();
      savePosition();
    }
  }

  document = await request(api);
  if (document.version !== 2 || !document.cues.length)
    throw new Error('Invalid screening document');
  language = document.languages.includes(document.targetLanguage)
    ? document.targetLanguage
    : document.sourceLanguage;
  selected = document.cues[0].id;
  try {
    const draft = JSON.parse(localStorage.getItem(draftKey) ?? 'null');
    if (draft && Array.isArray(draft.edits)) {
      for (const edit of draft.edits)
        if (document.cues.some((cue) => cue.id === edit?.id))
          pending.set(edit.id, { edit, generation: ++generation });
      for (const entry of Array.isArray(draft.timings) ? draft.timings : []) {
        if (
          Array.isArray(entry) &&
          document.cues.some((cue) => cue.id === entry[0]) &&
          typeof entry[1]?.start === 'string' &&
          typeof entry[1]?.end === 'string'
        )
          invalidTiming.set(entry[0], entry[1]);
      }
      blocked = draft.revision !== document.revision;
      if (pending.size || invalidTiming.size)
        recovery(
          blocked
            ? 'A browser draft differs from the current saved version. Choose which edits to keep.'
            : 'Recovered unsaved edits from this browser.',
          blocked,
        );
    }
  } catch {
    /* Ignore damaged browser cache; the server document stays authoritative. */
  }
  $('filmTitle').textContent = document.title;
  window.document.title = `${document.title} · Subtitle corrections`;
  $('filmDescription').textContent =
    'Watch the film and fix only the passages that need attention. Subtitles are ready to use immediately.';
  $('reviewExplanation').textContent =
    'Your corrections and playback position are saved on the server. Generated originals remain available. Speaker labels are tentative voice groups.';
  $('shortcuts').textContent =
    'Space: play/pause · ←/→: seek · [/]: previous/next cue · R: replay · E: edit current cue · Ctrl/⌘+Enter: save and resume';
  $('markCurrent').textContent = 'Edit current cue · E';
  $('selectedText').hidden = true;
  $('correctionEditor').hidden = false;
  $('languageControl').hidden = false;
  $('sourceTextLabel').textContent = `Dialogue (${document.sourceLanguage})`;
  $('targetTextLabel').textContent = `Translation (${document.targetLanguage})`;
  $('addSourceLabel').textContent = `Dialogue (${document.sourceLanguage})`;
  $('addTargetLabel').textContent = `Translation (${document.targetLanguage})`;
  $('targetTextControl').hidden = $('addTargetControl').hidden = document.languages.length < 2;
  area('sourceText').lang = document.sourceLanguage;
  area('targetText').lang = document.targetLanguage;
  for (const lang of document.languages) {
    const option = node('option', lang.toUpperCase());
    option.value = lang;
    option.selected = lang === language;
    $('subtitleLanguage').append(option);
    const link = node('a', `Generated original (${lang})`, 'button secondary');
    exportLink(link, lang, 'srt', true);
    $('originalDownloads').append(link);
  }
  $<HTMLTrackElement>('subtitles').remove();
  captionTrack = video.addTextTrack('subtitles', 'Current subtitles');
  if (document.media)
    video.src = new URL(`review-sessions/${id}/${encodeURIComponent(document.media)}`, root).href;
  else {
    $('localMediaControl').hidden = false;
    status(document.mediaMessage);
  }
  video.addEventListener('loadedmetadata', () => {
    seek(document.position);
    tick();
  });
  video.addEventListener('error', () => {
    $('localMediaControl').hidden = false;
    status(
      'Screening media is unavailable. You can open a matching local film while keeping server-saved corrections.',
      true,
    );
  });
  input('localMedia').onchange = () => {
    const file = input('localMedia').files?.[0];
    if (!file) return;
    if (localUrl) URL.revokeObjectURL(localUrl);
    localUrl = URL.createObjectURL(file);
    video.src = localUrl;
    status('Using your local film for playback. Subtitle corrections still save to the server.');
  };
  languageChanged();
  select(selected);
  $('workspace').hidden = false;
  $<HTMLButtonElement>('exportNotes').disabled = false;
  saveStatus(
    pending.size
      ? 'Recovered unsaved edits.'
      : 'Saved on the server. Edit only what needs changing.',
  );
  if (document.media) status('Ready to watch. Press E to correct the current cue.');
  if (pending.size && !blocked) void flush();
  $('playPause').onclick = () => (video.paused ? void play() : video.pause());
  video.onplay = () => {
    $('playPause').textContent = 'Pause';
  };
  video.onpause = () => {
    $('playPause').textContent = 'Play';
    savePosition();
  };
  video.ontimeupdate = tick;
  video.onseeked = tick;
  $('backFive').onclick = () => seek(video.currentTime - 5);
  $('forwardFive').onclick = () => seek(video.currentTime + 5);
  $('speed').onchange = () => {
    video.playbackRate = Number($<HTMLSelectElement>('speed').value);
  };
  $('showSubtitles').onchange = renderCaptions;
  $('subtitleLanguage').onchange = languageChanged;
  $('previousCue').onclick = () => adjacent(-1);
  $('nextCue').onclick = () => adjacent(1);
  $('replayCue').onclick = replay;
  $('loopCue').onchange = () => {
    if (input('loopCue').checked) replay();
  };
  $('markCurrent').onclick = editCurrent;
  $('search').oninput = renderList;
  $('filter').onchange = renderList;
  $('timeForm').onsubmit = (event) => {
    event.preventDefault();
    try {
      const time = seconds(input('jumpTime').value);
      if (time >= document.duration) throw new Error('That time is outside the film.');
      input('loopCue').checked = false;
      seek(time);
    } catch (error) {
      status(error.message, true);
    }
  };
  for (const [field, lang] of [
    ['sourceText', document.sourceLanguage],
    ['targetText', document.targetLanguage],
  ])
    area(field).oninput = () => stage({ id: selected, texts: { [lang]: area(field).value } });
  const changeTiming = () => {
    invalidTiming.set(selected, { start: input('cueStart').value, end: input('cueEnd').value });
    try {
      const start = seconds(input('cueStart').value),
        end = seconds(input('cueEnd').value);
      if (start < 0 || end <= start || end > document.duration + 0.1)
        throw new Error('Use a positive-duration cue within the film.');
      invalidTiming.delete(selected);
      stage({ id: selected, start, end });
    } catch (error) {
      persistDraft();
      saveStatus(`Timing not saved: ${error.message}`, true);
    }
  };
  input('cueStart').oninput = changeTiming;
  input('cueEnd').oninput = changeTiming;
  $('startHere').onclick = () => {
    input('cueStart').value = clock(video.currentTime);
    changeTiming();
  };
  $('endHere').onclick = () => {
    input('cueEnd').value = clock(video.currentTime);
    changeTiming();
  };
  const nudge = (amount: number) => {
    const cue = current();
    if (cue.start + amount < 0 || cue.end + amount > document.duration + 0.1) {
      status('That offset moves the cue outside the film.', true);
      return;
    }
    input('cueStart').value = clock(cue.start + amount);
    input('cueEnd').value = clock(cue.end + amount);
    changeTiming();
  };
  $('earlierCue').onclick = () => nudge(-0.1);
  $('laterCue').onclick = () => nudge(0.1);
  area('cueNote').oninput = () => stage({ id: selected, note: area('cueNote').value });
  input('needsFix').onchange = () => stage({ id: selected, flagged: input('needsFix').checked });
  input('omitCue').onchange = () => stage({ id: selected, omitted: input('omitCue').checked });
  $('restoreCue').onclick = () => {
    void (async () => {
      if (saving) await saving;
      pending.delete(selected);
      invalidTiming.delete(selected);
      persistDraft();
      await command({ edits: [{ id: selected, reset: true }] });
    })();
  };
  $('shiftRemaining').onclick = () => {
    input('shiftTo').value = cues().at(-1)!.id;
  };
  $('shiftAll').onclick = () => {
    input('shiftFrom').value = cues()[0].id;
    input('shiftTo').value = cues().at(-1)!.id;
  };
  $('applyShift').onclick = () => {
    void command({
      shift: {
        fromId: input('shiftFrom').value.trim(),
        toId: input('shiftTo').value.trim(),
        seconds: Number(input('shiftSeconds').value),
      },
    });
  };
  $('addHere').onclick = () => {
    input('addStart').value = clock(video.currentTime);
    input('addEnd').value = clock(Math.min(document.duration, video.currentTime + 2));
  };
  $('addCue').onclick = () => {
    try {
      const texts = {
        [document.sourceLanguage]: area('addSource').value,
        ...(document.languages.length > 1
          ? { [document.targetLanguage]: area('addTarget').value }
          : {}),
      };
      void command({
        add: {
          start: seconds(input('addStart').value),
          end: seconds(input('addEnd').value),
          texts,
        },
      }).then((saved) => {
        if (!saved) return;
        select(
          document.cues.reduce((latest, cue) => (Number(cue.id) > Number(latest.id) ? cue : latest))
            .id,
        );
        area('addSource').value = '';
        area('addTarget').value = '';
        $<HTMLDetailsElement>('addCuePanel').open = false;
      });
    } catch (error) {
      status(error.message, true);
    }
  };
  $('exportNotes').onclick = exportNotes;
  $('exportDraft').onclick = () =>
    download(
      JSON.stringify(
        {
          jobId: id,
          revision: document.revision,
          edits: [...pending.values()].map((entry) => entry.edit),
          timings: [...invalidTiming],
        },
        null,
        2,
      ),
      `${id}-unsaved-edits.json`,
      'application/json',
    );
  $('retryEdits').onclick = () => {
    void flush();
  };
  $('keepDraft').onclick = () => {
    void (async () => {
      document = await request(api);
      blocked = false;
      persistDraft();
      await flush();
      select(selected);
    })().catch((error) => status(error.message, true));
  };
  $('loadSaved').onclick = () => {
    void (async () => {
      if (saving) await saving;
      document = await request(api);
      if (pending.size || invalidTiming.size) $('exportDraft').click();
      pending.clear();
      invalidTiming.clear();
      blocked = false;
      persistDraft();
      $('draftRecovery').hidden = true;
      renderCaptions();
      renderList();
      select(selected);
      saveStatus('Loaded the saved server version.');
    })().catch((error) => status(error.message, true));
  };
  window.addEventListener('beforeunload', (event) => {
    if (pending.size || invalidTiming.size || saving || commandBusy) {
      event.preventDefault();
    }
  });
  window.addEventListener('pagehide', () => {
    persistDraft();
    savePosition(true);
  });
  window.addEventListener('online', () => {
    if (pending.size && !blocked) void flush();
  });
  window.document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.altKey) {
      event.preventDefault();
      void flush().then((ok) => {
        if (ok) {
          target.blur();
          video.focus();
          void play();
        }
      });
      return;
    }
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      target.closest('input, textarea, select, [contenteditable]')
    )
      return;
    const key = event.key.toLowerCase();
    if ((key === ' ' || key.startsWith('arrow')) && target.closest('button, a, video')) return;
    if (![' ', 'arrowleft', 'arrowright', '[', ']', 'r', 'e'].includes(key)) return;
    event.preventDefault();
    if (key === ' ') video.paused ? void play() : video.pause();
    else if (key === 'arrowleft') seek(video.currentTime - 5);
    else if (key === 'arrowright') seek(video.currentTime + 5);
    else if (key === '[') adjacent(-1);
    else if (key === ']') adjacent(1);
    else if (key === 'r') replay();
    else editCurrent();
  });
}
