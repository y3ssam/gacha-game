import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAppServer } from '../server.mjs';

test('던전 이미지 제공, 크기·형식 확인 및 허용 경로 제한', async t => {
  const server = createAppServer({ store: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const manifest = JSON.parse(await readFile(new URL('../assets/dungeons/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.images.length, 21);
  for (const image of manifest.images) {
    const response = await fetch(base + '/assets/dungeons/' + image.file, { method: 'HEAD' });
    assert.equal(response.status, 200, image.file);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
  const image = await fetch(base + '/assets/dungeons/skill-fire.png');
  const bytes = Buffer.from(await image.arrayBuffer());
  assert.equal(bytes.readUInt32BE(16), 1024);
  assert.equal(bytes.readUInt32BE(20), 1536);
  for (const path of ['/server.mjs', '/assets/dungeons/%2e%2e%2fserver.mjs', '/assets/dungeons/no-such-image.png']) {
    assert.equal((await fetch(base + path)).status, 404);
  }
  assert.equal((await fetch(base + '/assets/dungeons/growth.png', { method: 'POST' })).status, 405);
});
