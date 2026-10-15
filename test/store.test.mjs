import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { createConnectionStore, windowsProtect } from '../connection-store.mjs';
import { createAppServer } from '../server.mjs';

test('Windows 암호화 저장, 재시작 복원, 수정, 저장된 키 테스트와 출처 보호', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gacha-store-test-'));
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const credentials = JSON.stringify({ type: 'service_account', project_id: 'sample-project', client_email: 'test@sample-project.iam.gserviceaccount.com', private_key: privateKey });
  const store = createConnectionStore({ directory });
  const input = { name: '검증용 연결', credentials, model: 'test-model', region: 'global' };
  let app;
  try {
    assert.deepEqual(await store.list(), []);
    const saved = await store.save(input);
    assert.equal(saved.name, input.name);
    assert.ok(!('credentials' in saved));
    const file = await readFile(path.join(directory, 'connections.dpapi'), 'utf8');
    assert.ok(!file.includes('PRIVATE KEY'));
    assert.ok(!file.includes(input.name));
    assert.ok(!file.includes(credentials));
    const restored = createConnectionStore({ directory });
    assert.equal((await restored.list())[0].id, saved.id);
    assert.equal((await restored.get(saved.id)).credentials, credentials);
    const updated = await restored.save({ ...input, id: saved.id, name: '수정된 연결', model: 'updated-model' });
    assert.equal(updated.id, saved.id);
    assert.equal((await restored.list()).length, 1);
    app = createAppServer({ store: restored, testConnection: async body => {
      assert.equal(body.credentials, credentials);
      return { ok: true, text: '검증용 응답' };
    } });
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.address().port}`;
    const post = (route, body, origin = base) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
    const listed = await (await fetch(base + '/api/connections')).json();
    assert.equal(listed.connections[0].name, '수정된 연결');
    assert.ok(!JSON.stringify(listed).includes('private_key'));
    assert.equal((await post('/api/connections', input, 'https://other.invalid')).status, 403);
    assert.equal((await post('/api/connections', { ...input, name: '' })).status, 400);
    const tested = await (await post('/api/connections/test', { id: saved.id, credentials: '', model: 'updated-model', region: 'global' })).json();
    assert.equal(tested.text, '검증용 응답');
    const changed = await (await post('/api/connections', { id: saved.id, credentials: '', name: '다시 수정', model: 'another-model', region: 'global' })).json();
    assert.ok(changed.ok);
    assert.equal(changed.connection.id, saved.id);
    assert.equal((await restored.get(saved.id)).credentials, credentials);
    const rejectedStore = createConnectionStore({ directory, protect: async (value, decrypt) => {
      if (decrypt) return windowsProtect(value, true);
      throw new Error('simulated encryption failure');
    } });
    const before = await readFile(path.join(directory, 'connections.dpapi'), 'utf8');
    await assert.rejects(rejectedStore.save(input));
    assert.equal(await readFile(path.join(directory, 'connections.dpapi'), 'utf8'), before);
  } finally {
    if (app) await new Promise(resolve => app.close(resolve));
    await unlink(path.join(directory, 'connections.dpapi')).catch(() => {});
    await rmdir(directory);
  }
});
