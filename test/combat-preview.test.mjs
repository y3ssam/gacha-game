import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
class Element {
  constructor() { this.children = []; this.dataset = {}; this.attrs = {}; this.style = {}; this.events = {}; this.hidden = true; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key]; }
  removeAttribute(key) { delete this.attrs[key]; }
  addEventListener(name, listener) { this.events[name] = listener; }
}
function setup() {
  const elements = new Map(), timers = new Map(); let nextTimer = 0;
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  get('game-preview').dataset.view = 'combat-preview'; get('combat-preview-screen').dataset.speed = '1'; get('combat-auto').setAttribute('aria-pressed', 'false');
  const document = { hidden: false, getElementById: get, querySelectorAll: () => [], createElement: () => new Element(), createElementNS: () => new Element(), addEventListener() {} };
  const context = vm.createContext({ document, previewParty: Array(6).fill(null), setTimeout: (fn, delay) => { timers.set(++nextTimer, { fn, delay }); return nextTimer; }, clearTimeout: id => timers.delete(id) });
  const start = source.indexOf('      // 화면/조작 확인용 상태입니다.');
  const end = source.indexOf("      document.getElementById('game-characters')", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  const run = code => vm.runInContext(code, context);
  run('resetCombatPreview()');
  return { get, run, timers };
}

test('battle preview contains six allies, six enemies, speed queue and 2x2 skill choices', () => {
  const { get, run } = setup();
  assert.equal(get('combat-allies').children.length, 6);
  assert.equal(get('combat-enemies').children.length, 6);
  assert.equal(get('combat-turn-list').children.length, 7);
  assert.equal(get('combat-turn-list').children[0].getAttribute('aria-current'), 'true');
  assert.ok(get('combat-turn-list').children.every(card => !card.textContent && card.children.length === 1));
  assert.equal(get('combat-skill-grid').children.length, 4);
  assert.equal(run('combatPreviewState.queue.every((unit, index, queue) => !index || queue[index - 1].speed >= unit.speed)'), true);
  assert.equal(run("combatPreviewSkills.filter(skill => isCombatPreviewSkillAvailable(skill, combatPreviewState.queue[0])).map(skill => skill.id).join(',')"), 'basic,active,ultimate');
  assert.equal(run('combatPreviewState.selectedSkill'), null);
});

test('skill selection highlights enemies; passive shows information without allowing use', () => {
  const { get, run } = setup();
  get('combat-skill-grid').children[0].events.click();
  assert.equal(run('combatPreviewState.selectedSkill'), 'basic');
  assert.ok(get('combat-enemies').children.every(slot => slot.children[0].dataset.target === 'true'));
  get('combat-skill-grid').children[3].events.click();
  assert.equal(get('combat-skill-tooltip').hidden, false);
  assert.equal(run('combatPreviewState.selectedSkill'), 'basic');
  get('combat-skill-grid').children[0].events.click();
  assert.equal(run('combatPreviewState.selectedSkill'), null);
});

test('ultimate preview consumes demo energy, displays overlay, and leaves real HP untouched', () => {
  const { get, run } = setup();
  const hp = run('combatPreviewState.units.map(unit => unit.hp).join()');
  get('combat-skill-grid').children[2].events.click();
  get('combat-enemies').children[0].children[0].events.click();
  assert.equal(get('combat-ultimate').hidden, false);
  assert.equal(run('combatPreviewState.queue[0].energy'), 0);
  assert.equal(run('combatPreviewState.busy'), true);
  assert.equal(run('combatPreviewState.units.map(unit => unit.hp).join()'), hp);
  run('resetCombatPreview()');
  assert.equal(run('combatPreviewState.busy'), false);
  assert.equal(get('combat-ultimate').hidden, true);
});

test('auto prioritizes ultimate, active, basic and the preview timers stop on exit', () => {
  for (const [energy, cooldown, expected] of [[100, 0, 'ultimate'], [40, 0, 'active'], [40, 2, 'basic']]) {
    const { run, timers } = setup();
    run(`combatPreviewState.queue[0].energy = ${energy}; combatPreviewState.queue[0].cooldown = ${cooldown}; document.getElementById('combat-auto').setAttribute('aria-pressed', 'true'); let lastSkill; playCombatPreviewAction = skill => { lastSkill = skill; }; scheduleCombatPreview();`);
    assert.equal(timers.size, 1);
    [...timers.values()][0].fn();
    assert.equal(run('lastSkill'), expected);
    run('stopCombatPreview()');
    assert.equal(timers.size, 0);
  }
});
