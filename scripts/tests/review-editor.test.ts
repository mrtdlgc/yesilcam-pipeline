import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';

// Exercise the actual browser controller with a small DOM adapter. No browser build,
// service credentials or media/model requests are required for autosave/recovery checks.
test(
  'editor autosaves the right cues, previews timing, protects unfinished fields and recovers conflicts',
  { timeout: 15000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yesilcam-editor-'));
    process.env.DATA_DIR = root;
    const {
      createSubtitleReview,
      readSubtitleReview,
      reviewView,
      editSubtitleReview,
      saveReviewPosition,
    } = await import('../lib/subtitle-review.js');
    const source =
      '1\n00:00:00,100 --> 00:00:01,000\nAnacığım!\n\n2\n00:00:02,000 --> 00:00:03,000\nGeliyorum.\n';
    await createSubtitleReview({
      id: 'editor',
      title: 'Fixture',
      source,
      target: source.replace('Anacığım!', 'Uncle!').replace('Geliyorum.', 'I am coming.'),
      sourceLanguage: 'tr',
      targetLanguage: 'en',
      duration: 4,
      media: null,
    });
    class Element {
      value = '';
      textContent = '';
      hidden = false;
      disabled = false;
      checked = false;
      href = '';
      src = '';
      dataset: Record<string, string> = {};
      children: Element[] = [];
      currentTime = 0;
      duration = 4;
      paused = true;
      clientHeight = 400;
      scrollTop = 0;
      className = '';
      lang = '';
      type = '';
      open = false;
      onclick?: (event: any) => unknown;
      oninput?: () => unknown;
      onchange?: () => unknown;
      classes = new Set<string>();
      classList = {
        add: (value: string) => this.classes.add(value),
        remove: (value: string) => this.classes.delete(value),
        toggle: (value: string, enabled: boolean) =>
          enabled ? this.classes.add(value) : this.classes.delete(value),
      };
      listeners: Record<string, Function[]> = {};
      captions = {
        cues: [] as any[],
        mode: 'hidden',
        addCue(cue: any) {
          this.cues.push(cue);
        },
        removeCue(cue: any) {
          this.cues.splice(this.cues.indexOf(cue), 1);
        },
      };
      constructor(public tag = 'div') {}
      append(...items: Element[]) {
        this.children.push(...items);
      }
      replaceChildren(...items: Element[]) {
        this.children = items;
      }
      setAttribute() {}
      remove() {}
      focus() {}
      click() {
        return this.onclick?.({ preventDefault() {} });
      }
      addEventListener(name: string, listener: Function) {
        (this.listeners[name] ??= []).push(listener);
      }
      getBoundingClientRect() {
        return { top: 0, bottom: 100 };
      }
      addTextTrack() {
        return this.captions;
      }
      pause() {
        this.paused = true;
      }
      play() {
        this.paused = false;
        return Promise.resolve();
      }
    }
    const nodes = new Map<string, Element>();
    const html = await fs.readFile(path.resolve('public/review-player.html'), 'utf8');
    for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"/g))
      nodes.set(match[2], new Element(match[1]));
    const element = (id: string) => {
      const result = nodes.get(id);
      assert.ok(result, `Missing element ${id}`);
      return result;
    };
    element('filter').value = 'all';
    element('showSubtitles').checked = true;
    const events = new Map<string, Function[]>(),
      downloads: string[] = [],
      stored = new Map<string, string>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const fakeDocument = {
      title: '',
      getElementById: (id: string) => element(id),
      createElement: (tag: string) => new Element(tag),
      createDocumentFragment: () => new Element(),
      querySelectorAll: () => [],
      addEventListener: (name: string, listener: Function) => {
        events.set(name, [...(events.get(name) ?? []), listener]);
      },
    };
    const location = {
      href: 'http://localhost:3000/studio/review-player.html?job=editor',
      assign: (url: string) => downloads.push(url),
    };
    const fakeWindow = {
      document: fakeDocument,
      location,
      addEventListener: fakeDocument.addEventListener,
      setTimeout: (callback: () => void, delay: number) => {
        const timer = setTimeout(callback, delay);
        timers.add(timer);
        return timer;
      },
    };
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const replace = (name: string, value: unknown) => {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    };
    replace('window', fakeWindow);
    replace('document', fakeDocument);
    replace('location', location);
    replace('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    });
    replace(
      'VTTCue',
      class {
        id = '';
        constructor(
          public startTime: number,
          public endTime: number,
          public text: string,
        ) {}
      },
    );
    replace('fetch', async (url: URL, options: RequestInit) => {
      try {
        const body = options.body ? JSON.parse(String(options.body)) : undefined;
        if (url.pathname.endsWith('/position')) {
          await saveReviewPosition('editor', body.position);
          return Response.json({ saved: true });
        }
        const document = body
          ? await editSubtitleReview('editor', body)
          : await readSubtitleReview('editor');
        return Response.json(reviewView(document));
      } catch (error) {
        return Response.json({ error: error.message }, { status: error.status || 500 });
      }
    });
    async function until(check: () => boolean | Promise<boolean>) {
      for (let i = 0; i < 100; i++) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail(
        `Expected editor state; ${element('saveStatus').textContent} ${element('status').textContent}`,
      );
    }
    try {
      const { startEditor } = await import('../../public/review-editor.js');
      // A native select updates its value when a selected option is appended.
      element('subtitleLanguage').value = 'en';
      await startEditor('editor');
      assert.match(
        element('downloadSrt').href,
        /\/studio\/api\/reviews\/editor\/subtitles\/en.srt$/,
      );
      element('targetText').value = 'Mother!';
      element('targetText').oninput!();
      element('nextCue').click();
      element('targetText').value = 'Coming!';
      element('targetText').oninput!();
      element('downloadSrt').click();
      await until(() => downloads.length === 1);
      let document = await readSubtitleReview('editor');
      assert.equal(document.cues[0].texts.en, 'Mother!');
      assert.equal(document.cues[1].texts.en, 'Coming!');
      element('previousCue').click();
      element('cueStart').value = '00:00:00.200';
      element('cueStart').oninput!();
      element('cueEnd').value = '00:00:01.200';
      element('cueEnd').oninput!();
      assert.equal(
        element('film').captions.cues[0].startTime,
        0.2,
        'live playback uses draft timing',
      );
      element('downloadSrt').click();
      await until(() => downloads.length === 2);
      document = await readSubtitleReview('editor');
      assert.equal(document.cues[0].end, 1.2);
      element('cueStart').value = 'unfinished';
      element('cueStart').oninput!();
      element('downloadSrt').click();
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(downloads.length, 2);
      element('nextCue').click();
      element('previousCue').click();
      assert.equal(element('cueStart').value, 'unfinished');
      assert.ok(
        [...stored.values()].some((value) => value.includes('unfinished')),
        'raw timing survives browser draft recovery',
      );
      const unload = {
        prevented: false,
        preventDefault() {
          this.prevented = true;
        },
      };
      events.get('beforeunload')!.forEach((listener) => listener(unload));
      assert.equal(unload.prevented, true);
      element('restoreCue').click();
      await until(async () => (await readSubtitleReview('editor')).cues[0].texts.en === 'Uncle!');
      await until(() => element('cueStart').value === '00:00:00.100');
      document = await readSubtitleReview('editor');
      await editSubtitleReview('editor', {
        revision: document.revision,
        edits: [{ id: '1', texts: { en: 'Mum!' } }],
      });
      element('targetText').value = 'Mother!';
      element('targetText').oninput!();
      element('downloadSrt').click();
      await until(() => !element('draftRecovery').hidden && !element('keepDraft').hidden);
      assert.equal((await readSubtitleReview('editor')).cues[0].texts.en, 'Mum!');
      assert.ok([...stored.values()].some((value) => value.includes('Mother!')));
      element('keepDraft').click();
      await until(async () => (await readSubtitleReview('editor')).cues[0].texts.en === 'Mother!');
      await until(() => element('draftRecovery').hidden);
      element('addStart').value = '00:00:03.100';
      element('addEnd').value = '00:00:03.900';
      element('addSource').value = 'Bekle!';
      element('addTarget').value = 'Wait!';
      element('addCue').click();
      await until(async () => (await readSubtitleReview('editor')).cues.length === 3);
      await until(() => element('selectedTitle').textContent === 'Cue 3');
      assert.equal(element('targetText').value, 'Wait!');
    } finally {
      timers.forEach(clearTimeout);
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as any)[name];
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
