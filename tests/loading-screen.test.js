#!/usr/bin/env node
/*
 * Loading screen tests.
 *
 * Same convention as tests/card_darts.test.js and tests/cardpong.test.js:
 * the app is a single index.html (no bundler, no framework). This file
 * extracts the inline <script> block, runs it in a Node vm sandbox with
 * minimal DOM/localStorage/navigator stubs, reads the exposed
 * `window.LoadingScreenEngine` API, and exercises the pure timing/layout
 * functions directly (no real timers, no real DOM) plus a UI smoke test
 * of renderLoading() itself.
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

const { LS_CONFIG, lsProgressPercent, lsActiveSuitIndex, lsIsComplete,
  lsPhaseDelay, lsLayoutRects, lsRectsOverlap } = LS;

section('Config sanity (matches animation_manifest.json)');
test('suit sequence matches manifest (heart, diamond, spade, club)', ()=>{
  // Array.from() normalizes away the vm-realm Array prototype mismatch
  // (LS_CONFIG.suits was created inside the sandbox's separate realm).
  assert.deepStrictEqual(Array.from(LS_CONFIG.suits), ['heart','diamond','spade','club']);
});
test('pulse duration matches manifest pulse_seconds (0.4s = 400ms)', ()=>{
  assert.strictEqual(LS_CONFIG.pulseMs, 400);
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

section('Suit pulse timing sequence (deterministic)');
test('sequence over one full cycle visits every suit exactly once, in manifest order', ()=>{
  const seen = [];
  for(let i=0;i<LS_CONFIG.suits.length;i++){
    const elapsed = i*LS_CONFIG.pulseMs + 1; // 1ms into each suit's window
    seen.push(LS_CONFIG.suits[lsActiveSuitIndex(elapsed, LS_CONFIG.pulseMs, LS_CONFIG.suits.length)]);
  }
  assert.deepStrictEqual(seen, ['heart','diamond','spade','club']);
});
test('sequence loops back to heart after a full cycle', ()=>{
  const cycle = LS_CONFIG.pulseMs*LS_CONFIG.suits.length;
  const idx = lsActiveSuitIndex(cycle + 1, LS_CONFIG.pulseMs, LS_CONFIG.suits.length);
  assert.strictEqual(LS_CONFIG.suits[idx], 'heart');
});
test('exactly one suit active at any given instant', ()=>{
  for(let t=0; t<3200; t+=13){
    const idx = lsActiveSuitIndex(t, LS_CONFIG.pulseMs, LS_CONFIG.suits.length);
    assert.ok(idx>=0 && idx<LS_CONFIG.suits.length);
  }
});
test('no crash / sane fallback with degenerate inputs (zero pulse, zero suits)', ()=>{
  assert.strictEqual(lsActiveSuitIndex(100, 0, 4), 0);
  assert.strictEqual(lsActiveSuitIndex(100, 400, 0), 0);
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

section('CSS phase-delay continuity helper (keeps loop animations seamless across re-renders)');
test('delay is always <= 0 (never a positive/future delay)', ()=>{
  for(let t=0; t<10000; t+=137){
    assert.ok(lsPhaseDelay(t, 2600, 0) <= 0);
  }
});
test('delay magnitude never exceeds the animation duration', ()=>{
  for(let t=0; t<10000; t+=137){
    const d = lsPhaseDelay(t, 2600, 300);
    assert.ok(Math.abs(d) < 2600, `delay ${d} out of bounds at t=${t}`);
  }
});
test('does not crash with a zero/degenerate duration', ()=>{
  assert.strictEqual(lsPhaseDelay(100, 0, 0), 0);
});

section('Layout — no overlap between decor and center content (programmatic check, rule: Überlappungsfreiheit)');
const viewports = [
  [320, 568],   // iPhone SE
  [390, 844],   // iPhone 12/13/14
  [430, 932],   // iPhone 14/15 Pro Max
  [768, 1024],  // iPad portrait
];
for(const [vw, vh] of viewports){
  test(`lantern/vines never overlap the center content column at ${vw}x${vh}`, ()=>{
    const r = lsLayoutRects(vw, vh);
    assert.ok(!lsRectsOverlap(r.lantern, r.center), `lantern overlaps center at ${vw}x${vh}`);
    assert.ok(!lsRectsOverlap(r.vineLeft, r.center), `vineLeft overlaps center at ${vw}x${vh}`);
    assert.ok(!lsRectsOverlap(r.vineRight, r.center), `vineRight overlaps center at ${vw}x${vh}`);
  });
  test(`left/right vines never overlap each other at ${vw}x${vh}`, ()=>{
    const r = lsLayoutRects(vw, vh);
    assert.ok(!lsRectsOverlap(r.vineLeft, r.vineRight), `vines overlap each other at ${vw}x${vh}`);
  });
}

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
test('renderLoading() does not crash even if asset files are unreachable (no real network/FS in sandbox)', ()=>{
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
