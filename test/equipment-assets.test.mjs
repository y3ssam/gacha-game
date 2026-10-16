import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAppServer } from '../server.mjs';

test('장비 도감 10세트·60부위 및 제한된 이미지 제공', async t => {
  const server = createAppServer({ store: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const manifest = JSON.parse(await readFile(new URL('../assets/equipment/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.sets.length, 10);
  assert.equal(manifest.assets.length, 60);
  assert.equal(new Set(manifest.assets.map(a => a.id)).size, 60);
  assert.equal(manifest.sets.filter(s => s.classId).length, 8);
  assert.equal(manifest.sets.filter(s => !s.classId).length, 2);
  for (const set of manifest.sets) {
    assert.deepEqual(manifest.assets.filter(a => a.setId === set.id).map(a => a.slot).sort(), manifest.slots.map(s => s.id).sort());
    assert.deepEqual(set.bonuses.map(b => b.pieces), [2, 4]);
    assert.equal(Boolean(set.bonuses[1].special), Boolean(set.classId));
  }
  for (const asset of manifest.assets) {
    const response = await fetch(base + '/assets/equipment/' + asset.file, { method: 'HEAD' });
    assert.equal(response.status, 200, asset.file);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const bytes = await readFile(new URL('../assets/equipment/' + asset.file, import.meta.url));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', asset.file);
    assert.equal(bytes.readUInt32BE(16), 1254, asset.file);
    assert.equal(bytes.readUInt32BE(20), 1254, asset.file);
    assert.equal(bytes[25], 6, asset.file);
  }
  assert.equal((await fetch(base + '/assets/equipment/')).status, 200);
  assert.equal((await fetch(base + '/assets/equipment/manifest.json')).status, 200);
  assert.equal((await fetch(base + '/assets/equipment/generation-prompts.json')).status, 200);
  for (const path of ['no-such-image.png', '%2e%2e%2fserver.mjs', 'README.md', 'key.json', 'server.mjs']) {
    assert.equal((await fetch(base + '/assets/equipment/' + path)).status, 404, path);
  }
  assert.equal((await fetch(base + '/assets/equipment/silver-oath-weapon.png', { method: 'POST' })).status, 405);
});
