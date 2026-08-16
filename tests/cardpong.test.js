#!/usr/bin/env node
/*
 * CARDPONG engine tests.
 *
 * Same convention as tests/card_darts.test.js: the app is a single
 * index.html (no bundler, no framework). This file extracts the inline
 * <script> block, runs it in a Node vm sandbox with minimal DOM/
 * localStorage/navigator stubs, reads the exposed `window.CardPongEngine`
 * API, and exercises the pure engine functions directly (no timers, no UI)
 * against the acceptance checklist from the CARDPONG handoff package
 * (docs/02_CARDPONG_GAME_RULES.md, docs/03_CARDPONG_GAME_FLOW.md) and the
 * Claude Code master prompt's required test list.
 *
 * Run: node tests/cardpong.test.js
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

  const CP = sandbox.CardPongEngine;
  if(!CP) throw new Error('window.CardPongEngine was not exposed by index.html');
  return { CP, sandbox, fakeEl };
}

/* ---------- helpers ---------- */
function allTargetCards(g){
  return [...g.teams.red.targets, ...g.teams.blue.targets].map(t=>t.card);
}
function keyOf(c){ return c.rank+'|'+c.suit; }
function assertNoDuplicateTargets(g, label){
  const cards = allTargetCards(g);
  const ids = cards.map(c=>c.id);
  const keys = cards.map(keyOf);
  assert.strictEqual(new Set(ids).size, ids.length, `${label}: duplicate target card id`);
  assert.strictEqual(new Set(keys).size, keys.length, `${label}: duplicate target rank/suit (same physical card assigned twice)`);
}
// Deterministic test helper: force the next card an Action Pong team draws
// by pushing it onto the end of that team's deck (cpDrawReplacementAction
// pops from the end).
function forceNextDraw(team, card){ team.deck.push(card); }
function normalCardLike(rank, suit, color){ return { id:-1, rank, suit, color, suitName:null, value:0, isJoker:false }; }
const JOKER_CARD = { id:-2, rank:'JOKER', suit:null, color:null, suitName:null, value:-1, isJoker:true };
const ACE_CARD = { id:-3, rank:'A', suit:'♠', color:'black', suitName:'Pik', value:12, isJoker:false };
const KING_CARD = { id:-4, rank:'K', suit:'♠', color:'black', suitName:'Pik', value:11, isJoker:false };

/* ---------- test runner (supports plain and async test bodies) ---------- */
let passed = 0, failed = 0;
function test(name, fn){
  try{
    const r = fn();
    if(r && typeof r.then==='function'){
      return r.then(
        ()=>{ passed++; console.log(`  ok  - ${name}`); },
        (e)=>{ failed++; console.error(`FAIL  - ${name}`); console.error('       ' + e.message); }
      );
    }
    passed++; console.log(`  ok  - ${name}`);
  }
  catch(e){ failed++; console.error(`FAIL  - ${name}`); console.error('       ' + e.message); }
}
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

const { CP, sandbox } = loadEngine();
function run(code){ return vm.runInContext(code, sandbox); }

/* =========================================================
   DECK INTEGRITY
========================================================= */
console.log('Deck integrity');
test('buildDeck(32) has 32 unique cards, ranks 7-A, no jokers', ()=>{
  const deck = CP.buildDeck(32);
  assert.strictEqual(deck.length, 32);
  assert.strictEqual(new Set(deck.map(c=>c.id)).size, 32);
  assert.ok(deck.every(c=>['7','8','9','10','J','Q','K','A'].includes(c.rank)));
  assert.ok(deck.every(c=>!c.isJoker));
});
test('cpPersonalDeck: 34 cards (32 Skat + 2 Joker), all unique, no duplicate joker ids', ()=>{
  const rng = CP.cdMakeRng(42);
  const deck = CP.cpPersonalDeck(rng);
  assert.strictEqual(deck.length, 34);
  const jokers = deck.filter(c=>c.isJoker);
  assert.strictEqual(jokers.length, 2);
  assert.strictEqual(new Set(jokers.map(c=>c.id)).size, 2, 'the two jokers must have distinct ids');
  const normals = deck.filter(c=>!c.isJoker);
  assert.strictEqual(normals.length, 32);
  assert.strictEqual(new Set(normals.map(c=>c.id)).size, 32);
});
test('Quick Pong: 12 unique target cards, no overlap between teams', ()=>{
  const rng = CP.cdMakeRng(7);
  const targets = CP.cpBuildQuickTargets(rng);
  assert.strictEqual(targets.red.length, 6);
  assert.strictEqual(targets.blue.length, 6);
  const allCards = [...targets.red, ...targets.blue].map(t=>t.card);
  assert.strictEqual(new Set(allCards.map(keyOf)).size, 12, 'no duplicate rank/suit across both teams');
});
test('Action Pong: 20 unique target cards, no Ace/King, no overlap between teams', ()=>{
  const rng = CP.cdMakeRng(99);
  const targets = CP.cpBuildActionTargets(rng);
  assert.strictEqual(targets.red.length, 10);
  assert.strictEqual(targets.blue.length, 10);
  const allCards = [...targets.red, ...targets.blue].map(t=>t.card);
  assert.strictEqual(new Set(allCards.map(keyOf)).size, 20);
  assert.ok(allCards.every(c=>c.rank!=='A' && c.rank!=='K'), 'Ace/King must never appear in the target pyramids');
});

/* =========================================================
   QUICK PONG
========================================================= */
console.log('Quick Pong');
test('no duplicate target cards at start', ()=>{
  const g = CP.cpStartQuick({seed:1});
  assertNoDuplicateTargets(g, 'quick start');
});
test('a hit removes exactly one target card and nothing else', ()=>{
  const g = CP.cpStartQuick({seed:2});
  const before = allTargetCards(g).length;
  // Force a guaranteed hit: draw the shared deck until one matches an active target.
  let result;
  let guard = 0;
  while(g.drawDeck.length){
    if(guard++>64) throw new Error('no hit found within deck');
    result = CP.cpQuickDraw(g);
    if(result.type==='hit') break;
  }
  assert.strictEqual(result.type, 'hit');
  const activeAfter = allTargetCards(g).filter((c,i)=>{
    const t = [...g.teams.red.targets, ...g.teams.blue.targets][i];
    return t.active;
  }).length;
  assert.strictEqual(activeAfter, before-1, 'exactly one target must be removed');
});
test('a miss removes nothing', ()=>{
  const g = CP.cpStartQuick({seed:3});
  // Draw a card that cannot match any target: build one from a rank/suit not present.
  const targetKeys = new Set(allTargetCards(g).map(keyOf));
  const activeBefore = [...g.teams.red.targets, ...g.teams.blue.targets].filter(t=>t.active).length;
  // Find (or force) a genuine miss from the deck.
  let result, guard=0;
  const originalDeck = g.drawDeck.slice();
  while(g.drawDeck.length){
    if(guard++>64) break;
    const top = g.drawDeck[g.drawDeck.length-1];
    if(!targetKeys.has(keyOf(top))){ result = CP.cpQuickDraw(g); break; }
    g.drawDeck.pop(); // skip cards that would hit, just for this isolated test
  }
  assert.ok(result, 'expected to find a miss card in the deck');
  assert.strictEqual(result.type, 'miss');
  const activeAfter = [...g.teams.red.targets, ...g.teams.blue.targets].filter(t=>t.active).length;
  assert.strictEqual(activeAfter, activeBefore, 'miss must not remove any target');
});
test('last card ends the game immediately; no equalizer turn', ()=>{
  const g = CP.cpStartQuick({seed:4});
  // Force red down to 1 target, then hit it directly.
  g.teams.red.targets.slice(1).forEach(t=> t.active=false);
  const lastTarget = g.teams.red.targets.find(t=>t.active);
  g.drawDeck.push(lastTarget.card); // next pop() draws exactly this card
  const result = CP.cpQuickDraw(g);
  assert.strictEqual(result.type, 'hit');
  assert.strictEqual(g.winner, 'red');
  assert.strictEqual(g.phase, 'result');
  assert.strictEqual(g.teams.red.targets.filter(t=>t.active).length, 0);
});
test('Quick Pong has no individual player turns (no activeSide / current player concept)', ()=>{
  const g = CP.cpStartQuick({seed:5});
  assert.strictEqual(g.activeSide, undefined);
});
test('once a winner is set, further draws are no-ops (win can only trigger once)', ()=>{
  const g = CP.cpStartQuick({seed:6});
  g.winner = 'blue'; g.phase='result';
  const deckBefore = g.drawDeck.length;
  const result = CP.cpQuickDraw(g);
  assert.strictEqual(result, null);
  assert.strictEqual(g.drawDeck.length, deckBefore, 'deck must not be touched after the game already ended');
});
test('full random Quick Pong game terminates with exactly one winner and consistent cup counts', ()=>{
  for(let seed=1; seed<=15; seed++){
    const g = CP.cpStartQuick({seed});
    let guard=0;
    while(!g.winner){
      if(guard++>200) throw new Error('quick pong did not terminate seed='+seed);
      if(g.drawDeck.length===0 && g.discard.length===0) throw new Error('deck exhausted without winner seed='+seed);
      CP.cpQuickDraw(g);
    }
    assertNoDuplicateTargets(g, 'seed='+seed);
    const redLeft = g.teams.red.targets.filter(t=>t.active).length;
    const blueLeft = g.teams.blue.targets.filter(t=>t.active).length;
    assert.ok(redLeft===0 || blueLeft===0, 'winner must have 0 remaining targets, seed='+seed);
    assert.strictEqual(g.teams[g.winner].targets.filter(t=>t.active).length, 0);
  }
});

/* =========================================================
   ACTION PONG
========================================================= */
console.log('Action Pong');
test('each personal deck starts with 34 cards', ()=>{
  const g = CP.cpStartAction({seed:10});
  assert.strictEqual(g.teams.red.deck.length, 34);
  assert.strictEqual(g.teams.blue.deck.length, 34);
});
test('no duplicate target cards at start', ()=>{
  const g = CP.cpStartAction({seed:11});
  assertNoDuplicateTargets(g, 'action start');
});
test('random start side is either red or blue', ()=>{
  const sides = new Set();
  for(let seed=1; seed<=20; seed++) sides.add(CP.cpStartAction({seed}).activeSide);
  assert.ok(sides.has('red') || sides.has('blue'));
  assert.ok([...sides].every(s=>s==='red'||s==='blue'));
});
test('normal hit removes exactly the matching target, drink goes to the opponent side, streak increments, turn switches on the first hit', ()=>{
  const g = CP.cpStartAction({seed:12});
  const side = g.activeSide, other = CP.cpOther(side);
  const target = g.teams[side].targets[0];
  const card = normalCardLike(target.card.rank, target.card.suit, target.card.color);
  forceNextDraw(g.teams[side], card);
  const before = g.teams[side].targets.filter(t=>t.active).length;
  const result = CP.cpActionDraw(g);
  assert.strictEqual(result.type, 'hit');
  assert.strictEqual(target.active, false);
  assert.strictEqual(g.teams[side].targets.filter(t=>t.active).length, before-1);
  assert.strictEqual(result.drinkingSide, other, 'opponent (whose side the removed card sat on) must drink');
  assert.strictEqual(g.teams[side].streak, 1);
  assert.strictEqual(g.activeSide, other, 'first hit in a run switches turn normally');
});
test('miss removes nothing and switches turn', ()=>{
  const g = CP.cpStartAction({seed:13});
  const side = g.activeSide, other = CP.cpOther(side);
  const usedKeys = new Set(g.teams[side].targets.map(t=>keyOf(t.card)));
  // A card whose rank/suit is guaranteed not to be one of this team's targets.
  let missCard = null;
  for(const c of CP.buildDeck(32)){ if(!usedKeys.has(keyOf(c))){ missCard = c; break; } }
  assert.ok(missCard);
  forceNextDraw(g.teams[side], normalCardLike(missCard.rank, missCard.suit, missCard.color));
  const before = allTargetCards(g).filter((c,i)=>[...g.teams.red.targets,...g.teams.blue.targets][i].active).length;
  const result = CP.cpActionDraw(g);
  assert.strictEqual(result.type, 'miss');
  const after = [...g.teams.red.targets, ...g.teams.blue.targets].filter(t=>t.active).length;
  assert.strictEqual(after, before);
  assert.strictEqual(g.teams[side].streak, 0);
  assert.strictEqual(g.activeSide, other);
});
test('already-removed target (e.g. via Airball) counts as a miss when its matching card is later drawn, and cannot be removed twice', ()=>{
  const g = CP.cpStartAction({seed:14});
  const side = g.activeSide;
  const target = g.teams[side].targets[0];
  target.active = false; // simulate: already removed earlier via Airball
  const card = normalCardLike(target.card.rank, target.card.suit, target.card.color);
  forceNextDraw(g.teams[side], card);
  const result = CP.cpActionDraw(g);
  assert.strictEqual(result.type, 'miss');
  assert.strictEqual(target.active, false, 'still removed, not toggled back on');
});
test('King (Trickshot): no hit, no miss, streak unchanged, same player draws again', ()=>{
  const g = CP.cpStartAction({seed:15});
  const side = g.activeSide;
  g.teams[side].streak = 3;
  forceNextDraw(g.teams[side], KING_CARD);
  const result = CP.cpActionDraw(g);
  assert.strictEqual(result.type, 'trickshot');
  assert.strictEqual(g.teams[side].streak, 3, 'King must not touch the streak');
  assert.strictEqual(g.activeSide, side, 'King keeps the same active player');
});
test('Ace (Airball): with >1 opponent targets, requires target selection; drink goes to the active (drawing) side; turn switches only after resolution', ()=>{
  const g = CP.cpStartAction({seed:16});
  const side = g.activeSide, other = CP.cpOther(side);
  assert.ok(g.teams[other].targets.filter(t=>t.active).length > 1);
  forceNextDraw(g.teams[side], ACE_CARD);
  const result = CP.cpActionDraw(g);
  assert.strictEqual(result.type, 'airball-pending');
  assert.strictEqual(g.activeSide, side, 'turn must not switch yet, selection pending');
  assert.strictEqual(g.teams[side].streak, 0, 'airball ends the streak immediately');
  const opponentActiveBefore = g.teams[other].targets.filter(t=>t.active).length;
  const pickId = result.options[0];
  const res2 = CP.cpActionResolveAirball(g, pickId);
  assert.strictEqual(res2.type, 'airball-hit');
  assert.strictEqual(res2.drinkingSide, side, 'the active/attacking team drinks on Airball');
  assert.strictEqual(g.teams[other].targets.filter(t=>t.active).length, opponentActiveBefore-1);
  assert.strictEqual(g.activeSide, other, 'turn switches after the Airball selection is resolved');
});
test('Airball can never remove the opponent\'s last cup and can never end the game (Last-Cup-Airball protection)', ()=>{
  const g = CP.cpStartAction({seed:17});
  const side = g.activeSide, other = CP.cpOther(side);
  // Reduce the opponent down to exactly one active target.
  g.teams[other].targets.slice(1).forEach(t=> t.active=false);
  forceNextDraw(g.teams[side], ACE_CARD);
  const result = CP.cpActionDraw(g);
  assert.strictEqual(result.type, 'airball-safe', 'with exactly one opponent target left, no selection may be offered');
  assert.strictEqual(g.teams[other].targets.filter(t=>t.active).length, 1, 'the last cup must survive');
  assert.strictEqual(g.winner, null, 'Airball must never end the game');
  assert.strictEqual(g.activeSide, other, 'turn still switches after a safe airball');
});
test('cpActionResolveAirball defends the last cup even if called directly with a stale 2-card option', ()=>{
  const g = CP.cpStartAction({seed:18});
  const side = g.activeSide, other = CP.cpOther(side);
  const oppTargets = g.teams[other].targets.filter(t=>t.active);
  g.pendingAirball = { side };
  // Artificially shrink the opponent's live targets to 1 between offer and resolve.
  oppTargets.slice(1).forEach(t=> t.active=false);
  const res = CP.cpActionResolveAirball(g, oppTargets[0].card.id);
  assert.strictEqual(res.type, 'airball-safe');
  assert.strictEqual(g.winner, null);
});
test('Joker: first draw activates automatic defense and resets streak; cannot stack; a second Joker while active counts as Miss', ()=>{
  const g = CP.cpStartAction({seed:19});
  const side = g.activeSide, other = CP.cpOther(side);
  g.teams[side].streak = 2;
  forceNextDraw(g.teams[side], JOKER_CARD);
  const r1 = CP.cpActionDraw(g);
  assert.strictEqual(r1.type, 'joker-ready');
  assert.strictEqual(g.teams[side].jokerShield, true);
  assert.strictEqual(g.teams[side].streak, 0);
  assert.strictEqual(g.activeSide, other, 'joker draw switches turn');
  // Give the turn back to `side` and force a second Joker while shield is already active.
  g.activeSide = side;
  forceNextDraw(g.teams[side], { ...JOKER_CARD, id:-5 });
  const r2 = CP.cpActionDraw(g);
  assert.strictEqual(r2.type, 'joker-miss', 'a second Joker must not stack, counts as Miss instead');
  assert.strictEqual(g.teams[side].jokerShield, true, 'shield stays exactly as-is (still just one)');
});
test('Joker Defense automatically blocks the next regular opposing hit: target survives, nobody drinks, joker consumed, blocked card returns to the attacker\'s own deck and only that deck is reshuffled', ()=>{
  const g = CP.cpStartAction({seed:20});
  const attackerSide = g.activeSide, defenderSide = CP.cpOther(attackerSide);
  g.teams[defenderSide].jokerShield = true;
  const target = g.teams[attackerSide].targets[0];
  const card = normalCardLike(target.card.rank, target.card.suit, target.card.color);
  forceNextDraw(g.teams[attackerSide], card);
  const discardBefore = g.teams[attackerSide].discard.length;
  const result = CP.cpActionDraw(g);
  assert.strictEqual(result.type, 'blocked');
  assert.strictEqual(target.active, true, 'target must stay on the board');
  assert.strictEqual(g.teams[defenderSide].jokerShield, false, 'the shield is consumed');
  assert.strictEqual(g.teams[attackerSide].streak, 0, "attacker's streak ends");
  assert.strictEqual(g.teams[attackerSide].discard.length, discardBefore, 'blocked card must NOT go to the discard pile');
  assert.ok(g.teams[attackerSide].deck.some(c=>c.rank===card.rank && c.suit===card.suit), 'blocked card must return to the attacker\'s own draw deck');
  assert.strictEqual(g.activeSide, defenderSide, 'turn switches after a block');
});
test('Joker blocks neither Airball nor King nor a Miss; King never interrupts a streak', ()=>{
  const g = CP.cpStartAction({seed:21});
  const attackerSide = g.activeSide, defenderSide = CP.cpOther(attackerSide);
  g.teams[defenderSide].jokerShield = true;
  forceNextDraw(g.teams[attackerSide], ACE_CARD);
  const airballRes = CP.cpActionDraw(g);
  assert.ok(airballRes.type==='airball-pending' || airballRes.type==='airball-safe');
  assert.strictEqual(g.teams[defenderSide].jokerShield, true, 'joker must not intercept an Airball');
  if(g.pendingAirball){
    const opts = g.teams[CP.cpOther(attackerSide)].targets.filter(t=>t.active);
    CP.cpActionResolveAirball(g, opts[0].card.id); // resolve so the next draw isn't blocked by a pending selection
  }

  g.activeSide = attackerSide;
  g.teams[attackerSide].streak = 4;
  forceNextDraw(g.teams[attackerSide], KING_CARD);
  const kingRes = CP.cpActionDraw(g);
  assert.strictEqual(kingRes.type, 'trickshot');
  assert.strictEqual(g.teams[defenderSide].jokerShield, true, 'joker must not intercept a King');
  assert.strictEqual(g.teams[attackerSide].streak, 4, 'King never interrupts a streak');

  const usedKeys = new Set(g.teams[attackerSide].targets.map(t=>keyOf(t.card)));
  let missCard = null;
  for(const c of CP.buildDeck(32)){ if(!usedKeys.has(keyOf(c))){ missCard = c; break; } }
  forceNextDraw(g.teams[attackerSide], normalCardLike(missCard.rank, missCard.suit, missCard.color));
  const missRes = CP.cpActionDraw(g);
  assert.strictEqual(missRes.type, 'miss');
  assert.strictEqual(g.teams[defenderSide].jokerShield, true, 'joker must not intercept a plain Miss');
});
test('Balls Back: two consecutive hits by the same team (opponent turns in between are irrelevant) trigger a bonus draw; every further hit in the run grants another', ()=>{
  const g = CP.cpStartAction({seed:22});
  const side = g.activeSide, other = CP.cpOther(side);
  function hitOnce(forSide){
    const target = g.teams[forSide].targets.find(t=>t.active);
    forceNextDraw(g.teams[forSide], normalCardLike(target.card.rank, target.card.suit, target.card.color));
    return CP.cpActionDraw(g);
  }
  const r1 = hitOnce(side);
  assert.strictEqual(r1.ballsBack, false);
  assert.strictEqual(g.activeSide, other, 'first hit switches turn normally');
  // Opponent's turn happens (irrelevant to our streak) — give the turn back.
  g.activeSide = side;
  const r2 = hitOnce(side);
  assert.strictEqual(r2.ballsBack, true, 'second consecutive hit triggers Balls Back');
  assert.strictEqual(g.activeSide, side, 'Balls Back keeps the same player at the table');
  const r3 = hitOnce(side);
  assert.strictEqual(r3.ballsBack, true, 'every further hit in the run grants another bonus draw');
  assert.strictEqual(g.activeSide, side);
});
test('Miss / Airball / Joker-draw / second-Joker / Block all reset the streak', ()=>{
  const scenarios = [
    ()=>{ const g = CP.cpStartAction({seed:30}); const s=g.activeSide; g.teams[s].streak=3;
      const uk=new Set(g.teams[s].targets.map(t=>keyOf(t.card))); let mc=null;
      for(const c of CP.buildDeck(32)){ if(!uk.has(keyOf(c))){ mc=c; break; } }
      forceNextDraw(g.teams[s], normalCardLike(mc.rank,mc.suit,mc.color)); CP.cpActionDraw(g);
      return g.teams[s].streak; },
    ()=>{ const g = CP.cpStartAction({seed:31}); const s=g.activeSide; g.teams[s].streak=3;
      forceNextDraw(g.teams[s], ACE_CARD); CP.cpActionDraw(g); return g.teams[s].streak; },
    ()=>{ const g = CP.cpStartAction({seed:32}); const s=g.activeSide; g.teams[s].streak=3;
      forceNextDraw(g.teams[s], JOKER_CARD); CP.cpActionDraw(g); return g.teams[s].streak; },
    ()=>{ const g = CP.cpStartAction({seed:33}); const s=g.activeSide, o=CP.cpOther(s); g.teams[s].streak=3;
      g.teams[s].jokerShield = true; forceNextDraw(g.teams[s], {...JOKER_CARD,id:-9}); CP.cpActionDraw(g); return g.teams[s].streak; },
    ()=>{ const g = CP.cpStartAction({seed:34}); const s=g.activeSide, o=CP.cpOther(s); g.teams[s].streak=3;
      g.teams[o].jokerShield = true; const t=g.teams[s].targets[0];
      forceNextDraw(g.teams[s], normalCardLike(t.card.rank,t.card.suit,t.card.color)); CP.cpActionDraw(g); return g.teams[s].streak; },
  ];
  scenarios.forEach((fn,i)=> assert.strictEqual(fn(), 0, `scenario ${i} must reset streak to 0`));
});
test('win can only be triggered once; last target must be removed by a genuine unblocked hit, not by Airball', ()=>{
  const g = CP.cpStartAction({seed:23});
  const side = g.activeSide;
  g.teams[side].targets.slice(1).forEach(t=> t.active=false);
  const last = g.teams[side].targets.find(t=>t.active);
  forceNextDraw(g.teams[side], normalCardLike(last.card.rank, last.card.suit, last.card.color));
  const result = CP.cpActionDraw(g);
  assert.strictEqual(result.type, 'hit');
  assert.strictEqual(g.winner, side);
  assert.strictEqual(g.phase, 'result');
  const again = CP.cpActionDraw(g);
  assert.strictEqual(again, null, 'no further draws must be possible once a winner exists');
});
test('a card blocked by Joker Defense returning to the attacker\'s deck can be drawn and resolved again normally later', ()=>{
  const g = CP.cpStartAction({seed:24});
  const attackerSide = g.activeSide, defenderSide = CP.cpOther(attackerSide);
  g.teams[defenderSide].jokerShield = true;
  const target = g.teams[attackerSide].targets[0];
  const card = normalCardLike(target.card.rank, target.card.suit, target.card.color);
  forceNextDraw(g.teams[attackerSide], card);
  CP.cpActionDraw(g); // blocked; card returns to attacker's own (reshuffled) deck
  assert.strictEqual(target.active, true);
  g.activeSide = attackerSide;
  // Force the very same rank/suit to the top again — this time no shield.
  forceNextDraw(g.teams[attackerSide], normalCardLike(target.card.rank, target.card.suit, target.card.color));
  const result2 = CP.cpActionDraw(g);
  assert.strictEqual(result2.type, 'hit');
  assert.strictEqual(target.active, false);
});
test('full random Action Pong game terminates with exactly one winner, no duplicate/negative counts', ()=>{
  for(let seed=1; seed<=25; seed++){
    const g = CP.cpStartAction({seed});
    let guard = 0;
    while(!g.winner){
      if(guard++>2000) throw new Error('action pong did not terminate seed='+seed);
      if(g.pendingAirball){
        const opp = CP.cpOther(g.pendingAirball.side);
        const opts = g.teams[opp].targets.filter(t=>t.active);
        CP.cpActionResolveAirball(g, opts[0].card.id);
      } else {
        CP.cpActionDraw(g);
      }
      assertNoDuplicateTargets(g, `mid-game seed=${seed} guard=${guard}`);
      assert.ok(g.teams.red.deck.length>=0 && g.teams.blue.deck.length>=0);
    }
    const redLeft = g.teams.red.targets.filter(t=>t.active).length;
    const blueLeft = g.teams.blue.targets.filter(t=>t.active).length;
    assert.ok(redLeft===0 || blueLeft===0, 'seed='+seed);
    assert.strictEqual(g.teams[g.winner].targets.filter(t=>t.active).length, 0);
  }
});

/* =========================================================
   REMATCH
========================================================= */
console.log('Rematch');
test('Quick Pong rematch (fresh cpStartQuick) fully resets targets, deck, discard and winner', ()=>{
  const g = CP.cpStartQuick({seed:40});
  let guard=0;
  while(!g.winner){ if(guard++>200) throw new Error('did not terminate'); CP.cpQuickDraw(g); }
  const fresh = CP.cpStartQuick({seed: g.seed+1});
  assert.strictEqual(fresh.winner, null);
  assert.strictEqual(fresh.phase, 'active');
  assert.strictEqual(fresh.teams.red.targets.filter(t=>t.active).length, 6);
  assert.strictEqual(fresh.teams.blue.targets.filter(t=>t.active).length, 6);
  assert.strictEqual(fresh.drawDeck.length, 32);
  assert.strictEqual(fresh.discard.length, 0);
});
test('Action Pong rematch (fresh cpStartAction) fully resets teams, decks, jokers, streaks and winner', ()=>{
  const g = CP.cpStartAction({seed:41});
  g.teams.red.jokerShield = true; g.teams.red.streak = 5; g.winner='red'; g.phase='result';
  const fresh = CP.cpStartAction({seed: 999});
  assert.strictEqual(fresh.winner, null);
  assert.strictEqual(fresh.phase, 'active');
  assert.strictEqual(fresh.teams.red.jokerShield, false);
  assert.strictEqual(fresh.teams.blue.jokerShield, false);
  assert.strictEqual(fresh.teams.red.streak, 0);
  assert.strictEqual(fresh.teams.blue.streak, 0);
  assert.strictEqual(fresh.teams.red.deck.length, 34);
  assert.strictEqual(fresh.teams.blue.deck.length, 34);
  assert.strictEqual(fresh.teams.red.targets.filter(t=>t.active).length, 10);
  assert.strictEqual(fresh.teams.blue.targets.filter(t=>t.active).length, 10);
});

/* =========================================================
   UI INTEGRATION — via the real in-page functions (through the shared vm
   context), exercising the router, home-tile navigation, DRAW-button
   double-tap guard, and that no screen leaks "undefined" into markup.
========================================================= */
console.log('UI integration');
test('GAMES entry and router wire CARDPONG consistently (home tile -> setup -> live board)', ()=>{
  run(`
    roster.length = 0; ['Rot1','Blau1'].forEach(n=>roster.push(n));
    reset('home');
  `);
  const gameEntry = run(`GAMES.find(g=>g.key==='cp')`);
  assert.strictEqual(gameEntry.screen, 'cardpong-setup');
  run(`openGame('${gameEntry.screen}')`);
  assert.strictEqual(run(`state.screen`), 'cardpong-setup');
  const setupHTML = run(`document.getElementById('app').innerHTML`);
  assert.ok(setupHTML.includes('CARDPONG'));
  assert.ok(!setupHTML.includes('undefined'), 'setup screen must not leak "undefined"');
  run(`state.cpMode='quick'; cpStart();`);
  assert.strictEqual(run(`state.screen`), 'cardpong');
  const boardHTML = run(`document.getElementById('app').innerHTML`);
  assert.ok(!boardHTML.includes('undefined'), 'live board must not leak "undefined"');
});
test('DRAW is synchronously locked out on the very first tap, before any card is even resolved (Quick Pong)', ()=>{
  run(`
    roster.length = 0; ['R','B'].forEach(n=>roster.push(n));
    state.cpAssign = {R:'red', B:'blue'};
    state.cpMode='quick'; cpStart();
  `);
  const deckBefore = run(`state.cp.drawDeck.length`);
  run(`cpTapDrawQuick(); cpTapDrawQuick(); cpTapDrawQuick();`); // rapid re-taps while locked
  // The re-taps must be rejected synchronously (locked===true guard) before the
  // flip timer even fires, so at this instant nothing has been drawn yet.
  assert.strictEqual(run(`state.cp.drawDeck.length`), deckBefore, 'no card may be consumed before the flip delay elapses');
  assert.strictEqual(run(`state.cp.locked`), true);
  assert.strictEqual(run(`state.cp.uiRevealing`), true);
  run(`clearTimers();`); // don't let this test's pending timers leak into later tests
});
test('DRAW is synchronously locked out on the very first tap, before any card is even resolved (Action Pong)', ()=>{
  run(`
    roster.length = 0; ['R','B'].forEach(n=>roster.push(n));
    state.cpAssign = {R:'red', B:'blue'};
    state.cpMode='action'; cpStart();
  `);
  const before = run(`state.cp.teams[state.cp.activeSide].deck.length`);
  run(`cpTapDrawAction(); cpTapDrawAction(); cpTapDrawAction();`);
  const after = run(`state.cp.teams[state.cp.activeSide].deck.length`);
  assert.strictEqual(after, before, 'no card may be consumed before the flip delay elapses');
  assert.strictEqual(run(`state.cp.locked`), true);
  run(`clearTimers();`);
});
test('Action Pong renders through a full random match without throwing or leaking "undefined"', ()=>{
  run(`
    roster.length = 0; ['Leroy','Adi','Leo','Max'].forEach(n=>roster.push(n));
    state.cpAssign = {Leroy:'red', Adi:'red', Leo:'blue', Max:'blue'};
    state.cpMode='action'; cpStart();
  `);
  let guard=0;
  while(run(`!state.cp.winner`)){
    if(guard++>2000) throw new Error('did not terminate');
    run(`
      (function(){
        var g = state.cp;
        if(g.pendingAirball){
          var opp = cpOther(g.pendingAirball.side);
          var opts = g.teams[opp].targets.filter(function(t){return t.active;});
          cpActionResolveAirball(g, opts[0].card.id);
        } else {
          cpActionDraw(g);
        }
        renderCardpongAction(g);
      })();
    `);
  }
  const html = run(`document.getElementById('app').innerHTML`);
  assert.ok(!html.includes('undefined'), 'must not leak "undefined" into markup during play');
});

/* =========================================================
   Async, real-timer end-to-end checks: let the actual flip/resolve
   timers fire and confirm the rapid re-taps never produced a second
   draw once the whole animation chain has genuinely completed.
========================================================= */
(async function runAsyncTests(){
  await test('end-to-end: rapid re-taps during the full animation chain still only ever draw one card (Quick Pong)', async ()=>{
    run(`
      roster.length = 0; ['R','B'].forEach(n=>roster.push(n));
      state.cpAssign = {R:'red', B:'blue'};
      state.cpMode='quick'; cpStart();
    `);
    const deckBefore = run(`state.cp.drawDeck.length`);
    run(`cpTapDrawQuick(); cpTapDrawQuick(); cpTapDrawQuick(); cpTapDrawQuick(); cpTapDrawQuick();`);
    await sleep(1500); // flip (220ms) + resolve (420ms) + possible drink (650ms) with margin
    assert.strictEqual(run(`state.cp.drawDeck.length`), deckBefore - 1, 'exactly one card may be drawn no matter how many times DRAW was tapped while locked');
    assert.strictEqual(run(`state.cp.locked`), false);
  });
  await test('end-to-end: rapid re-taps during the full animation chain still only ever draw one card (Action Pong, non-King draw)', async ()=>{
    run(`
      roster.length = 0; ['R','B'].forEach(n=>roster.push(n));
      state.cpAssign = {R:'red', B:'blue'};
      state.cpMode='action'; cpStart();
      // Force a plain miss so the chain settles after a single step (no King auto-redraw, no pending airball).
      (function(){
        var g = state.cp, side = g.activeSide;
        var used = new Set(g.teams[side].targets.map(function(t){ return t.card.rank+'|'+t.card.suit; }));
        var pool = buildDeck(32);
        var missCard = null;
        for(var i=0;i<pool.length;i++){ var k = pool[i].rank+'|'+pool[i].suit; if(!used.has(k)){ missCard = pool[i]; break; } }
        g.teams[side].deck.push({ id:-100, rank:missCard.rank, suit:missCard.suit, color:missCard.color, suitName:null, value:0, isJoker:false });
      })();
    `);
    const totalBefore = run(`state.cp.teams.red.deck.length + state.cp.teams.blue.deck.length`); // 69: 34+34 plus the one injected miss card
    run(`cpTapDrawAction(); cpTapDrawAction(); cpTapDrawAction(); cpTapDrawAction();`);
    await sleep(1500);
    const totalAfter = run(`state.cp.teams.red.deck.length + state.cp.teams.blue.deck.length`);
    assert.strictEqual(totalBefore - totalAfter, 1, 'exactly one card total may leave either personal deck no matter how many times DRAW was tapped while locked');
    assert.strictEqual(run(`state.cp.locked`), false);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed>0 ? 1 : 0);
})();
