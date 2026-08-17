#!/usr/bin/env node
/*
 * Loading screen tests.
 *
 * Same convention as tests/card_darts.test.js and tests/cardpong.test.js:
 * the app is a single index.html (no bundler, no framework). This file
 * extracts the inline <script> block, runs it in a Node vm sandbox with
 * minimal DOM/localStorage/navigator stubs, reads the exposed
 * `window.LoadingScreenEngine` API, and exercises the pure timing
 * functions directly (no real timers, no real DOM) plus a UI smoke test
 * of renderLoading() itself.
 *
 * The loading screen shows one pre-composed background image
 * (assets/loading/ls-bg.png) full-bleed, plus a native (never
 * image-baked) progress bar/percentage and a decorative glow pulse.
 * There is no suit-pulse sequence or lantern/vine layout anymore (that
 * was the earlier, overlapping-composite version) — kept minimal on
 * purpose.
 *
 * Run: node tests/loading-screen.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');

function loadEngine(){
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if(!m) throw new Error('Could not find <script> block in index.html');
  const src = m[1];

  const fakeEl = {
    innerHTML: '',
    clientWidth: 380,
    clientHeight: 700,
    addEventListener(){},
    insertAdjacentHTML(){},
    getElementById(){ return fakeEl; }
  };
  const store = new Map();
  const sandbox = {
    console,
    Math, Date, JSON, Array, Object, Set, Map,
    document: {
      getElementById: ()=>fakeEl,
      addEventListener(){}
    },
    localStorage: {
      getItem:(k)=> store.has(k) ? store.get(k) : null,
      setItem:(k,v)=> store.set(k, String(v)),
      removeItem:(k)=> store.delete(k)
    },
    navigator: {},
    speechSynthesis: { getVoices:()=>[], speak(){}, cancel(){} },
    SpeechSynthesisUtterance: function(){},
    AudioContext: undefined,
    webkitAudioContext: undefined,
    setTimeout, clearTimeout, setInterval, clearInterval,
    scrollTo(){},
    addEventListener(){},
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'index.html-inline-script.js' });

  const LS = sandbox.LoadingScreenEngine;
  if(!LS) throw new Error('window.LoadingScreenEngine was not exposed by index.html');
  return { LS, sandbox, fakeEl };
}

/* ---------- test runner ---------- */
let passed = 0, failed = 0;
function test(name, fn){
  try{ fn(); console.log('  ok  -', name); passed++; }
  catch(e){ console.log('  FAIL -', name, '\n       ', e.message); failed++; }
}
function section(name){ console.log('\n' + name); }

const { LS, sandbox } = loadEngine();
// Small helper to execute further statements in the SAME vm context, so they
// can see the script's top-level `let`/`const` bindings (roster, state,
// timers, render, renderLoading, ...) which are not copied onto `sandbox`
// itself (only `window.LoadingScreenEngine` was deliberately exposed).
// Same convention as tests/card_darts.test.js.
function run(code){ return vm.runInContext(code, sandbox); }

const { LS_CONFIG, lsProgressPercent, lsIsComplete, lsPhaseDelay } = LS;

section('Config sanity');
test('total/hold/tick/glow durations are positive numbers', ()=>{
  assert.ok(LS_CONFIG.totalMs > 0);
  assert.ok(LS_CONFIG.holdMs >= 0);
  assert.ok(LS_CONFIG.tickMs > 0);
  assert.ok(LS_CONFIG.glowMs > 0);
});

section('Progress percentage (deterministic, native — never image-based)');
test('0ms elapsed -> 0%', ()=>{
  assert.strictEqual(lsProgressPercent(0, 1700), 0);
});
test('halfway elapsed -> ~50%', ()=>{
  assert.strictEqual(lsProgressPercent(850, 1700), 50);
});
test('full duration elapsed -> 100%', ()=>{
  assert.strictEqual(lsProgressPercent(1700, 1700), 100);
});
test('overshoot elapsed is clamped to 100%, never exceeds', ()=>{
  assert.strictEqual(lsProgressPercent(50000, 1700), 100);
});
test('monotonically non-decreasing as elapsed time increases', ()=>{
  let prev = -1;
  for(let t=0; t<=2000; t+=17){
    const pct = lsProgressPercent(t, 1700);
    assert.ok(pct >= prev, `pct went backwards at t=${t}`);
    assert.ok(pct >= 0 && pct <= 100, `pct out of range at t=${t}: ${pct}`);
    prev = pct;
  }
});

section('Completion / hand-off timing');
test('not complete before totalMs+holdMs', ()=>{
  assert.strictEqual(lsIsComplete(LS_CONFIG.totalMs, LS_CONFIG.totalMs, LS_CONFIG.holdMs), false);
});
test('complete exactly at totalMs+holdMs', ()=>{
  assert.strictEqual(lsIsComplete(LS_CONFIG.totalMs+LS_CONFIG.holdMs, LS_CONFIG.totalMs, LS_CONFIG.holdMs), true);
});
test('complete well after totalMs+holdMs', ()=>{
  assert.strictEqual(lsIsComplete(999999, LS_CONFIG.totalMs, LS_CONFIG.holdMs), true);
});

section('CSS phase-delay continuity helper (keeps the glow loop seamless across re-renders)');
test('delay is always <= 0 (never a positive/future delay)', ()=>{
  for(let t=0; t<10000; t+=137){
    assert.ok(lsPhaseDelay(t, 2600) <= 0);
  }
});
test('delay magnitude never exceeds the animation duration', ()=>{
  for(let t=0; t<10000; t+=137){
    const d = lsPhaseDelay(t, 2600);
    assert.ok(Math.abs(d) < 2600, `delay ${d} out of bounds at t=${t}`);
  }
});
test('does not crash with a zero/degenerate duration', ()=>{
  assert.strictEqual(lsPhaseDelay(100, 0), 0);
});

section('UI smoke test (real renderLoading(), not just pure functions)');
// NOTE: `state`/`roster`/`timers` are top-level `let` bindings inside the
// vm-executed script, not properties of `sandbox` — mutating/reading them
// has to happen via run()/vm.runInContext, exactly like tests/card_darts.test.js.
test('renderLoading() runs without throwing on first call (fresh state)', ()=>{
  run(`state = { screen: 'loading' }; roster = []; renderLoading();`);
  assert.ok(run('state.lsStart'), 'lsStart should be set on first render');
  assert.ok(run('typeof timers.ls !== "undefined"'), 'a tick timer should be scheduled');
  run('clearTimeout(timers.ls);');
});
test('renderLoading() renders the background image and a native progress bar, no leftover placeholders', ()=>{
  run(`state = { screen: 'loading', lsStart: Date.now() - 100 }; roster = [];`);
  run('renderLoading();');
  const html = run("document.getElementById('app').innerHTML");
  run('clearTimeout(timers.ls);');
  assert.ok(html.includes('ls-bg.png'), 'background image should be referenced');
  assert.ok(html.includes('ls-progress-fill'), 'progress bar fill should be rendered');
  assert.ok(html.includes('%'), 'a percentage should be rendered');
  assert.ok(!/undefined/.test(html), 'no undefined leaking into rendered markup');
});
test('renderLoading() does not crash even if the asset file is unreachable (no real network/FS in sandbox)', ()=>{
  // The sandbox has no real <img> loading at all (jsdom-free stub DOM), so this
  // exercises the same code path a browser would take with a 404'd asset:
  // renderLoading() only ever writes <img src="..."> markup, it never reads
  // pixel data or throws on a missing file.
  run(`state = { screen: 'loading', lsStart: Date.now() - 999999 }; roster = [];`);
  assert.doesNotThrow(()=> run('renderLoading(); clearTimeout(timers.ls);'));
});
test('after totalMs+holdMs, renderLoading() hands off to roster when roster is empty', ()=>{
  run(`roster = []; state = { screen:'loading', lsStart: Date.now() - (${LS_CONFIG.totalMs} + ${LS_CONFIG.holdMs} + 10) }; renderLoading();`);
  assert.strictEqual(run('state.screen'), 'roster');
});
test('after totalMs+holdMs, renderLoading() hands off to home when a roster already exists', ()=>{
  run(`roster = ['Tobi','Leo']; state = { screen:'loading', lsStart: Date.now() - (${LS_CONFIG.totalMs} + ${LS_CONFIG.holdMs} + 10) }; renderLoading();`);
  assert.strictEqual(run('state.screen'), 'home');
  run('if(timers && timers.hero) clearInterval(timers.hero);'); // renderHome() schedules its own carousel timer
});

console.log(`\n${passed} passed, ${failed} failed`);
if(failed>0) process.exit(1);
