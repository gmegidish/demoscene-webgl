// 1:1 port of Demo.DemoTimeline (decompiled/src/Demo/DemoTimeline.cs). Times are milliseconds.
import { SineInterpolation } from './interpolation.js';

// Render order = registration order in addAllEffects().
export const EFFECT_ORDER = [
  'scroll', 'claws', 'tunnel', 'robot', 'beebox', 'waves', 'liquid', 'metal', 'splines', 'glow',
  'wipe', 'endimg', 'edge', 'image', 'fade', 'change', 'text', 'flash', 'blackbars', 'stats',
];

const BAR = 4064;
const CREDITS = [' ', 'graphics:', 'am    snarling', 'music:', 'gloom flipside', 'code:', 'kmk  krav  svok'];
const GREETINGS = [' ', 'ananasmurska', 'ephidrena', 'asd', 'conspiracy', 'spaceballs', 'outracks', 'prostyle', 'synesthetics'];

/** Event params: numbers go to p[0..3], a string to `s`, anything else to `obj`. */
function ev(time, eff, type, ...params) {
  const p = params.filter((x) => typeof x === 'number');
  return {
    time,
    eff,
    type,
    p: [...p, 0, 0, 0, 0].slice(0, 4),
    s: params.find((x) => typeof x === 'string') ?? null,
    obj: params.find((x) => x !== null && typeof x === 'object') ?? null,
  };
}

function strobeInterpolation() {
  const sine = new SineInterpolation();
  const points = [
    [0, 0.6], [377, 1], [477, 1], [755, 0.4], [1132, 0.8], [1232, 0.8], [1510, 0.2], [1887, 0.6], [1987, 0.6],
    [2265, 0], [4167, 0], [4445, 0.6], [4822, 0.2], [5100, 0.8], [5200, 0.8], [5577, 0.4], [5855, 1], [5955, 1],
    [6332, 0.6], [6610, 1], [6710, 1],
  ];
  for (const [t, v] of points) {
    sine.addPoint(t, v);
  }
  for (const base of [7889, 11920]) {
    for (let j = 0; j < 4; j++) {
      sine.addPoint(base + j * 755, 1);
      sine.addPoint(base + 277 + j * 755, 0.2);
      sine.addPoint(base + 555 + j * 755, 1);
    }
  }
  return sine;
}

function introEvents() {
  return [
    ev(0, 'blackbars', 'SetTexture', 'textures/cinemascope'),
    ev(0, 'blackbars', 'InitAndBegin'),
    ev(0, 'fade', 'InitAndBegin'),
    ev(0, 'fade', 'FlashFadeDirection', 0),
    ev(0, 'fade', 'FlashColor', 0, 0, 0, 1),
    ev(0, 'fade', 'FlashDuration', 15000),
    ev(0, 'splines', 'InitAndBegin'),
    ev(0, 'glow', 'Begin'),
    ev(0, 'glow', 'GlowPreset', 6),
    ev(40700, 'change', 'InitAndBegin'),
    ev(40700, 'change', 'FadeType', 1),
    ev(40700, 'change', 'FadeSpeed', 0.4),
    ev(41700, 'change', 'FadeAlpha', 0.6),
    ev(41700, 'change', 'FadeSpeed', 0.1),
    ev(41900, 'change', 'FadeAlpha', 0.8),
    ev(42100, 'change', 'FadeAlpha', 0.99),
    ev(42100, 'change', 'FadeSpeed', 0),
  ];
}

function clawsEvents() {
  const start = 42713;
  const events = [
    ev(start, 'glow', 'GlowPreset', 1),
    ev(start, 'change', 'End'),
    ev(start, 'flash', 'InitAndBegin'),
    ev(start, 'flash', 'FlashDuration', 800),
    ev(start, 'splines', 'End'),
    ev(start, 'claws', 'InitAndBegin'),
    ev(start, 'claws', 'SelectCamera', 1),
    ev(start, 'claws', 'ShakeStart'),
  ];
  for (let i = 0; i < 6; i++) {
    events.push(ev(start + i * BAR, 'claws', 'ShakeStart'));
  }
  events.push(ev(54905, 'claws', 'SelectCamera', 2), ev(58969, 'flash', 'Init'));
  // Credits alternate between top-left and bottom-right, one per bar.
  for (let num = 0; num < 6; num++) {
    const t = start + num * BAR + (num === 0 ? 1 : 0);
    const [x, y] = num % 2 === 0 ? [0.08, 0.1] : [0.4, 0.9];
    if (num === 0) {
      events.push(ev(t, 'text', 'InitAndBegin'));
    }
    events.push(ev(t, 'text', 'TextPos', x, y, 0, 0), ev(t, 'text', 'TextMessage', CREDITS[num + 1]));
  }
  events.push(ev(start + 6 * BAR, 'text', 'End'));
  return events;
}

function tunnelAndWavesEvents() {
  return [
    ev(67000, 'glow', 'GlowPreset', 1),
    ev(67000, 'claws', 'End'),
    ev(67000, 'tunnel', 'InitAndBegin'),
    ev(67000, 'flash', 'Init'),
    ev(90026, 'fade', 'FlashFadeDirection', 1),
    ev(90026, 'fade', 'FlashColor', 0, 0, 0, 0),
    ev(90026, 'fade', 'FlashDuration', 1500),
    ev(90026, 'fade', 'InitAndBegin'),
    ev(91526, 'glow', 'End'),
    ev(91526, 'fade', 'End'),
    ev(91526, 'tunnel', 'End'),
    ev(91526, 'flash', 'Init'),
    ev(91526, 'flash', 'FlashDuration', 500),
    ev(91526, 'change', 'InitAndBegin'),
    ev(91526, 'change', 'FadeType', 2),
    ev(91526, 'change', 'FadeAlpha', 0),
    ev(91526, 'change', 'FadeSpeed', 0.5),
    ev(91526, 'change', 'FadeIn'),
    ev(150497, 'edge', 'InitAndBegin'),
    ev(150497, 'edge', 'FadeIn'),
    ev(150497, 'edge', 'FadeAlpha', 0),
    ev(150497, 'edge', 'FadeSpeed', 0.5),
    ev(98667, 'change', 'FadeType', 0),
    ev(98667, 'change', 'FadeOut'),
    ev(98667, 'waves', 'InitAndBegin'),
    ev(98667, 'waves', 'WavesLandSpeed', 0.02),
    ev(98667, 'waves', 'WavesLandHeight', 0.6),
    ev(98667, 'waves', 'WavesLandHeightTarget', 0.6),
    ev(98667, 'waves', 'SelectCamera', 0),
    ev(113667, 'waves', 'SelectCamera', 1),
    ev(152541, 'edge', 'End'),
    ev(152541, 'waves', 'End'),
  ];
}

function greetingsEvents() {
  const start = 152541;
  const events = [
    ev(start, 'scroll', 'InitAndBegin'),
    ev(start, 'flash', 'InitAndBegin'),
    ev(start, 'flash', 'FlashDuration', 300),
  ];
  const beat = (n) => [ev(start + n * BAR, 'flash', 'InitAndBegin'), ev(start + n * BAR, 'scroll', 'ShakeStart')];
  const msg = (n, i) => ev(start + n * BAR, 'text', 'TextMessage', GREETINGS[i]);
  const pos = (n, x) => ev(start + n * BAR, 'text', 'TextPos', x, 0.1, 0, 0);
  // Mirrors the hand-unrolled C#, including bar 6 that flashes twice; 'synesthetics' is never shown.
  events.push(...beat(1), pos(1, 0.32), ev(start + BAR, 'text', 'InitAndBegin'), msg(1, 1));
  events.push(...beat(2), msg(2, 2));
  events.push(...beat(3), pos(3, 0.45), msg(3, 3));
  events.push(...beat(4), pos(4, 0.32), msg(4, 4));
  events.push(...beat(5), msg(5, 5));
  events.push(...beat(6), ...beat(6), msg(6, 6));
  events.push(...beat(7), msg(7, 7));
  events.push(
    ev(184900, 'scroll', 'End'),
    ev(184900, 'text', 'End'),
    ev(183400, 'fade', 'InitAndBegin'),
    ev(183400, 'fade', 'FlashColor', 1, 1, 1, 1),
    ev(183400, 'fade', 'FlashDuration', 1500),
    ev(183400, 'fade', 'FlashFadeDirection', 1),
    ev(184900, 'fade', 'Init'),
    ev(184900, 'fade', 'FlashFadeDirection', 0),
    ev(184900, 'fade', 'FlashDuration', 2000),
    ev(184900, 'beebox', 'InitAndBegin'),
    ev(184900, 'glow', 'Begin'),
    ev(184900, 'glow', 'GlowPreset', 1),
    ev(201156, 'beebox', 'End'),
    ev(201156, 'glow', 'End'),
  );
  return events;
}

function robotAndFinaleEvents() {
  return [
    ev(201541, 'image', 'InitAndBegin'),
    ev(201541, 'image', 'SetTexture', 'textures/fullscreen1'),
    ev(201541, 'fade', 'InitAndBegin'),
    ev(201541, 'fade', 'SetInterpolator', strobeInterpolation()),
    ev(201541, 'fade', 'FlashColor', 0, 0, 0, 1),
    ev(209330, 'image', 'End'),
    ev(209330, 'robot', 'InitAndBegin'),
    ev(217628, 'fade', 'SetInterpolator', null),
    ev(217628, 'fade', 'End'),
    ev(209331, 'robot', 'SelectCamera', 2),
    ev(209331, 'robot', 'Speed', 1.8),
    ev(209331, 'glow', 'InitAndBegin'),
    ev(209331, 'glow', 'GlowPreset', 2),
    ev(217628, 'robot', 'RobotAnim', 1),
    ev(217628, 'flash', 'InitAndBegin'),
    ev(217628, 'robot', 'InitAndBegin'),
    ev(217629, 'robot', 'SelectCamera', 0),
    ev(221692, 'robot', 'Init'),
    ev(221692, 'robot', 'SelectCamera', 1),
    ev(225757, 'robot', 'SelectCamera', 3),
    ev(229820, 'robot', 'SelectCamera', 4),
    ev(233900, 'glow', 'GlowPreset', 5),
    ev(233900, 'robot', 'End'),
    ev(233900, 'metal', 'InitAndBegin'),
    ev(250174, 'metal', 'BoidsBehaviour', 1),
    ev(250174, 'fade', 'InitAndBegin'),
    ev(250174, 'fade', 'FlashFadeDirection', 1),
    ev(250174, 'fade', 'FlashDuration', 1500),
    ev(250174, 'fade', 'FlashColor', 1, 1, 1, 1),
    ev(252174, 'fade', 'FlashFadeDirection', 0),
    ev(252174, 'metal', 'End'),
    ev(252174, 'liquid', 'InitAndBegin'),
    ev(250174, 'glow', 'InitAndBegin'),
    ev(250174, 'glow', 'GlowPreset', 1),
    ev(252174, 'fade', 'FlashFadeDirection', 0),
    ev(252174, 'fade', 'Init'),
    ev(252174, 'fade', 'FlashDuration', 2000),
    ev(256272, 'liquid', 'StartAnimation'),
    ev(256272, 'flash', 'InitAndBegin'),
    ev(256272, 'flash', 'FlashDuration', 500),
    ev(266272, 'liquid', 'StartAnimation'),
    ev(276272, 'liquid', 'StartAnimation'),
    ev(282272, 'liquid', 'StartAnimation'),
    ev(272530, 'flash', 'InitAndBegin'),
    ev(272530, 'flash', 'FlashDuration', 500),
    ev(280500, 'liquid', 'ShakeStart', 8310),
    ev(285810, 'fade', 'InitAndBegin'),
    ev(285810, 'fade', 'FlashFadeDirection', 1),
    ev(285810, 'fade', 'FlashDuration', 3000),
    ev(285810, 'fade', 'FlashColor', 1, 1, 1, 1),
    ev(288810, 'fade', 'End'),
    ev(288810, 'liquid', 'End'),
    ev(288810, 'endimg', 'InitAndBegin'),
    ev(288810, 'flash', 'Init'),
    ev(288810, 'flash', 'FlashDuration', 2000),
    ev(298810, 'fade', 'InitAndBegin'),
    ev(298810, 'fade', 'FlashFadeDirection', 1),
    ev(298810, 'fade', 'FlashColor', 0, 0, 0, 1),
    ev(298810, 'fade', 'FlashDuration', 4000),
    ev(305000, '', 'StopDemo'),
  ];
}

/**
 * C# List.Sort is unstable, so same-time events could fire in any order there;
 * we keep source order (stable sort), which is what the authors evidently intended.
 */
export function buildEvents() {
  return [
    ...introEvents(),
    ...clawsEvents(),
    ...tunnelAndWavesEvents(),
    ...greetingsEvents(),
    ...robotAndFinaleEvents(),
  ];
}
