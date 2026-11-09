const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../src/content.js'), 'utf8');

function fixture({ audioAvailable = true, captureFails = false, crossOrigin = false } = {}) {
  const contexts = [];
  class AudioContext {
    constructor() {
      this.state = 'running';
      this.destination = {};
      this.sources = [];
      this.gains = [];
      contexts.push(this);
    }
    createMediaElementSource(video) {
      if (captureFails) throw new Error('The media element already has an audio source');
      const node = { video, connect() {} };
      this.sources.push(node);
      return node;
    }
    createGain() {
      const node = { gain: { value: 1 }, connect() {}, disconnect() {} };
      this.gains.push(node);
      return node;
    }
    resume() {
      this.state = 'running';
      return Promise.resolve();
    }
  }

  const original = Object.assign(new EventTarget(), {
    tagName: 'VIDEO',
    classList: { contains: () => false },
    style: { opacity: '0.8' },
    volume: 0.4,
    muted: false,
    paused: true,
    src: crossOrigin ? 'https://cdn.example/live.mp4' : 'blob:https://live.bilibili.com/fixture',
    currentSrc: '',
    crossOrigin: '',
    srcObject: null,
    pause() { this.paused = true; }
  });
  const overlay = { volume: 1, muted: false };
  let now = 1000;
  const sandbox = {
    window: { AudioContext: audioAvailable ? AudioContext : undefined },
    location: { pathname: '/', href: 'https://live.bilibili.com/', origin: 'https://live.bilibili.com' },
    document: { hidden: false },
    performance: { now: () => now },
    console: { info() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, URL
  };
  // Expose the closure only inside the test VM; production needs no test hooks.
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, `
    window.testApi = { state, bindOriginal, silenceOriginal, restoreOriginal,
      unbindOriginal, setVolume, setMuted, applyAudio };
  })();`), sandbox);
  const api = sandbox.window.testApi;
  Object.assign(api.state, {
    active: true,
    volume: 0.7,
    overlay,
    playerEl: { children: [original] }
  });
  function changeOriginal(patch, elapsed = 200) {
    now += elapsed;
    Object.assign(original, patch);
    original.dispatchEvent(new Event('volumechange'));
  }
  return { ...api, original, overlay, contexts, changeOriginal };
}

test('following Bilibili volume leaves its mute flag aligned with audible overlay audio', () => {
  const f = fixture();
  f.bindOriginal();
  assert.equal(f.original.muted, false);
  assert.equal(f.original.volume, 0.7);
  assert.equal(f.original.style.opacity, '0');
  assert.equal(f.contexts[0].gains[0].gain.value, 0);
});

test('Bilibili mute, unmute and volume changes reach the overlay', () => {
  const f = fixture();
  f.bindOriginal();
  f.changeOriginal({ muted: true });
  assert.equal(f.overlay.muted, true);
  f.changeOriginal({ muted: false });
  assert.equal(f.overlay.muted, false);
  f.changeOriginal({ volume: 0.25 });
  assert.equal(f.overlay.volume, 0.25);
  assert.equal(f.original.muted, false);
});

test('panel volume and mute controls keep Bilibili controls in sync', () => {
  const f = fixture();
  f.bindOriginal();
  f.setMuted(true);
  assert.equal(f.original.muted, true);
  assert.equal(f.overlay.muted, true);
  f.setVolume(0.35, false);
  assert.equal(f.original.volume, 0.35);
  assert.equal(f.original.muted, false);
  assert.equal(f.overlay.muted, false);
});

test('a Bilibili control change immediately after panel sync is not discarded', () => {
  const f = fixture();
  f.bindOriginal();
  f.changeOriginal({ volume: 0.15, muted: true }, 0);
  assert.equal(f.overlay.volume, 0.15);
  assert.equal(f.overlay.muted, true);
});

test('unlocking autoplay audio clears the Bilibili mute flag before its next slider event', () => {
  const f = fixture();
  f.bindOriginal();
  f.state.autoplayMuted = true;
  f.applyAudio();
  f.silenceOriginal();
  assert.equal(f.original.muted, true);
  f.state.autoplayMuted = false;
  f.applyAudio();
  assert.equal(f.original.muted, false);
  f.changeOriginal({ volume: 0.2 }, 0);
  assert.equal(f.overlay.muted, false);
  assert.equal(f.overlay.volume, 0.2);
});

test('programmatic volume events do not turn autoplay muting into a saved user mute', () => {
  const f = fixture();
  f.bindOriginal();
  f.state.autoplayMuted = true;
  f.applyAudio();
  f.changeOriginal({}, 0);
  assert.equal(f.state.autoplayMuted, true);
  assert.equal(f.state.muted, false);
});

test('restoring the original releases audio suppression and preserves the saved settings', () => {
  const f = fixture();
  f.bindOriginal();
  f.setMuted(true);
  f.state.active = false;
  f.restoreOriginal();
  assert.equal(f.original.style.opacity, '0.8');
  assert.equal(f.original.volume, 0.4);
  assert.equal(f.original.muted, false);
  assert.equal(f.contexts[0].gains[0].gain.value, 1);

  f.setVolume(0.3, false);
  assert.equal(f.original.volume, 0.4);
  assert.equal(f.contexts[0].gains[0].gain.value, 1);
  f.unbindOriginal();

  f.state.active = true;
  f.setMuted(false);
  f.bindOriginal();
  assert.equal(f.original.muted, false);
  assert.equal(f.contexts[0].sources.length, 1);
  assert.equal(f.contexts[0].gains[0].gain.value, 0);
});

test('restoring a suspended audio context makes original playback audible again', () => {
  const f = fixture();
  f.bindOriginal();
  f.contexts[0].state = 'suspended';
  f.state.active = false;
  f.restoreOriginal();
  assert.equal(f.contexts[0].state, 'running');
});

test('independent volume mode keeps original audio muted without changing overlay volume', () => {
  const f = fixture();
  f.state.followBiliVolume = false;
  f.bindOriginal();
  f.changeOriginal({ volume: 0.2, muted: false });
  assert.equal(f.original.muted, true);
  assert.equal(f.original.volume, 0.2);
  assert.equal(f.state.volume, 0.7);
  assert.equal(f.state.muted, false);
});

test('switching off volume following keeps an existing audio route silent', () => {
  const f = fixture();
  f.bindOriginal();
  f.applyAudio();
  f.state.followBiliVolume = false;
  f.silenceOriginal();
  f.changeOriginal({ volume: 0.2, muted: false });
  assert.equal(f.original.muted, true);
  assert.equal(f.overlay.volume, 0.7);
  assert.equal(f.contexts[0].gains[0].gain.value, 0);
});

for (const [name, options] of [
  ['Web Audio is unavailable', { audioAvailable: false }],
  ['the player already owns the audio source', { captureFails: true }],
  ['a cross-origin media URL was loaded without CORS', { crossOrigin: true }]
]) {
  test(`original audio stays muted when ${name}`, () => {
    const f = fixture(options);
    f.bindOriginal();
    assert.equal(f.original.muted, true);
    f.changeOriginal({ volume: 0.3, muted: false });
    assert.equal(f.original.muted, true);
    assert.equal(f.overlay.volume, 0.3);
    assert.equal(f.overlay.muted, false);
    f.state.active = false;
    f.restoreOriginal();
    assert.equal(f.original.volume, 0.4);
    assert.equal(f.original.muted, false);
  });
}
