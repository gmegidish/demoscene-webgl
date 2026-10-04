// Boot: build effects in the original registration order, load assets, then drive the timeline from the music clock.
import { Context, Timeline, PendingEffect } from './engine.js';
import { EFFECT_ORDER, buildEvents } from './demoTimeline.js';
import { SplineEffect } from './effects/splines.js';
import { GlowEffect, FlashEffect, ImageEffect, ChangeImageEffect } from './effects/post.js';

const SEEK_STEP_MS = 5000;
const MUSIC_URL = '../assets/audio/music.mp3';

const ctx = new Context(document.getElementById('screen'));
const audio = document.getElementById('music');
const overlay = document.getElementById('start');
const hud = document.getElementById('hud');

const ported = {
  splines: () => new SplineEffect(ctx),
  glow: () => new GlowEffect(ctx),
  fade: () => new FlashEffect(ctx),
  flash: () => new FlashEffect(ctx),
  image: () => new ImageEffect(ctx, ['textures/fullscreen1']),
  change: () => new ChangeImageEffect(ctx, 'textures/fullscreen2'),
  blackbars: () => new ImageEffect(ctx, ['textures/cinemascope']),
};
// Scene modules: each default-exports `(ctx) => DemoEffect`. A missing module leaves a PendingEffect.
const SCENE_MODULES = ['scroll', 'claws', 'tunnel', 'robot', 'beebox', 'waves', 'liquid', 'metal', 'edge', 'text', 'endimg'];
await Promise.all(SCENE_MODULES.map(async (name) => {
  try {
    ported[name] = (await import(`./effects/${name}.js`)).default;
  } catch (error) {
    console.warn(`effect "${name}" not ported yet:`, error.message);
  }
}));
const effects = new Map(EFFECT_ORDER.map((name) => {
  const create = ported[name];
  return [name, create ? create(ctx) : new PendingEffect(ctx)];
}));
const timeline = new Timeline(effects, buildEvents());

/** Demo time in ms. The music is the clock; after it ends (297 s) the demo runs on to 305 s. */
const clock = {
  overrunStart: null,
  now() {
    if (!audio.ended) {
      this.overrunStart = null;
      return audio.currentTime * 1000;
    }
    this.overrunStart ??= performance.now();
    return audio.duration * 1000 + (performance.now() - this.overrunStart);
  },
};

function frame() {
  const time = clock.now();
  ctx.beginFrame();
  timeline.render(time);
  ctx.present();
  hud.textContent = `${(time / 1000).toFixed(2)}s`;
  if (!timeline.finished) {
    requestAnimationFrame(frame);
  }
}

/** Render one frame at every scene start so shaders compile during loading, not mid-demo. */
function warmUpShaders() {
  const starts = new Set(timeline.events.filter((ev) => ev.type === 'InitAndBegin').map((ev) => ev.time));
  for (const time of [...starts].sort((a, b) => a - b)) {
    ctx.beginFrame();
    timeline.render(time + 50);
  }
}

function startTimeFromHash() {
  const match = location.hash.match(/t=([\d.]+)/);
  return match ? Number(match[1]) : 0;
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen().catch(() => {});
  }
}

function seek(deltaMs) {
  audio.currentTime = Math.max(0, audio.currentTime + deltaMs / 1000);
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    if (audio.paused) {
      audio.play();
    } else {
      audio.pause();
    }
  } else if (e.code === 'ArrowRight') {
    seek(SEEK_STEP_MS);
  } else if (e.code === 'ArrowLeft') {
    seek(-SEEK_STEP_MS);
  } else if (e.code === 'KeyH') {
    hud.hidden = !hud.hidden;
  } else if (e.code === 'KeyF') {
    toggleFullscreen();
  }
});

overlay.textContent = 'loading…';
try {
  // Blob URL keeps seeking working on static servers without HTTP range support.
  const [music] = await Promise.all([fetch(MUSIC_URL).then((r) => r.blob()), timeline.load()]);
  audio.src = URL.createObjectURL(music);
  warmUpShaders();
  timeline.reset(); // Demo.LoadGraphicsContent resets the timeline after loading
  overlay.textContent = 'click to start';
  overlay.addEventListener('click', async () => {
    overlay.remove();
    audio.currentTime = startTimeFromHash();
    await audio.play();
    requestAnimationFrame(frame);
  }, { once: true });
} catch (error) {
  overlay.textContent = `failed to load: ${error.message}`;
  throw error;
}

// Debug handle for testing from the console: demo.audio.currentTime = 120
window.demo = { ctx, timeline, audio };
