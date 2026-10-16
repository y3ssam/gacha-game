import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../assets/equipment/manifest.json', import.meta.url), 'utf8'));
class Element {
  constructor() { this.children = []; this.attrs = {}; this.dataset = {}; this.style = { setProperty() {} }; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key]; }
  addEventListener() {}
}
function setup() {
  const cards = manifest.sets.filter(set => set.classId).map(set => ({ role: set.className, dataset: {} }));
  const elements = new Map();
  const document = {
    querySelectorAll: () => cards,
    getElementById: id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement: () => new Element(), createElementNS: () => new Element(), addEventListener() {},
  };
  const context = vm.createContext({ document, window: { addEventListener() {} }, cards,
    getCharacterBaseStats: card => ({ role: card.role, hp: 1000, attack: 200, defense: 100, speed: 100, critRate: 5, critDamage: 150, effectHit: 0, effectResist: 0 }),
  });
  vm.runInContext('const previewCharacterEquipment = new WeakMap(); let selectedCharacterCard = null;\n' + source.slice(source.indexOf('      const characterEquipmentTypes ='), source.indexOf('      function selectCharacterTab(')), context);
  const run = code => vm.runInContext(code, context);
  return { run, cards, elements, json: code => JSON.parse(run('JSON.stringify(' + code + ')')) };
}

test('60 unique items share inventory, use generated art and match the set manifest', () => {
  const { run, json } = setup();
  assert.equal(run('getPreviewEquipmentInventory().length'), 60);
  assert.equal(run('new Set(getPreviewEquipmentInventory().map(item => item.id)).size'), 60);
  assert.deepEqual(json('characterEquipmentSets'), Object.fromEntries(manifest.sets.map(set => [set.id, { name: set.name, classId: set.classId, className: set.className, bonuses: set.bonuses }])));
  assert.equal(run('getCharacterEquipment(cards[0]).items === getCharacterEquipment(cards[1]).items'), true);
  for (const item of json('getPreviewEquipmentInventory()')) {
    assert.ok(existsSync(new URL('../' + item.image, import.meta.url)));
    assert.ok([3, 4, 5].includes(item.rarity));
    assert.equal(run(`createEquipmentIcon(getPreviewEquipmentInventory().find(item => item.id === '${item.id}')).children[0].src`), item.image);
  }
});

test('every class can only equip its own set and common equipment; transfer removes previous owner', () => {
  const { run } = setup();
  for (let i = 0; i < 8; i++) for (const set of manifest.sets) {
    assert.equal(run(`canEquipCharacterEquipment(cards[${i}], getPreviewEquipmentInventory().find(item => item.id === '${set.id}-weapon'))`), !set.classId || manifest.sets[i].classId === set.classId);
  }
  assert.equal(run("equipCharacterEquipment(cards[0], 'unyielding-weapon')"), false);
  assert.equal(run("equipCharacterEquipment(cards[0], 'pathfinder-weapon')"), true);
  assert.equal(run("equipCharacterEquipment(cards[1], 'pathfinder-weapon')"), true);
  assert.equal(run('getCharacterEquipment(cards[0]).equipped.weapon'), undefined);
  assert.equal(run('getCharacterEquipment(cards[1]).equipped.weapon'), 'pathfinder-weapon');
});

test('2 and 4 piece bonuses apply once, 6 pieces do not repeat; removing a piece disables its special', () => {
  const { run, json } = setup();
  for (let i = 0; i < 8; i++) {
    const set = manifest.sets[i];
    run(`getCharacterEquipment(cards[${i}]).equipped = {}`);
    for (let count = 1; count <= 6; count++) {
      const slot = manifest.slots[count - 1].id;
      run(`equipCharacterEquipment(cards[${i}], '${set.id}-${slot}')`);
      const total = json(`getCharacterEquipmentTotalStats(cards[${i}])`);
      const expected = json(`getCharacterBaseStats(cards[${i}])`);
      const items = json(`getPreviewEquipmentInventory().filter(item => item.setId === '${set.id}').slice(0, ${count})`);
      for (const item of items) for (const [key, value] of Object.entries(item.stats)) expected[key] += value;
      for (const bonus of set.bonuses.filter(b => b.pieces <= count)) for (const effect of bonus.stats) {
        const base = json(`getCharacterBaseStats(cards[${i}])`);
        expected[effect.stat] += effect.mode === 'percent' ? Math.round(base[effect.stat] * effect.value / 100) : effect.value;
      }
      assert.deepEqual(total, expected, set.id + ': ' + count);
      assert.equal(run(`getCharacterEquipmentSpecialEffects(cards[${i}]).length`), count >= 4 ? 1 : 0);
    }
    run(`delete getCharacterEquipment(cards[${i}]).equipped.weapon; delete getCharacterEquipment(cards[${i}]).equipped.armor; delete getCharacterEquipment(cards[${i}]).equipped.gloves;`);
    assert.equal(run(`getCharacterEquipmentSpecialEffects(cards[${i}]).length`), 0);
  }
});

test('enhancement keeps generated image and restrictions; spends gold and grows options at +3', () => {
  const { run } = setup();
  run('let item = getPreviewEquipmentInventory()[0]; let gold = 100000;');
  assert.equal(run('calculateEquipmentEnhancement(item, 0).ok'), false);
  const image = run('item.image');
  for (let i = 1; i <= 15; i++) {
    run('constResult = calculateEquipmentEnhancement(item, gold, equipmentEnhancementRules, () => 0); item = constResult.item; gold = constResult.gold;');
    assert.equal(run('item.enhancement'), i);
    assert.equal(run('item.image'), image);
    assert.equal(run('item.classId'), 'knight');
    assert.equal(run('item.subOptions.length'), Math.min(4, 1 + Math.floor(i / 3)));
  }
  assert.equal(run('calculateEquipmentEnhancement(item, gold).ok'), false);
});

test('game script parses and equipment UI renders real icons with three set tiles', () => {
  new vm.Script(source.slice(source.indexOf('    <script>') + '    <script>'.length, source.lastIndexOf('    </script>')));
  const { run, elements } = setup();
  run("equipCharacterEquipment(cards[0], 'silver-oath-weapon'); renderCharacterEquipment(cards[0]); renderCharacterEquipmentPicker(cards[0]);");
  const slots = elements.get('character-equipment-slots').children;
  assert.equal(slots.length, 6);
  assert.equal(slots[0].children[1].children[0].children[0].src, 'assets/equipment/silver-oath-weapon.png');
  assert.equal(elements.get('character-equipment-sets').children.length, 3);
  assert.equal(elements.get('character-equipment-list').children.length, 3);
});
