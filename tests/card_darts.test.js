#!/usr/bin/env node
/*
 * Card Darts engine tests.
 *
 * The app is a single index.html (no bundler, no existing test framework —
 * the only prior "testing convention" in this repo was `node --check` on the
 * extracted <script> block for syntax validation). This file extends that
 * exact approach: it extracts the same <script> block, runs it in a Node vm
 * sandbox with minimal DOM/localStorage/navigator stubs (the script touches
 * them once at load time), reads the exposed `window.CardDartsEngine` API,
 * and exercises the pure engine functions directly (no timers, no UI) to
 * verify the QA acceptance checklist in specs/07_QA_ACCEPTANCE.md.
 *
 * Run: node tests/card_darts.test.js
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
  sandbox.window = sandbox; // so `window === globalThis` for this context, like a browser
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'index.html-inline-script.js' });

  const CD = sandbox.CardDartsEngine;
  if(!CD) throw new Error('window.CardDartsEngine was not exposed by index.html');
  return { CD, sandbox, fakeEl };
}

/* ---------- helpers ---------- */

// Resolved (faceUp) hand cards are intentionally excluded here: the engine
// pushes them into g.discard the instant they resolve (see cdResolveReveal),
// even though the UI keeps rendering them face-up in the hand row until the
// player's turn visually ends. So "still in hand" only ever means the
// face-down, not-yet-revealed cards.
function collectTrackedCardIds(g){
  const ids = [];
  g.board.forEach(s=>{ if(s.card) ids.push(s.card.id); });
  g.reserve.forEach(c=>ids.push(c.id));
  g.discard.forEach(c=>ids.push(c.id));
  Object.values(g.hands).forEach(hand=>{
    hand.forEach(tc=>{ if(tc.status==='faceDown') ids.push(tc.card.id); });
  });
  return ids;
}
function assertCardIntegrity(g, label){
  const ids = collectTrackedCardIds(g);
  assert.strictEqual(ids.length, 52, `${label}: expected 52 tracked cards, got ${ids.length}`);
  assert.strictEqual(new Set(ids).size, 52, `${label}: duplicate card id detected among ${ids.length} tracked cards`);
  const onBoard = g.board.filter(s=>s.card).length;
  assert.strictEqual(onBoard, g.boardConfig.total, `${label}: board has ${onBoard} cards, expected ${g.boardConfig.total}`);
}
// Card-engine objects are created inside a separate vm realm, so their
// prototypes differ from plain object literals in this file even when the
// own-enumerable properties are identical; assert.deepStrictEqual treats
// that as unequal. Round-tripping through JSON normalizes both sides.
function toPlain(x){ return JSON.parse(JSON.stringify(x)); }

function simulateFullRound(CD, n, mode, seed){
  const names = Array.from({length:n}, (_,i)=>'P'+i);
  const g = CD.cdStartMatch({names, mode, matchLength:'quick', seed});
  assertCardIntegrity(g, `deal n=${n} mode=${mode} seed=${seed}`);
  let guard = 0;
  while(g.phase==='awaitingReveal'){
    if(guard++ > 500) throw new Error(`round did not terminate n=${n} mode=${mode} seed=${seed}`);
    const activeName = g.playerOrder[g.activePlayerIndex];
    const hand = g.hands[activeName];
    const idx = hand.findIndex(tc=>tc.status==='faceDown');
    if(idx===-1) throw new Error(`no faceDown card but phase still awaitingReveal (n=${n} mode=${mode} seed=${seed})`);
    CD.cdResolveReveal(g, activeName, hand[idx]);
    assertCardIntegrity(g, `reveal n=${n} mode=${mode} seed=${seed} guard=${guard}`);
    CD.cdAfterResolve(g);
  }
  return g;
}

/* ---------- test runner ---------- */
let passed = 0, failed = 0;
function test(name, fn){
  try{ fn(); passed++; console.log(`  ok  - ${name}`); }
  catch(e){ failed++; console.error(`FAIL  - ${name}`); console.error('       ' + e.message); }
}

const { CD, sandbox, fakeEl } = loadEngine();
// Small helper to execute further statements in the SAME vm context, so they
// can see the script's top-level `let`/`const` bindings (roster, state,
// render, cdStart, cdTapHand, renderDarts, ...) which are not copied onto
// `sandbox` itself (only `window.CardDartsEngine` was deliberately exposed).
function run(code){ return vm.runInContext(code, sandbox); }

console.log('Deck integrity');
test('buildDeck(52) has exactly 52 unique ids, no jokers', ()=>{
  const deck = CD.buildDeck(52);
  assert.strictEqual(deck.length, 52);
  assert.strictEqual(new Set(deck.map(c=>c.id)).size, 52);
  assert.ok(deck.every(c=>c.id>=0 && c.id<=51));
  assert.ok(deck.every(c=>['A','2','3','4','5','6','7','8','9','10','J','Q','K'].includes(c.rank)));
});
test('deal order: hands are dealt before board (deterministic under a fixed seed)', ()=>{
  const seed = 12345;
  const g = CD.cdStartMatch({names:['A','B','C'], mode:'classic', matchLength:'quick', seed});
  // Reproduce the exact same shuffle independently with a fresh RNG of the same seed.
  const rng2 = CD.cdMakeRng(seed);
  const expected = CD.cdShuffle(CD.buildDeck(52), rng2);
  const expectedHandIds = [];
  ['A','B','C'].forEach(()=>{ expectedHandIds.push(...expected.splice(0,3).map(c=>c.id)); });
  const expectedBoardIds = expected.splice(0, g.boardConfig.total).map(c=>c.id);

  const actualHandIds = [];
  g.playerOrder.forEach(nm=> actualHandIds.push(...g.hands[nm].map(tc=>tc.card.id)));
  const actualBoardIds = g.board.map(s=>s.card.id);

  assert.deepStrictEqual(actualHandIds, expectedHandIds, 'hands must be the first 3*N shuffled cards');
  assert.deepStrictEqual(actualBoardIds, expectedBoardIds, 'board must be dealt from what remains after hands');
});
test('no duplicate card id across hand/board/reserve/discard at deal time', ()=>{
  const g = CD.cdStartMatch({names:['A','B','C','D'], mode:'action', matchLength:'quick', seed:9});
  assertCardIntegrity(g, 'initial deal');
});

console.log('Board configuration');
test('board size matches the fixed table for every player count', ()=>{
  const expected = {2:15,3:15,4:18,5:18,6:21,7:21,8:24};
  Object.entries(expected).forEach(([n,total])=>{
    const cfg = CD.cdBoardConfigFor(Number(n));
    assert.strictEqual(cfg.total, total, `n=${n}`);
    assert.strictEqual(cfg.center, 1, `n=${n} center`);
  });
  assert.deepStrictEqual(toPlain(CD.cdBoardConfigFor(2)), {center:1,middle:5,outer:9,total:15});
  assert.deepStrictEqual(toPlain(CD.cdBoardConfigFor(3)), {center:1,middle:5,outer:9,total:15});
  assert.deepStrictEqual(toPlain(CD.cdBoardConfigFor(4)), {center:1,middle:6,outer:11,total:18});
  assert.deepStrictEqual(toPlain(CD.cdBoardConfigFor(5)), {center:1,middle:6,outer:11,total:18});
  assert.deepStrictEqual(toPlain(CD.cdBoardConfigFor(6)), {center:1,middle:7,outer:13,total:21});
  assert.deepStrictEqual(toPlain(CD.cdBoardConfigFor(7)), {center:1,middle:7,outer:13,total:21});
  assert.deepStrictEqual(toPlain(CD.cdBoardConfigFor(8)), {center:1,middle:8,outer:15,total:24});
});

console.log('Hit resolution');
function makeSlot(id,ring,idx,rank){
  const pts = {center:3,middle:2,outer:1}[ring];
  return {id, ring, indexWithinRing:idx, scoreValue:pts, card:{id:0,rank,suit:'♠',color:'black'}, blocked:false};
}
test('suit never affects a hit; center beats middle beats outer; blocked target falls through', ()=>{
  const g = { mode:'classic', board:[ makeSlot('c0','center',0,'7'), makeSlot('m0','middle',0,'7'), makeSlot('o0','outer',0,'7') ] };
  let t = CD.cdFindTarget(g, '7');
  assert.strictEqual(t.ring, 'center');
  t.blocked = true;
  t = CD.cdFindTarget(g, '7');
  assert.strictEqual(t.ring, 'middle');
  t.blocked = true;
  t = CD.cdFindTarget(g, '7');
  assert.strictEqual(t.ring, 'outer');
  t.blocked = true;
  t = CD.cdFindTarget(g, '7');
  assert.strictEqual(t, null, 'all copies blocked => MISS');
});
test('no matching rank on board => MISS', ()=>{
  const g = { mode:'classic', board:[ makeSlot('c0','center',0,'7') ] };
  assert.strictEqual(CD.cdFindTarget(g, 'K'), null);
});

console.log('Classic mode');
test('Classic hit blocks the target but keeps it on the board; round reset clears blocks and redeals', ()=>{
  // Standard (3 rounds) so the match genuinely reaches an interim 'roundSummary'
  // instead of jumping straight to matchResult/suddenDeath after round 1.
  const g = CD.cdStartMatch({names:['A','B'], mode:'classic', matchLength:'standard', seed:777});
  const activeName = g.playerOrder[g.activePlayerIndex];
  const before = g.board.map(s=>({id:s.id, cardId:s.card.id}));
  const hand = g.hands[activeName];
  CD.cdResolveReveal(g, activeName, hand[0]);
  CD.cdAfterResolve(g); // keep turnCardIndex in sync with the resolve above
  // Every slot's card identity is preserved (Classic never removes a card from the board).
  const after = g.board.map(s=>({id:s.id, cardId:s.card.id}));
  assert.deepStrictEqual(after, before, 'Classic hit must not move/remove any board card');
  if(hand[0].result==='hit'){
    const hitSlot = g.board.find(s=>s.id===hand[0].targetSlotId);
    assert.strictEqual(hitSlot.blocked, true, 'hit target must be blocked');
  }
  // Play out the rest of round 1, then confirm the interim summary + reset behavior.
  let guard=0;
  while(g.phase==='awaitingReveal'){
    if(guard++>200) throw new Error('round did not terminate');
    const nm = g.playerOrder[g.activePlayerIndex];
    const h = g.hands[nm];
    const idx = h.findIndex(tc=>tc.status==='faceDown');
    CD.cdResolveReveal(g, nm, h[idx]);
    CD.cdAfterResolve(g);
  }
  assert.strictEqual(g.phase, 'roundSummary', 'round 1 of 3 must end in an interim summary, not match result');
  g.activePlayerIndex = g.startPlayerIndex;
  CD.cdNewRoundDeal(g);
  assert.ok(g.board.every(s=>!s.blocked), 'all blocked states must reset between rounds');
  assert.strictEqual(g.board.filter(s=>s.card).length, g.boardConfig.total, 'board is freshly dealt each round');
});

console.log('Action mode');
function makeCard(id,rank){ return {id, rank, suit:'♠', color:'black'}; }
test('center hit: middle -> center, outer -> middle, reserve -> outer', ()=>{
  const g = {
    mode:'action', rng: CD.cdMakeRng(1),
    board:[
      {id:'c0',ring:'center',indexWithinRing:0,scoreValue:3,card:makeCard(0,'5'),blocked:false},
      {id:'m0',ring:'middle',indexWithinRing:0,scoreValue:2,card:makeCard(1,'6'),blocked:false},
      {id:'m1',ring:'middle',indexWithinRing:1,scoreValue:2,card:makeCard(2,'7'),blocked:false},
      {id:'o0',ring:'outer',indexWithinRing:0,scoreValue:1,card:makeCard(3,'8'),blocked:false},
      {id:'o1',ring:'outer',indexWithinRing:1,scoreValue:1,card:makeCard(4,'9'),blocked:false},
    ],
    reserve:[ makeCard(5,'10') ], discard: []
  };
  CD.cdActionRemoveAndRefill(g, g.board[0]);
  const idsOnBoard = g.board.map(s=>s.card.id);
  assert.strictEqual(new Set(idsOnBoard).size, 5, 'board stays full-size with unique cards');
  assert.ok(!idsOnBoard.includes(0), 'removed center card must leave the board');
  assert.ok(['6','7'].includes(g.board[0].card.rank), 'center must be refilled from a middle card');
  assert.strictEqual(g.discard.length, 1);
  assert.strictEqual(g.discard[0].id, 0);
  assert.strictEqual(g.reserve.length, 0, 'one reserve card must be drawn to the vacated outer slot');
});
test('middle hit: outer -> middle, reserve -> outer', ()=>{
  const g = {
    mode:'action', rng: CD.cdMakeRng(2),
    board:[
      {id:'m0',ring:'middle',indexWithinRing:0,scoreValue:2,card:makeCard(0,'6'),blocked:false},
      {id:'o0',ring:'outer',indexWithinRing:0,scoreValue:1,card:makeCard(1,'8'),blocked:false},
      {id:'o1',ring:'outer',indexWithinRing:1,scoreValue:1,card:makeCard(2,'9'),blocked:false},
    ],
    reserve:[ makeCard(3,'10') ], discard: []
  };
  CD.cdActionRemoveAndRefill(g, g.board[0]);
  const idsOnBoard = g.board.map(s=>s.card.id);
  assert.strictEqual(new Set(idsOnBoard).size, 3);
  assert.ok(!idsOnBoard.includes(0));
  assert.strictEqual(g.reserve.length, 0);
});
test('outer hit: reserve -> outer directly', ()=>{
  const g = {
    mode:'action', rng: CD.cdMakeRng(3),
    board:[ {id:'o0',ring:'outer',indexWithinRing:0,scoreValue:1,card:makeCard(0,'8'),blocked:false} ],
    reserve:[ makeCard(1,'10') ], discard: []
  };
  CD.cdActionRemoveAndRefill(g, g.board[0]);
  assert.strictEqual(g.board[0].card.id, 1);
  assert.strictEqual(g.discard[0].id, 0);
  assert.strictEqual(g.reserve.length, 0);
});
test('discard recycles into reserve when reserve is empty, board/hand cards excluded', ()=>{
  const g = {
    mode:'action', rng: CD.cdMakeRng(4),
    board:[ {id:'o0',ring:'outer',indexWithinRing:0,scoreValue:1,card:makeCard(0,'8'),blocked:false} ],
    reserve:[], discard:[ makeCard(9,'2'), makeCard(10,'3') ]
  };
  CD.cdActionRemoveAndRefill(g, g.board[0]);
  // The just-removed card (id 0) enters discard first, so the recycle pool is
  // [9,10,0] (3 cards): one is drawn back onto the board, 2 remain as the
  // fresh reserve, and discard ends up empty. No board/still-face-down-hand
  // card was ever part of that pool.
  assert.strictEqual(g.reserve.length, 2, 'reserve refilled from discard, minus the one just drawn');
  assert.strictEqual(g.discard.length, 0, 'discard pool was fully moved into reserve');
  const trackedIds = new Set([g.board[0].card.id, ...g.reserve.map(c=>c.id)]);
  assert.deepStrictEqual([...trackedIds].sort((a,b)=>a-b), [0,9,10], 'removed card + old discard are all accounted for exactly once');
});
test('Ace = TRIPLE and King = DOUBLE only in Action mode and only on a hit; Queen/Jack ordinary; Classic never multiplies', ()=>{
  const target = {scoreValue:1};
  const gAction = {mode:'action'};
  assert.strictEqual(CD.cdScoreFor(gAction, target, 'A'), 3);
  assert.strictEqual(CD.cdScoreFor(gAction, target, 'K'), 2);
  assert.strictEqual(CD.cdScoreFor(gAction, target, 'Q'), 1);
  assert.strictEqual(CD.cdScoreFor(gAction, target, 'J'), 1);
  assert.strictEqual(CD.cdEffectFor(gAction, 'A'), 'triple');
  assert.strictEqual(CD.cdEffectFor(gAction, 'K'), 'double');
  assert.strictEqual(CD.cdEffectFor(gAction, 'Q'), 'normal');
  const gClassic = {mode:'classic'};
  assert.strictEqual(CD.cdScoreFor(gClassic, target, 'A'), 1, 'Classic never multiplies');
  assert.strictEqual(CD.cdEffectFor(gClassic, 'A'), 'normal');
});
test('Ace/King with no available target => MISS, 0 points, no multiplier ever applied', ()=>{
  const g = { mode:'action', board:[], players:[{name:'X',totalScore:0,misses:0,hits:0,doubles:0,triples:0,centerHits:0,middleHits:0,outerHits:0,bestSingleReveal:0}], discard:[] };
  const tc = { card:{id:9,rank:'A'}, status:'faceDown' };
  const res = CD.cdResolveReveal(g, 'X', tc);
  assert.strictEqual(res.hit, false);
  assert.strictEqual(res.points, 0);
  assert.strictEqual(tc.effect, 'normal');
  assert.strictEqual(g.players[0].totalScore, 0);
});

console.log('Turn / round flow');
test('exactly 3 reveals per turn, then the turn advances to the next player', ()=>{
  const g = CD.cdStartMatch({names:['A','B'], mode:'classic', matchLength:'quick', seed:55});
  assert.strictEqual(g.activePlayerIndex, 0);
  for(let i=0;i<3;i++){
    const nm = g.playerOrder[g.activePlayerIndex];
    const h = g.hands[nm];
    const idx = h.findIndex(tc=>tc.status==='faceDown');
    CD.cdResolveReveal(g, nm, h[idx]);
    CD.cdAfterResolve(g);
  }
  assert.strictEqual(g.activePlayerIndex, 1, 'turn must advance to player B after exactly 3 reveals');
});
test('start player rotates one seat after each round; match length formulas are exact', ()=>{
  assert.strictEqual(CD.cdRoundsFor('quick', 5), 1);
  assert.strictEqual(CD.cdRoundsFor('standard', 5), 3);
  assert.strictEqual(CD.cdRoundsFor('long', 2), 4, 'Long must not be shorter than Standard for 2 players');
  assert.strictEqual(CD.cdRoundsFor('long', 6), 6);

  const g = CD.cdStartMatch({names:['A','B','C'], mode:'classic', matchLength:'standard', seed:42});
  let prevStart = g.startPlayerIndex;
  let guard=0;
  while(g.phase==='awaitingReveal' || g.phase==='roundSummary'){
    if(guard++>3000) throw new Error('match did not terminate');
    if(g.phase==='roundSummary'){
      const expectedStart = (prevStart+1)%3;
      assert.strictEqual(g.startPlayerIndex, expectedStart, 'start player must rotate by exactly one seat');
      prevStart = g.startPlayerIndex;
      g.activePlayerIndex = g.startPlayerIndex;
      CD.cdNewRoundDeal(g);
      continue;
    }
    const nm = g.playerOrder[g.activePlayerIndex];
    const h = g.hands[nm];
    const idx = h.findIndex(tc=>tc.status==='faceDown');
    CD.cdResolveReveal(g, nm, h[idx]);
    CD.cdAfterResolve(g);
  }
  assert.strictEqual(g.totalRounds, 3);
  assert.ok(g.phase==='matchResult' || g.phase==='suddenDeath');
});

console.log('Tie handling / Sudden Death');
test('only tied players enter Sudden Death; iterations narrow to a unique winner', ()=>{
  const g = CD.cdStartMatch({names:['A','B','C'], mode:'action', matchLength:'quick', seed:7});
  g.players[0].totalScore = 10; g.players[1].totalScore = 10; g.players[2].totalScore = 4;
  CD.cdEvaluateWinner(g);
  assert.strictEqual(g.phase, 'suddenDeath');
  assert.deepStrictEqual(g.suddenDeath.tiedNames.sort(), ['A','B'], 'only the tied players enter Sudden Death');

  let guard=0;
  while(!g.winner){
    if(guard++>300) throw new Error('Sudden Death did not converge');
    CD.cdSuddenDeathDeal(g);
    CD.cdSuddenDeathResolveAll(g);
  }
  assert.ok(['A','B'].includes(g.winner));
  assert.ok(guard<300, `terminated within ${guard} iterations`);
});

console.log('Regression / stress (deck integrity across many seeded rounds)');
test('1000 seeded rounds per player count (2-8) x mode (classic/action): board+deck invariants always hold', ()=>{
  const counts = [2,3,4,5,6,7,8];
  const modes = ['classic','action'];
  const ITER = 1000;
  let total = 0;
  const t0 = Date.now();
  counts.forEach(n=>{
    modes.forEach(mode=>{
      for(let i=0;i<ITER;i++){
        simulateFullRound(CD, n, mode, n*1000003 + (mode==='action'?500009:0) + i);
        total++;
      }
    });
  });
  console.log(`       (${total} simulated rounds across ${counts.length} player counts x ${modes.length} modes in ${Date.now()-t0}ms)`);
});

console.log('UI smoke test (real render functions, not just the pure engine)');
test('setup screen, live gameplay, round summary, sudden death and victory all render without throwing', ()=>{
  run(`
    roster.length = 0;
    ['Leroy','Adi','Leo','Max','Samu'].forEach(n=>roster.push(n));
  `);
  const setupHTML = run(`renderDartsSetup(); document.getElementById('app').innerHTML`);
  assert.ok(setupHTML.includes('CARD DARTS'), 'setup screen must render the game title');
  assert.ok(!setupHTML.includes('undefined'), 'setup screen must not leak "undefined" into markup');

  // Classic, 5 players, standard length -> drive the WHOLE match through the
  // real UI phase functions (bypassing only the setTimeout choreography,
  // which is pure animation pacing already covered by CD_CONFIG.timing).
  run(`
    state.cdMode = 'classic'; state.cdLength = 'standard';
    cdStart();
  `);
  let guard = 0;
  while(true){
    if(guard++ > 4000) throw new Error('UI smoke match did not terminate');
    const phase = run(`state.cd.phase`);
    if(phase==='awaitingReveal'){
      run(`
        (function(){
          var g = state.cd;
          var nm = g.playerOrder[g.activePlayerIndex];
          var h = g.hands[nm];
          var idx = h.findIndex(function(tc){ return tc.status==='faceDown'; });
          cdResolveReveal(g, nm, h[idx]);
          cdAfterResolve(g);
          renderDarts();
        })();
      `);
    } else if(phase==='roundSummary'){
      const html = run(`document.getElementById('app').innerHTML`);
      assert.ok(html.includes('ROUND COMPLETE'), 'round summary must render');
      run(`cdNextRound();`);
    } else if(phase==='suddenDeath'){
      const html1 = run(`document.getElementById('app').innerHTML`);
      assert.ok(html1.includes('SUDDEN DEATH'), 'sudden death screen must render');
      // Drive the engine steps directly (same functions cdSuddenDeathStep calls),
      // skipping only its setTimeout pacing so the test stays deterministic and
      // doesn't leave a real pending timer running after this test completes.
      run(`
        cdSuddenDeathDeal(state.cd);
        cdSuddenDeathResolveAll(state.cd);
        state.cd.locked = false;
        renderDarts();
      `);
    } else if(phase==='matchResult'){
      const html = run(`document.getElementById('app').innerHTML`);
      assert.ok(html.includes('WINNER'), 'victory screen must render');
      assert.ok(!html.includes('undefined'), 'victory screen must not leak "undefined" into markup');
      break;
    } else {
      throw new Error('unexpected phase: '+phase);
    }
  }
});
test('Action mode renders through a full 8-player board (24 cards) without throwing', ()=>{
  run(`
    roster.length = 0;
    ['Leroy','Adi','Leo','Max','Samu','Tobi','Bocki','Bruno'].forEach(n=>roster.push(n));
    state.cdMode = 'action'; state.cdLength = 'quick';
    cdStart();
  `);
  assert.strictEqual(run(`state.cd.boardConfig.total`), 24);
  let guard = 0;
  while(run(`state.cd.phase`)==='awaitingReveal'){
    if(guard++ > 500) throw new Error('did not terminate');
    run(`
      (function(){
        var g = state.cd;
        var nm = g.playerOrder[g.activePlayerIndex];
        var h = g.hands[nm];
        var idx = h.findIndex(function(tc){ return tc.status==='faceDown'; });
        cdResolveReveal(g, nm, h[idx]);
        cdAfterResolve(g);
        renderDarts();
      })();
    `);
  }
  const finalHTML = run(`document.getElementById('app').innerHTML`);
  assert.ok(!finalHTML.includes('undefined'), 'final screen must not leak "undefined" into markup');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed>0 ? 1 : 0);
