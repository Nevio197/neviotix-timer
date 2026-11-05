'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TimerCore, MAX_MS, nextClockTime, formatTime } = require('./core.cjs');

function timer(start = 100000) {
  let time = start;
  let finishes = 0;
  const core = new TimerCore({ now: () => time, onFinish: () => finishes++ });
  return { core, advance(ms) { time += ms; core.tick(); }, get finishes() { return finishes; } };
}

test('deadline countdown remains accurate across delayed ticks', () => {
  const t = timer();
  t.core.action({ action: 'set_duration', seconds: 10 });
  t.core.action({ action: 'play' });
  t.advance(2400);
  assert.equal(t.core.snapshot().remainingMs, 7600);
  assert.equal(t.core.snapshot().displayText, '00:08');
  t.advance(5800);
  assert.equal(t.core.snapshot().remainingMs, 1800);
});

test('pause freezes remaining time and resume continues from that exact value', () => {
  const t = timer();
  t.core.action({ action: 'play' });
  t.advance(1234);
  t.core.action({ action: 'pause' });
  const paused = t.core.snapshot().remainingMs;
  t.advance(45000);
  assert.equal(t.core.snapshot().remainingMs, paused);
  t.core.action({ action: 'play' });
  t.advance(1000);
  assert.equal(t.core.snapshot().remainingMs, paused - 1000);
});

test('reset stops and uses configured duration rather than temporary extensions', () => {
  const t = timer();
  t.core.action({ action: 'play' });
  t.advance(3000);
  t.core.action({ action: 'adjust', seconds: 60 });
  assert.equal(t.core.snapshot().remainingMs, 357000);
  t.core.action({ action: 'reset' });
  assert.equal(t.core.snapshot().remainingMs, 300000);
  assert.equal(t.core.snapshot().running, false);
});

test('adjustment clamps to valid bounds and subtracting beyond zero finishes once', () => {
  const t = timer();
  t.core.action({ action: 'adjust', seconds: MAX_MS / 1000 });
  assert.equal(t.core.snapshot().remainingMs, MAX_MS);
  t.core.action({ action: 'set_duration', seconds: 10 });
  t.core.action({ action: 'play' });
  t.core.action({ action: 'adjust', seconds: -100 });
  assert.equal(t.core.snapshot().remainingMs, 0);
  assert.equal(t.core.snapshot().running, false);
  assert.equal(t.finishes, 1);
  t.advance(3000);
  assert.equal(t.finishes, 1);
});

test('normal timer stops at zero and only emits finish once', () => {
  const t = timer();
  t.core.action({ action: 'set_duration', seconds: 2 });
  t.core.action({ action: 'play' });
  t.advance(2500);
  assert.deepEqual([t.core.snapshot().displayText, t.core.snapshot().running, t.finishes], ['00:00', false, 1]);
  t.advance(3000);
  assert.equal(t.finishes, 1);
});

test('overtime continues negative, can pause, and stops when overtime is disabled', () => {
  const t = timer();
  t.core.action({ action: 'options', patch: { overtime: true } });
  t.core.action({ action: 'set_duration', seconds: 1 });
  t.core.action({ action: 'play' });
  t.advance(2300);
  assert.equal(t.core.snapshot().displayText, '−00:02');
  assert.equal(t.core.snapshot().running, true);
  assert.equal(t.finishes, 1);
  t.core.action({ action: 'pause' });
  t.advance(1000);
  assert.equal(t.core.snapshot().remainingMs, -1300);
  t.core.action({ action: 'play' });
  t.advance(1000);
  assert.equal(t.core.snapshot().remainingMs, -2300);
  t.core.action({ action: 'options', patch: { overtime: false } });
  assert.equal(t.core.snapshot().remainingMs, 0);
  assert.equal(t.core.snapshot().running, false);
});

test('clock target crosses midnight and initial play recalculates the actual target', () => {
  const now = new Date(2026, 10, 5, 23, 59, 30).getTime();
  const t = timer(now);
  assert.equal(nextClockTime('00:01', now) - now, 90000);
  t.core.action({ action: 'set_clock', time: '00:01' });
  t.advance(5000);
  t.core.action({ action: 'play' });
  assert.equal(t.core.snapshot().remainingMs, 85000);
});

test('saved running state restores paused without losing its remaining time', () => {
  const t = timer();
  t.core.action({ action: 'play' });
  t.advance(1200);
  const saved = t.core.exportState();
  assert.equal(saved.running, true);
  const restored = new TimerCore({ now: () => 99999999, saved });
  assert.equal(restored.snapshot().running, false);
  assert.equal(restored.snapshot().remainingMs, 298800);
});

test('invalid updates are rejected atomically and persisted presets cannot enable unknown actions', () => {
  const t = timer();
  const design = t.core.snapshot().design;
  assert.throws(() => t.core.action({ action: 'design', patch: { theme: 'neon', accent: 'url(evil)' } }));
  assert.deepEqual(t.core.snapshot().design, design);
  assert.throws(() => t.core.action({ action: 'set_duration', seconds: Infinity }));
  assert.throws(() => t.core.action({ action: 'set_duration', seconds: MAX_MS / 1000 + 1 }));
  assert.throws(() => t.core.action({ action: 'set_clock', time: '25:00' }));
  assert.throws(() => t.core.action({ action: 'options', patch: { visible: 'yes' } }));
  assert.throws(() => t.core.action({ action: 'automation', patch: { arbitrary: 'value' } }));
  const restored = new TimerCore({ saved: { design: { theme: 'external' }, automation: { unknown: 'on' } } });
  assert.equal(restored.snapshot().design.theme, 'minimal');
  assert.equal(restored.snapshot().automation.finishScene, '');
});

test('formatting uses ceiling seconds and retains hours for long timers', () => {
  assert.equal(formatTime(1), '00:01');
  assert.equal(formatTime(0), '00:00');
  assert.equal(formatTime(3661000), '01:01:01');
});
