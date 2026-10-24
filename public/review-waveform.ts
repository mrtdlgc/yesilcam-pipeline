interface WaveformCue {
  id: string;
  start: number;
  end: number;
  text: string;
  omitted: boolean;
}
interface WaveformData {
  version: number;
  duration: number;
  binsPerSecond: number;
  peaks: string;
  rms: string;
}
interface Options {
  video: HTMLVideoElement;
  duration: number;
  load: () => Promise<WaveformData>;
  cues: () => WaveformCue[];
  selected: () => string;
  canEdit: () => boolean;
  select: (id: string) => void;
  seek: (time: number) => void;
  timing: (id: string, start: number, end: number) => void;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const timestamp = (time: number) => {
  const minutes = Math.floor(time / 60);
  return `${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)}:` : ''}${String(minutes % 60).padStart(2, '0')}:${(time % 60).toFixed(2).padStart(5, '0')}`;
};

export function startWaveform(options: Options) {
  const { video, duration } = options;
  const canvas = $<HTMLCanvasElement>('waveformCanvas');
  const context = canvas.getContext?.('2d');
  if (!context) return; // Text timing controls remain usable without canvas support.
  $('waveformPanel').hidden = false;
  const position = $<HTMLInputElement>('waveformPosition');
  const follow = $<HTMLInputElement>('waveformFollow');
  const handles = {
    start: $<HTMLButtonElement>('waveformStart'),
    end: $<HTMLButtonElement>('waveformEnd'),
  };
  let peaks = new Uint8Array(0),
    rms = new Uint8Array(0),
    binsPerSecond = 100,
    windowStart = 0,
    span = Math.min(12, duration),
    gain = 2,
    width = 0,
    frame = 0,
    stopped = false,
    loading = false;
  let drag: {
    id: string;
    edge: 'start' | 'end';
    start: number;
    end: number;
    originalStart: number;
    originalEnd: number;
    pointerId: number;
  } | null = null;
  const selected = () => options.cues().find((cue) => cue.id === options.selected());
  const x = (time: number) => ((time - windowStart) / span) * width;
  const timeAt = (event: PointerEvent | MouseEvent) =>
    Math.round(
      clamp(
        windowStart + ((event.clientX - canvas.getBoundingClientRect().left) / width) * span,
        0,
        duration,
      ) * 1000,
    ) / 1000;
  function setWindow(start: number) {
    windowStart = clamp(start, 0, Math.max(0, duration - span));
    position.max = String(Math.max(0, duration - span));
    position.value = String(windowStart);
    position.setAttribute(
      'aria-valuetext',
      `${timestamp(windowStart)} to ${timestamp(windowStart + span)}`,
    );
    draw();
  }
  function drawPlayhead() {
    const playhead = $('waveformPlayhead');
    playhead.hidden = video.currentTime < windowStart || video.currentTime > windowStart + span;
    playhead.style.left = `${clamp(x(video.currentTime), 0, width)}px`;
  }
  function draw() {
    const ctx = context!;
    width = canvas.getBoundingClientRect().width;
    if (!width) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(168 * ratio);
    ctx.scale(ratio, ratio);
    ctx.fillStyle = '#0d140f';
    ctx.fillRect(0, 0, width, 168);
    const ordered = options.cues().filter((cue) => !cue.omitted);
    const cue = selected();
    // A drag is a preview only; pointer-up commits one normal, revision-checked edit.
    const current = cue && drag?.id === cue.id ? { ...cue, start: drag.start, end: drag.end } : cue;
    for (const item of ordered) {
      const shown = current?.id === item.id ? current : item;
      if (shown.end < windowStart || shown.start > windowStart + span) continue;
      const left = clamp(x(shown.start), 0, width),
        right = clamp(x(shown.end), 0, width);
      ctx.fillStyle = shown.id === current?.id ? '#e5bb7225' : '#799d7f15';
      ctx.fillRect(left, 25, right - left, 110);
      ctx.fillStyle = shown.id === current?.id ? '#e5bb72' : '#526b56';
      ctx.fillRect(left, 135, Math.max(1, right - left), 28);
      ctx.save();
      ctx.beginPath();
      ctx.rect(left + 4, 136, Math.max(0, right - left - 8), 26);
      ctx.clip();
      ctx.fillStyle = shown.id === current?.id ? '#171d16' : '#f2eddf';
      ctx.font = '11px system-ui';
      ctx.fillText(
        `#${shown.id} ${shown.text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')}`,
        left + 5,
        153,
      );
      ctx.restore();
    }
    const step = span <= 8 ? 1 : span <= 20 ? 2 : span <= 40 ? 5 : 10;
    ctx.font = '10px system-ui';
    for (let tick = Math.ceil(windowStart / step) * step; tick < windowStart + span; tick += step) {
      const left = x(tick);
      ctx.fillStyle = '#354035';
      ctx.fillRect(left, 24, 1, 110);
      ctx.fillStyle = '#a6afa3';
      ctx.fillText(timestamp(tick), clamp(left + 3, 0, Math.max(0, width - 60)), 16);
    }
    ctx.fillStyle = '#354035';
    ctx.fillRect(0, 80, width, 1);
    for (let pixel = 0; pixel < width; pixel++) {
      const from = Math.floor((windowStart + (pixel / width) * span) * binsPerSecond);
      const to = Math.min(
        peaks.length,
        Math.max(from + 1, Math.ceil((windowStart + ((pixel + 1) / width) * span) * binsPerSecond)),
      );
      let peak = 0,
        energy = 0;
      for (let bin = from; bin < to; bin++) {
        peak = Math.max(peak, peaks[bin]);
        energy += rms[bin];
      }
      const height = Math.min(49, (peak / 255) * gain * 49);
      const body = to > from ? Math.min(49, (energy / (to - from) / 255) * gain * 49) : 0;
      ctx.fillStyle = '#7da888';
      ctx.fillRect(pixel, 80 - height, 1, height * 2);
      ctx.fillStyle = '#bddac1';
      ctx.fillRect(pixel, 80 - body, 1, body * 2);
    }
    for (const edge of ['start', 'end'] as const) {
      const handle = handles[edge];
      const time = current?.[edge] ?? -1;
      handle.hidden =
        !current || current.omitted || time < windowStart || time > windowStart + span;
      handle.disabled = !options.canEdit();
      handle.style.left = `${clamp(x(time), 0, width)}px`;
      handle.setAttribute(
        'aria-valuemin',
        String(edge === 'start' ? 0 : (current?.start ?? 0) + 0.02),
      );
      handle.setAttribute(
        'aria-valuemax',
        String(edge === 'end' ? duration : (current?.end ?? duration) - 0.02),
      );
      handle.setAttribute('aria-valuenow', String(time));
      handle.setAttribute('aria-valuetext', timestamp(Math.max(0, time)));
      handle.title = `${edge === 'start' ? 'Start' : 'End'}: ${timestamp(Math.max(0, time))}`;
    }
    drawPlayhead();
  }
  function sync() {
    if (
      !drag &&
      follow.checked &&
      (video.currentTime < windowStart || video.currentTime > windowStart + span * 0.85)
    )
      setWindow(video.currentTime - span * 0.2);
    else drawPlayhead();
  }
  function animate() {
    frame = 0;
    if (stopped) return;
    sync();
    if (!video.paused) frame = requestAnimationFrame(animate);
  }
  const resize = new ResizeObserver(() => draw());
  resize.observe(canvas);
  video.addEventListener('timeupdate', sync);
  video.addEventListener('seeked', sync);
  video.addEventListener('play', () => {
    if (!frame) frame = requestAnimationFrame(animate);
  });
  video.addEventListener('pause', sync);
  canvas.onclick = (event) => {
    video.pause();
    const time = timeAt(event);
    if (event.clientY - canvas.getBoundingClientRect().top >= 135) {
      const cue = options
        .cues()
        .findLast((cue) => !cue.omitted && cue.start <= time && cue.end > time);
      if (cue) options.select(cue.id);
    }
    options.seek(time);
    sync();
  };
  const changedTiming = (edge: 'start' | 'end', value: number, start: number, end: number) =>
    edge === 'start'
      ? { start: clamp(value, 0, end - 0.02), end }
      : { start, end: clamp(value, start + 0.02, duration) };
  for (const edge of ['start', 'end'] as const) {
    const handle = handles[edge];
    handle.onpointerdown = (event) => {
      const cue = selected();
      if (event.button !== 0 || !cue || cue.omitted || !options.canEdit()) return;
      event.preventDefault();
      video.pause();
      drag = {
        id: cue.id,
        edge,
        start: cue.start,
        end: cue.end,
        originalStart: cue.start,
        originalEnd: cue.end,
        pointerId: event.pointerId,
      };
      handle.setPointerCapture(event.pointerId);
      handle.focus({ preventScroll: true });
    };
    handle.onpointermove = (event) => {
      if (!drag || drag.edge !== edge || drag.pointerId !== event.pointerId) return;
      Object.assign(drag, changedTiming(edge, timeAt(event), drag.originalStart, drag.originalEnd));
      draw();
    };
    handle.onpointerup = (event) => {
      if (!drag || drag.edge !== edge || drag.pointerId !== event.pointerId) return;
      const edit = drag;
      drag = null;
      handle.releasePointerCapture(event.pointerId);
      const cue = selected();
      if (
        options.canEdit() &&
        cue?.id === edit.id &&
        cue.start === edit.originalStart &&
        cue.end === edit.originalEnd &&
        (edit.start !== cue.start || edit.end !== cue.end)
      )
        options.timing(edit.id, edit.start, edit.end);
      draw();
    };
    const cancel = () => {
      drag = null;
      draw();
    };
    handle.onpointercancel = cancel;
    handle.onlostpointercapture = cancel;
    handle.onkeydown = (event) => {
      if (event.key === 'Escape') {
        cancel();
        return;
      }
      if (
        !['ArrowLeft', 'ArrowRight'].includes(event.key) ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const cue = selected();
      if (!cue || cue.omitted || !options.canEdit()) return;
      video.pause();
      const value =
        Math.round(
          (cue[edge] + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 0.1 : 0.01)) * 1000,
        ) / 1000;
      const edit = changedTiming(edge, value, cue.start, cue.end);
      options.timing(cue.id, edit.start, edit.end);
    };
  }
  position.oninput = () => {
    follow.checked = false;
    setWindow(Number(position.value));
  };
  $('waveformZoom').onchange = () => {
    const center = clamp(video.currentTime, windowStart, windowStart + span);
    span = Math.min(duration, Number($<HTMLSelectElement>('waveformZoom').value));
    setWindow(center - span / 2);
  };
  $('waveformGain').onchange = () => {
    gain = Number($<HTMLSelectElement>('waveformGain').value);
    draw();
  };
  for (const [id, direction] of [
    ['waveformBack', -1],
    ['waveformForward', 1],
  ] as const)
    $(id).onclick = () => {
      follow.checked = false;
      setWindow(windowStart + (direction * span) / 2);
    };
  $('waveformCenter').onclick = () => {
    follow.checked = true;
    setWindow(video.currentTime - span / 2);
  };
  follow.onchange = () => {
    if (follow.checked) sync();
  };
  async function load() {
    if (loading) return;
    loading = true;
    $('waveformRetry').hidden = true;
    $('waveformStatus').textContent = 'Preparing the audio waveform… You can keep editing.';
    try {
      const data = await options.load();
      if (stopped) return;
      if (
        data.version !== 1 ||
        data.binsPerSecond !== 100 ||
        Math.abs(data.duration - duration) > 0.1
      )
        throw new Error('Waveform does not match this screening.');
      const decode = (encoded: string) =>
        Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      peaks = decode(data.peaks);
      rms = decode(data.rms);
      if (peaks.length !== Math.ceil(duration * data.binsPerSecond) || rms.length !== peaks.length)
        throw new Error('Waveform data is incomplete.');
      binsPerSecond = data.binsPerSecond;
      $('waveformStatus').textContent =
        'Audio energy · cue bands below · timing changes save automatically';
      draw();
    } catch (error) {
      if (stopped) return;
      peaks = rms = new Uint8Array(0);
      $('waveformStatus').textContent =
        `Waveform unavailable: ${error.message} Timing controls still work.`;
      $('waveformRetry').hidden = false;
    } finally {
      loading = false;
    }
  }
  $('waveformRetry').onclick = () => {
    void load();
  };
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    stopped = true;
    cancelAnimationFrame(frame);
    resize.disconnect();
  });
  setWindow(video.currentTime - span / 2);
  void load();
  return {
    refresh() {
      if (drag && drag.id !== options.selected()) drag = null;
      draw();
    },
    focus(time: number) {
      drag = null;
      setWindow(time - span / 3);
    },
  };
}
