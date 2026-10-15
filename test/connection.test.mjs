import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import http from 'node:http';
import { createAppServer, testVertexConnection } from '../server.mjs';

// 테스트 전용 키를 메모리에서 생성합니다. 실제 서비스 계정과 API 호출은 사용하지 않습니다.
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentials = {
  type: 'service_account', project_id: 'sample-project',
  client_email: 'test@sample-project.iam.gserviceaccount.com',
  private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://untrusted.invalid/steal',
};
const input = { credentials: JSON.stringify(credentials), region: 'global', model: 'test-model' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('실제 RS256 서명 검증, 고정 Google 인증 주소, global 요청과 hello 전송', async () => {
  const calls = [];
  const result = await testVertexConnection(input, { fetchImpl: async (url, options) => {
    calls.push(url);
    if (calls.length === 1) {
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const jwt = body.get('assertion').split('.');
      assert.ok(verify('RSA-SHA256', Buffer.from(jwt.slice(0, 2).join('.')), pair.publicKey, Buffer.from(jwt[2], 'base64url')));
      const claims = JSON.parse(Buffer.from(jwt[1], 'base64url').toString());
      assert.equal(claims.iss, credentials.client_email);
      assert.equal(claims.aud, url);
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/cloud-platform');
      assert.equal(claims.exp - claims.iat, 3600);
      return json({ access_token: 'test-token' });
    }
    assert.equal(url, 'https://aiplatform.googleapis.com/v1/projects/sample-project/locations/global/publishers/google/models/test-model:generateContent');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(options.body).contents, [{ role: 'user', parts: [{ text: 'hello' }] }]);
    assert.equal(options.redirect, 'error');
    return json({ candidates: [{ content: { parts: [{ thought: true, text: 'internal' }, { text: 'Hello!' }] } }] });
  } });
  assert.equal(calls.length, 2);
  assert.deepEqual(result, { ok: true, text: 'Hello!', model: 'test-model', region: 'global' });
  assert.ok(!JSON.stringify(result).includes('test-token'));
});

test('지역별 호스트 구성', async () => {
  let count = 0;
  await testVertexConnection({ ...input, region: 'asia-northeast3' }, { fetchImpl: async url => {
    if (++count === 1) return json({ access_token: 'test-token' });
    assert.equal(url, 'https://asia-northeast3-aiplatform.googleapis.com/v1/projects/sample-project/locations/asia-northeast3/publishers/google/models/test-model:generateContent');
    return json({ candidates: [{ content: { parts: [{ text: '안녕!' }] } }] });
  } });
});

test('잘못된 JSON, 키, 리전, 모델 경로는 외부 요청 전에 거절', async () => {
  for (const item of [
    { ...input, credentials: '{' },
    { ...input, credentials: JSON.stringify({ ...credentials, private_key: 'invalid' }) },
    { ...input, credentials: JSON.stringify({ ...credentials, project_id: '../secret' }) },
    { ...input, region: 'evil.invalid/' },
    { ...input, model: '../other' },
  ]) {
    await assert.rejects(testVertexConnection(item, { fetchImpl: () => { assert.fail('네트워크 호출 금지'); } }));
  }
});

test('Google 인증 오류를 표시하되 개인 키와 계정 주소를 숨김', async () => {
  await assert.rejects(testVertexConnection(input, { fetchImpl: async () => json({ error: 'invalid_grant', error_description: `invalid signature ${credentials.private_key} ${credentials.client_email}` }, 400) }), error => {
    assert.equal(error.code, 'AUTH_FAILED');
    assert.match(error.message, /invalid_grant/);
    assert.ok(!error.message.includes('BEGIN PRIVATE KEY'));
    assert.ok(!error.message.includes(credentials.client_email));
    return true;
  });
});

test('모델 권한 오류, 빈 응답, 잘못된 응답 및 타임아웃을 성공으로 처리하지 않음', async () => {
  let calls = 0;
  await assert.rejects(testVertexConnection(input, { fetchImpl: async () => ++calls === 1 ? json({ access_token: 'test-token' }) : json({ error: { message: 'Permission denied test-token' } }, 403) }), error => error.code === 'MODEL_REQUEST_FAILED' && error.status === 403 && !error.message.includes('test-token'));
  calls = 0;
  await assert.rejects(testVertexConnection(input, { fetchImpl: async () => ++calls === 1 ? json({ access_token: 'test-token' }) : json({ candidates: [{ finishReason: 'SAFETY' }] }) }), error => error.code === 'EMPTY_RESPONSE');
  await assert.rejects(testVertexConnection(input, { fetchImpl: async () => new Response('not json') }), error => error.code === 'INVALID_GOOGLE_RESPONSE');
  const signal = AbortSignal.abort();
  await assert.rejects(testVertexConnection(input, { signal, fetchImpl: async () => { throw new Error('aborted'); } }), error => error.code === 'TIMEOUT');
});

test('접근 차단, DNS, 인증서 오류를 구분하고 내부 오류에서 키를 노출하지 않음', async () => {
  for (const [code, expected] of [['EACCES', 'NETWORK_ACCESS_DENIED'], ['EPERM', 'NETWORK_ACCESS_DENIED'], ['ENOTFOUND', 'DNS_ERROR'], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'TLS_ERROR'], ['UND_ERR_CONNECT_TIMEOUT', 'TIMEOUT']]) {
    await assert.rejects(testVertexConnection(input, { fetchImpl: async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error(credentials.private_key), { code }) });
    } }), error => error.code === expected && !error.message.includes(credentials.private_key));
  }
});

test('로컬 HTTP 서버의 출처·크기·경로 보호 및 테스트 응답 전달', async () => {
  let hits = 0;
  const app = createAppServer({ testConnection: async body => {
    hits++;
    assert.equal(body.model, 'test-model');
    return { ok: true, text: '<b>Hello</b>', model: 'test-model', region: 'global' };
  } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(await page.text(), /AI 연결/);
    assert.equal((await fetch(`${base}/server.mjs`)).status, 404);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    const badHostStatus = await new Promise((resolve, reject) => {
      http.get(base, { headers: { Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(badHostStatus, 403);
    const post = (body, origin = base, type = 'application/json') => fetch(`${base}/api/connections/test`, { method: 'POST', headers: { Origin: origin, 'Content-Type': type }, body });
    assert.equal((await post(JSON.stringify(input), 'https://attacker.invalid')).status, 403);
    assert.equal((await post(JSON.stringify(input), base, 'text/plain')).status, 415);
    assert.equal((await post('{')).status, 400);
    assert.equal((await post(JSON.stringify({ huge: 'x'.repeat(128 * 1024) }))).status, 413);
    assert.equal(hits, 0);
    const response = await post(JSON.stringify(input));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).text, '<b>Hello</b>');
    assert.equal(hits, 1);
  } finally {
    await new Promise(resolve => app.close(resolve));
  }
});
