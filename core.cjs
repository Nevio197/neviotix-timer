'use strict';

const MAX_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_DESIGN = Object.freeze({
  theme: 'minimal', accent: '#b7ff5b', fontSize: 64,
  showLabel: true, label: 'LIVE IN', showProgress: true,
});
const PRESETS = Object.freeze([1, 3, 5, 10, 15].map(n => ({ label: `${n} Min.`, seconds: n * 60 })));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function requireObject(value, label = 'Einstellung') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} ist ungültig.`);
  return value;
}
function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} muss eine Zahl sein.`);
  return value;
}
function text(value, max, name) {
  if (typeof value !== 'string' || value.length > max) throw new TypeError(`${name} ist ungültig.`);
  return value.trim();
}
function bool(value, name) {
  if (typeof value !== 'boolean') throw new TypeError(`${name} muss an oder aus sein.`);
  return value;
}
function knownKeys(patch, allowed) {
  requireObject(patch);
  if (Object.keys(patch).some(key => !allowed.includes(key))) throw new TypeError('Unbekannte Einstellung.');
}
function validateDesign(patch, current = DEFAULT_DESIGN) {
  knownKeys(patch, Object.keys(DEFAULT_DESIGN));
  const next = { ...current };
  if ('theme' in patch) {
    if (!['minimal', 'neon', 'glass'].includes(patch.theme)) throw new TypeError('Unbekannter Look.');
    next.theme = patch.theme;
  }
  if ('accent' in patch) {
    if (typeof patch.accent !== 'string' || !/^#[a-f\d]{6}$/i.test(patch.accent)) throw new TypeError('Die Farbe ist ungültig.');
    next.accent = patch.accent.toLowerCase();
  }
  if ('fontSize' in patch) {
    const size = finite(patch.fontSize, 'Schriftgröße');
    if (size < 16 || size > 180) throw new RangeError('Schriftgröße: 16 bis 180.');
    next.fontSize = Math.round(size);
  }
  for (const key of ['showLabel', 'showProgress']) if (key in patch) next[key] = bool(patch[key], key);
  if ('label' in patch) next.label = text(patch.label, 80, 'Beschriftung');
  return next;
}
function validateOptions(patch, current) {
  knownKeys(patch, ['overtime', 'finishMessage', 'visible']);
  const next = { ...current };
  for (const key of ['overtime', 'visible']) if (key in patch) next[key] = bool(patch[key], key);
  if ('finishMessage' in patch) next.finishMessage = text(patch.finishMessage, 120, 'Endnachricht');
  return next;
}
function validateAutomation(patch, current = { finishScene: '', autoStartScene: '' }) {
  knownKeys(patch, ['finishScene', 'autoStartScene']);
  const next = { ...current };
  for (const key of ['finishScene', 'autoStartScene']) if (key in patch) next[key] = text(patch[key], 256, 'Szene');
  return next;
}
function nextClockTime(time, now) {
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new TypeError('Uhrzeit: HH:MM.');
  const [hours, minutes] = time.split(':').map(Number);
  const date = new Date(now);
  date.setHours(hours, minutes, 0, 0);
  if (date.getTime() <= now) date.setDate(date.getDate() + 1);
  return date.getTime();
}
function formatTime(ms) {
  const seconds = Math.ceil(Math.abs(ms) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const digits = hours ? [hours, minutes, remainder] : [minutes, remainder];
  return (ms < 0 ? '−' : '') + digits.map(n => String(n).padStart(2, '0')).join(':');
}

class TimerCore {
  constructor({ now = Date.now, saved = {}, onFinish = () => {} } = {}) {
    this.now = now;
    this.onFinish = onFinish;
    this.durationMs = 5 * 60 * 1000;
    this.storedRemainingMs = this.durationMs;
    this.mode = 'duration';
    this.targetTime = '20:00';
    this.visible = true;
    this.finished = false;
    this.overtime = false;
    this.finishMessage = '';
    this.design = { ...DEFAULT_DESIGN };
    this.automation = { finishScene: '', autoStartScene: '' };
    this.running = false;
    this.deadline = null;
    this.clockArmed = false;
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) this.restore(saved);
  }

  restore(saved) {
    if (Number.isFinite(saved.durationMs)) this.durationMs = clamp(Math.round(saved.durationMs), 0, MAX_MS);
    if (saved.mode === 'clock' || saved.mode === 'duration') this.mode = saved.mode;
    if (typeof saved.targetTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(saved.targetTime)) this.targetTime = saved.targetTime;
    for (const key of ['visible', 'overtime', 'finished']) if (typeof saved[key] === 'boolean') this[key] = saved[key];
    if (typeof saved.finishMessage === 'string') this.finishMessage = saved.finishMessage.trim().slice(0, 120);
    try { if (saved.design) this.design = validateDesign(saved.design); } catch { /* Keep safe defaults for an obsolete preset. */ }
    try { if (saved.automation) this.automation = validateAutomation(saved.automation); } catch { /* Keep automation disabled. */ }
    this.storedRemainingMs = Number.isFinite(saved.remainingMs)
      ? clamp(Math.round(saved.remainingMs), this.overtime ? -MAX_MS : 0, MAX_MS)
      : this.durationMs;
    this.running = false;
    this.deadline = null;
    // A restart restores the saved remaining time, never an unattended running clock.
    this.clockArmed = false;
  }

  remaining(now = this.now()) {
    return this.running ? Math.max(-MAX_MS, this.deadline - now) : this.storedRemainingMs;
  }

  tick(now = this.now()) {
    const remaining = this.remaining(now);
    if (this.running && remaining <= 0) {
      const newlyFinished = !this.finished;
      this.finished = true;
      if (!this.overtime) {
        this.storedRemainingMs = 0;
        this.running = false;
        this.deadline = null;
      }
      if (newlyFinished) this.onFinish();
    }
    return this.remaining(now);
  }

  reset(now = this.now()) {
    this.running = false;
    this.deadline = null;
    this.finished = false;
    if (this.mode === 'clock') {
      this.durationMs = nextClockTime(this.targetTime, now) - now;
      this.clockArmed = true;
    }
    this.storedRemainingMs = this.durationMs;
  }

  play(now = this.now()) {
    this.tick(now);
    if (this.running) return;
    if (this.mode === 'clock' && this.clockArmed) {
      this.durationMs = nextClockTime(this.targetTime, now) - now;
      this.storedRemainingMs = this.durationMs;
      this.clockArmed = false;
    } else if (this.storedRemainingMs <= 0 && !this.overtime) {
      this.reset(now);
      this.clockArmed = false;
    }
    this.deadline = now + this.storedRemainingMs;
    this.running = true;
    this.tick(now);
  }

  pause(now = this.now()) {
    this.tick(now);
    if (!this.running) return;
    this.storedRemainingMs = this.remaining(now);
    this.running = false;
    this.deadline = null;
  }

  action(input) {
    requireObject(input, 'Befehl');
    const now = this.now();
    this.tick(now);
    switch (input.action) {
      case 'set_duration': {
        const seconds = finite(input.seconds, 'Dauer');
        if (seconds < 0 || seconds * 1000 > MAX_MS) throw new RangeError('Dauer: maximal 7 Tage.');
        this.mode = 'duration';
        this.durationMs = Math.round(seconds * 1000);
        this.clockArmed = false;
        this.reset(now);
        break;
      }
      case 'set_clock':
        nextClockTime(input.time, now);
        this.targetTime = input.time;
        this.mode = 'clock';
        this.reset(now);
        break;
      case 'play': this.play(now); break;
      case 'pause': this.pause(now); break;
      case 'toggle': this.running ? this.pause(now) : this.play(now); break;
      case 'reset': this.reset(now); break;
      case 'adjust': {
        const delta = finite(input.seconds, 'Zeitänderung') * 1000;
        if (Math.abs(delta) > MAX_MS) throw new RangeError('Zeitänderung: maximal 7 Tage.');
        const left = clamp(this.remaining(now) + delta, this.overtime ? -MAX_MS : 0, MAX_MS);
        this.storedRemainingMs = left;
        if (left > 0) this.finished = false;
        if (this.running) this.deadline = now + left;
        this.clockArmed = false;
        this.tick(now);
        break;
      }
      case 'design': this.design = validateDesign(input.patch, this.design); break;
      case 'options': {
        const options = validateOptions(input.patch, this);
        for (const key of ['overtime', 'finishMessage', 'visible']) this[key] = options[key];
        if (!this.overtime && this.remaining(now) < 0) {
          this.storedRemainingMs = 0;
          if (this.running) this.deadline = now;
        }
        this.tick(now);
        break;
      }
      case 'automation': this.automation = validateAutomation(input.patch, this.automation); break;
      default: throw new TypeError('Unbekannter Befehl.');
    }
    return this.snapshot();
  }

  snapshot(now = this.now()) {
    const remainingMs = Math.round(this.tick(now));
    return {
      running: this.running, remainingMs, durationMs: this.durationMs,
      displayText: formatTime(remainingMs),
      progress: this.durationMs > 0 ? clamp(remainingMs / this.durationMs, 0, 1) : 0,
      mode: this.mode, targetTime: this.targetTime, visible: this.visible,
      finished: this.finished, overtime: this.overtime, finishMessage: this.finishMessage,
      design: { ...this.design }, automation: { ...this.automation },
      presets: PRESETS.map(preset => ({ ...preset })),
    };
  }

  exportState() {
    const state = this.snapshot();
    delete state.displayText;
    delete state.progress;
    delete state.presets;
    return { schemaVersion: 1, ...state, savedAt: this.now() };
  }
}

module.exports = { TimerCore, MAX_MS, formatTime, nextClockTime, validateDesign, validateOptions, validateAutomation };
