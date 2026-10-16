import http from 'node:http';
import { testNovelAI, buildImageTest, ImageTestError } from './novelai.mjs';
import { createConnectionStore, StoreError } from './connection-store.mjs';
import { readFile } from 'node:fs/promises';
import { createPrivateKey, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REGIONS = new Set(['global', 'us-central1', 'asia-northeast3', 'asia-northeast1', 'europe-west4']);
const MAX_BODY = 128 * 1024;
const ROOT = path.dirname(fileURLToPath(import.meta.url));

export class ConnectionError extends Error {
  constructor(message, code = 'INVALID_INPUT', status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function validateConnection(input) {
  if (!input || typeof input !== 'object') throw new ConnectionError('연결 정보를 확인해 주세요.');
  let credentials;
  try {
    if (typeof input.credentials !== 'string' || input.credentials.length > MAX_BODY) throw new Error();
    credentials = JSON.parse(input.credentials);
  } catch {
    throw new ConnectionError('API KEY에 올바른 서비스 계정 JSON 키 전체를 입력해 주세요.', 'INVALID_JSON');
  }
  if (!credentials || credentials.type !== 'service_account' ||
      typeof credentials.client_email !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(credentials.client_email) ||
      typeof credentials.private_key !== 'string' ||
      !credentials.private_key.includes('-----BEGIN PRIVATE KEY-----')) {
    throw new ConnectionError('service_account 형식의 JSON 키가 필요합니다. client_email과 private_key를 확인해 주세요.', 'INVALID_CREDENTIALS');
  }
  if (typeof credentials.project_id !== 'string' || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(credentials.project_id)) {
    throw new ConnectionError('JSON 키의 project_id를 확인해 주세요.', 'INVALID_PROJECT');
  }
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(model)) {
    throw new ConnectionError('실제 호출에 사용할 모델 ID를 입력해 주세요.', 'INVALID_MODEL');
  }
  if (!REGIONS.has(input.region)) throw new ConnectionError('지원하는 리전을 선택해 주세요.', 'INVALID_REGION');
  let privateKey;
  try {
    privateKey = createPrivateKey(credentials.private_key);
    if (privateKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails.modulusLength < 2048) throw new Error();
  } catch {
    throw new ConnectionError('JSON 키의 private_key가 올바른 RSA 개인 키인지 확인해 주세요.', 'INVALID_PRIVATE_KEY');
  }
  return { credentials, privateKey, model, region: input.region };
}

export function buildVertexUrl(project, region, model) {
  const host = region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
}

function publicError(data, secrets) {
  let message = typeof data?.error === 'string'
    ? `${data.error}: ${data.error_description || ''}`
    : typeof data?.error?.message === 'string' ? data.error.message : 'Google API에서 요청을 거절했습니다.';
  // Google 오류를 표시하되, 인증 자료가 포함될 경우 화면으로 반환하지 않습니다.
  message = message.replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g, '[숨김]');
  for (const secret of secrets.filter(value => typeof value === 'string' && value.length > 0)) {
    message = message.split(secret).join('[숨김]');
  }
  return message.slice(0, 2000);
}

async function googleRequest(fetchImpl, url, options) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, redirect: 'error' });
    const raw = await response.text();
    if (raw.length > 1024 * 1024) throw new Error('oversized');
    let data;
    try { data = JSON.parse(raw); }
    catch { throw new ConnectionError('Google API가 JSON 형식의 응답을 보내지 않았습니다.', 'INVALID_GOOGLE_RESPONSE', 502); }
    return { response, data };
  } catch (error) {
    if (error instanceof ConnectionError) throw error;
    if (options.signal.aborted) throw new ConnectionError('연결 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.', 'TIMEOUT', 504);
    const causes = [error, error.cause, ...(error.cause?.errors || [])];
    const codes = causes.map(cause => cause?.code).filter(Boolean);
    if (codes.includes('EACCES') || codes.includes('EPERM')) {
      throw new ConnectionError('로컬 서버의 실행 환경에서 Google 접속이 차단되었습니다. 게임 폴더의 start-local.cmd로 서버를 다시 실행한 뒤 테스트해 주세요. (EACCES/EPERM)', 'NETWORK_ACCESS_DENIED', 502);
    }
    if (codes.some(code => ['ENOTFOUND', 'EAI_AGAIN'].includes(code))) {
      throw new ConnectionError('Google 주소를 찾지 못했습니다. 인터넷과 DNS 연결을 확인해 주세요.', 'DNS_ERROR', 502);
    }
    if (codes.some(code => ['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(code))) {
      throw new ConnectionError('Google HTTPS 인증서를 검증하지 못했습니다. PC의 날짜와 신뢰할 수 있는 인증서 설정을 확인해 주세요.', 'TLS_ERROR', 502);
    }
    if (codes.some(code => ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code))) {
      throw new ConnectionError('Google 서버에 접속하는 시간이 초과되었습니다. 네트워크 연결을 확인하고 다시 시도해 주세요.', 'TIMEOUT', 504);
    }
    throw new ConnectionError('Google API에 접속하지 못했습니다. 인터넷 연결, 방화벽 또는 프록시 설정을 확인해 주세요.', 'NETWORK_ERROR', 502);
  }
}

export async function testVertexConnection(input, { fetchImpl = fetch, signal = AbortSignal.timeout(60000) } = {}) {
  const { credentials, privateKey, model, region } = validateConnection(input);
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  })}`;
  const assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
  // JSON 안의 token_uri 등은 요청 대상으로 사용하지 않습니다.
  const token = await googleRequest(fetchImpl, TOKEN_URL, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  });
  const secrets = [credentials.private_key, credentials.client_email, assertion];
  if (!token.response.ok) throw new ConnectionError(`Google 인증 실패 (HTTP ${token.response.status})\n${publicError(token.data, secrets)}`, 'AUTH_FAILED', token.response.status === 429 ? 429 : 401);
  const accessToken = token.data.access_token;
  if (typeof accessToken !== 'string' || !accessToken) throw new ConnectionError('Google 인증 응답에 액세스 토큰이 없습니다.', 'AUTH_FAILED', 502);
  secrets.push(accessToken);
  const generated = await googleRequest(fetchImpl, buildVertexUrl(credentials.project_id, region, model), {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { maxOutputTokens: 1024 },
    }),
  });
  if (!generated.response.ok) {
    const hints = { 403: 'Vertex AI API 활성화, 결제 설정과 서비스 계정의 Vertex AI 권한을 확인해 주세요.', 404: '모델 ID와 해당 리전에서의 모델 지원 여부를 확인해 주세요.', 429: '요청 한도 또는 이용 가능한 용량을 확인하고 잠시 후 다시 시도해 주세요.' };
    throw new ConnectionError(`모델 호출 실패 (HTTP ${generated.response.status})\n${publicError(generated.data, secrets)}${hints[generated.response.status] ? `\n${hints[generated.response.status]}` : ''}`, 'MODEL_REQUEST_FAILED', generated.response.status >= 400 && generated.response.status <= 599 ? generated.response.status : 502);
  }
  const text = generated.data.candidates?.[0]?.content?.parts
    ?.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('').trim();
  if (!text) {
    const reason = generated.data.promptFeedback?.blockReason || generated.data.candidates?.[0]?.finishReason;
    throw new ConnectionError(`요청은 처리됐지만 모델의 텍스트 답변이 없습니다.${reason ? ` (종료 사유: ${String(reason).slice(0, 100)})` : ''}`, 'EMPTY_RESPONSE', 502);
  }
  return { ok: true, text, model, region };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const buffers = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ConnectionError('입력한 연결 정보가 너무 큽니다.', 'BODY_TOO_LARGE', 413);
    buffers.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(buffers).toString('utf8')); }
  catch { throw new ConnectionError('올바른 JSON 요청이 필요합니다.', 'INVALID_JSON'); }
}

export function createAppServer({ testConnection = testVertexConnection, store = createConnectionStore(), testImage = testNovelAI } = {}) {
  let activeTests = 0;
  return http.createServer(async (req, res) => {
    try {
      const port = req.socket.localPort;
      const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (!hosts.has(req.headers.host)) return sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN_HOST', message: '로컬 주소로 접속해 주세요.' } });
      const route = new URL(req.url, `http://${req.headers.host}`).pathname;
      if (route === '/api/connections' || route === '/api/connections/test' || route === '/api/images/test') {
        const origin = req.headers.origin;
        if (origin && !new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]).has(origin)) {
          return sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN_ORIGIN', message: '로컬 게임 화면에서만 테스트할 수 있습니다.' } });
        }
        if (route === '/api/connections' && req.method === 'GET') {
          return sendJson(res, 200, { ok: true, connections: await store.list() });
        }
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST 요청만 가능합니다.' } });
        if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new ConnectionError('JSON 요청이 필요합니다.', 'UNSUPPORTED_CONTENT_TYPE', 415);
        if (route === '/api/connections') {
          const input = await readJson(req);
          const name = typeof input.name === 'string' ? input.name.trim() : '';
          if (!name || name.length > 80) throw new ConnectionError('이름은 1~80자로 입력해 주세요.', 'INVALID_NAME');
          if (input.id && (typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id))) throw new ConnectionError('올바른 연결 ID가 필요합니다.');
          const provider = input.provider || 'vertex';
          if (!['vertex', 'novelai'].includes(provider)) throw new ConnectionError('지원하지 않는 연결 종류입니다.', 'INVALID_PROVIDER');
          if (input.id) {
            const previous = await store.get(input.id);
            if ((previous.provider || 'vertex') !== provider) throw new ConnectionError('기존 연결의 종류를 변경할 수 없습니다.', 'PROVIDER_MISMATCH');
            if (!input.credentials) input.credentials = previous.credentials;
          }
          let settings;
          if (provider === 'novelai') {
            const options = input.settings;
            buildImageTest({ ...options, model: input.model, token: input.credentials });
            settings = Object.fromEntries(['prefix', 'suffix', 'negativePrefix', 'steps', 'guidance', 'rescale', 'ucPreset', 'qualityTags'].map(key => [key, options[key]]));
          } else validateConnection(input);
          const connection = await store.save({ id: input.id, provider, name, credentials: input.credentials, model: input.model.trim(), region: input.region, settings });
          return sendJson(res, 200, { ok: true, connection });
        }
        if (activeTests >= 2) throw new ConnectionError('다른 연결 테스트가 진행 중입니다. 잠시 후 다시 시도해 주세요.', 'BUSY', 429);
        activeTests++;
        const controller = new AbortController();
        const onClose = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', onClose);
        try {
          const input = await readJson(req);
          const isImage = route === '/api/images/test';
          if (input.id) {
            const previous = await store.get(input.id);
            if ((previous.provider || 'vertex') !== (isImage ? 'novelai' : 'vertex')) throw new ConnectionError('연결 종류가 일치하지 않습니다.', 'PROVIDER_MISMATCH');
            if (isImage && !input.token) input.token = previous.credentials;
            if (!isImage && !input.credentials) input.credentials = previous.credentials;
          }
          const result = await (isImage ? testImage : testConnection)(input, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(isImage ? 180000 : 60000)]) });
          if (!res.destroyed) sendJson(res, 200, result);
        } finally {
          activeTests--;
          res.off('close', onClose);
        }
        return;
      }
      // 생성한 재료 아이콘과 미리보기만 허용하며 키 파일과 서버 소스는 제공하지 않습니다.
      const materialAsset = route.match(/^\/assets\/materials\/(?:([a-z0-9-]+\.png|manifest\.json|generation-prompts\.json|index\.html))?$/);
      if (materialAsset) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false });
        const filename = materialAsset[1] || 'index.html';
        let asset;
        try { asset = await readFile(path.join(ROOT, 'assets', 'materials', filename)); }
        catch (error) { if (error.code === 'ENOENT') return sendJson(res, 404, { ok: false }); throw error; }
        res.writeHead(200, {
          'Content-Type': filename.endsWith('.png') ? 'image/png' : filename.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
        });
        res.end(req.method === 'HEAD' ? undefined : asset);
        return;
      }
      if (route === '/' || route === '/index.html') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false });
        const page = await readFile(path.join(ROOT, 'index.html'));
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
        });
        res.end(req.method === 'HEAD' ? undefined : page);
        return;
      }
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '요청한 경로를 찾을 수 없습니다.' } });
    } catch (error) {
      const known = error instanceof ConnectionError || error instanceof StoreError || error instanceof ImageTestError;
      if (!res.destroyed && !res.headersSent) sendJson(res, known ? error.status : 500, { ok: false, error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : '연결 테스트를 처리하지 못했습니다. 다시 시도해 주세요.' } });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const app = createAppServer();
  app.requestTimeout = 75000;
  app.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `포트 ${port}가 사용 중입니다. 기존 서버를 종료하거나 PORT를 변경해 주세요.` : '로컬 서버를 시작하지 못했습니다.');
    process.exitCode = 1;
  });
  app.listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}`));
}
