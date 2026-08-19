import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginStartupHandoff,
  completeStartupHandoff,
  queryStartupHandoffTarget,
  startupHandoffDuration,
  STARTUP_HANDOFF_MAX_MS,
  STARTUP_HANDOFF_MIN_MS,
  STARTUP_SPLASH_BLACKOUT_MS,
  STARTUP_SPLASH_DURATION_MS,
  STARTUP_SPLASH_REVEAL_MS,
} from '../js/ui/startup-splash.js';
import { SUPPORT_MESSAGES, pickSupportMessage } from '../js/data/support-messages.js';

test('startup splash waits 1.5 seconds before blacking out around the character', async () => {
  const waits = [];
  const classes = new Set();
  const splash = { classList: { add: (name) => classes.add(name) } };
  const character = {};

  const result = await beginStartupHandoff(splash, {
    elapsedMs: 300,
    reducedMotion: false,
    wait: async (milliseconds) => { waits.push(milliseconds); },
    pin: () => character,
  });

  assert.deepEqual(waits, [
    STARTUP_SPLASH_DURATION_MS - 300,
    STARTUP_SPLASH_BLACKOUT_MS,
  ]);
  assert.equal(classes.has('is-handoff'), true);
  assert.equal(result, character);
});

test('reduced motion keeps the 1.5 second message but skips transition delays', async () => {
  const waits = [];
  const splash = { classList: { add() {} } };

  await beginStartupHandoff(splash, {
    elapsedMs: 0,
    reducedMotion: true,
    wait: async (milliseconds) => { waits.push(milliseconds); },
    pin: () => ({}),
  });

  assert.deepEqual(waits, [STARTUP_SPLASH_DURATION_MS]);
});

test('handoff target resolves to the destination view brand mark', () => {
  const brandTarget = {};
  const root = { querySelector: () => brandTarget };
  assert.equal(queryStartupHandoffTarget(root), brandTarget);

  root.querySelector = () => null;
  assert.equal(queryStartupHandoffTarget(root), null);
});

test('handoff travel stays slow but bounded across screen sizes', () => {
  const origin = { left: 600, top: 300, width: 46, height: 46 };
  assert.equal(startupHandoffDuration(origin, origin), STARTUP_HANDOFF_MIN_MS);
  assert.equal(
    startupHandoffDuration(origin, { left: -4000, top: -4000, width: 46, height: 46 }),
    STARTUP_HANDOFF_MAX_MS,
  );
});

test('handoff hides the destination until the moving character arrives', async () => {
  const waits = [];
  const characterClasses = new Set();
  const splashClasses = new Set();
  const character = {
    classList: { add: (name) => characterClasses.add(name) },
    getBoundingClientRect: () => ({ left: 600, top: 300, width: 46, height: 46 }),
    style: {
      setProperty(name, value) { this[name] = value; },
    },
  };
  const target = {
    getBoundingClientRect: () => ({ left: 100, top: 120, width: 46, height: 46 }),
    style: { visibility: 'visible' },
  };
  let removed = false;
  const splash = {
    classList: { add: (name) => splashClasses.add(name) },
    remove: () => { removed = true; },
  };

  await completeStartupHandoff(splash, character, target, {
    reducedMotion: false,
    wait: async (milliseconds) => {
      if (!waits.length) assert.equal(target.style.visibility, 'hidden');
      waits.push(milliseconds);
    },
  });

  assert.equal(characterClasses.has('is-travelling'), true);
  assert.equal(character.style.transform, 'translate(-500px, -180px) scale(1, 1)');
  assert.equal(target.style.visibility, 'visible');
  assert.equal(splashClasses.has('is-revealing'), true);
  assert.equal(waits.at(-1), STARTUP_SPLASH_REVEAL_MS);
  assert.equal(removed, true);
});

test('support message library contains exactly 20 unique sentences', () => {
  assert.equal(SUPPORT_MESSAGES.length, 20);
  assert.equal(new Set(SUPPORT_MESSAGES).size, 20);
  assert.equal(SUPPORT_MESSAGES.every((message) => message.trim().length > 0), true);
});

test('support message selection uses the supplied random position', () => {
  assert.equal(pickSupportMessage(() => 0), SUPPORT_MESSAGES[0]);
  assert.equal(pickSupportMessage(() => 0.999), SUPPORT_MESSAGES[19]);
});
