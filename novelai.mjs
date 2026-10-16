import { readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

// Model IDs and preset strings checked against the public NovelAI client on 2026-10-16.
// Sources: https://novelai.net/image and https://image.novelai.net/docs/doc.json
export const NOVELAI_MODELS = JSON.parse(readFileSync(new URL('./novelai-presets.json', import.meta.url), 'utf8'));
export const NOVELAI_ENDPOINT = 'https://image.novelai.net/ai/generate-image';
const MAX_IMAGE = 20 * 1024 * 1024;
export class ImageTestError extends Error {
  constructor(message, code = 'INVALID_IMAGE_SETTINGS', status = 400) {
    super(message); this.code = code; this.status = status;
  }
}
const joinTags = (...parts) => parts.map(x => x.trim().replace(/^,+|,+$/g, '').trim()).filter(Boolean).join(', ');
function number(value, min, max, label, step) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || Math.abs(value / step - Math.round(value / step)) > 0.00001) throw new ImageTestError(`${label} 값을 확인해 주세요. (${min}~${max})`);
  return value;
}
export function buildImageTest(input) {
  if (!input || typeof input !== 'object') throw new ImageTestError('이미지 설정을 확인해 주세요.');
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  if (!/^[A-Za-z0-9._~-]{10,8192}$/.test(token)) throw new ImageTestError('API KEY에 NovelAI Persistent API Token을 입력해 주세요.', 'INVALID_IMAGE_TOKEN');
  const spec = NOVELAI_MODELS[input.model];
  if (!spec || !Object.hasOwn(NOVELAI_MODELS, input.model)) throw new ImageTestError('지원하는 NovelAI 모델을 선택해 주세요.');
  const uc = Object.hasOwn(spec.uc, input.ucPreset) ? spec.uc[input.ucPreset] : null;
  const quality = Object.hasOwn(spec.quality, input.qualityTags) ? spec.quality[input.qualityTags] : null;
  if (!uc || !quality) throw new ImageTestError('선택한 모델이 지원하지 않는 UC 프리셋 또는 퀄리티 태그입니다.', 'UNSUPPORTED_IMAGE_PRESET');
  for (const key of ['prefix', 'suffix', 'negativePrefix']) {
    if (typeof input[key] !== 'string' || input[key].length > 12000) throw new ImageTestError('프롬프트는 각 12,000자 이내로 입력해 주세요.');
  }
  const prompt = joinTags(quality.prefix, input.prefix, 'Spaghetti, eating spaghetti', input.suffix, quality.suffix);
  const negative = joinTags(input.negativePrefix, uc.prefix, uc.suffix);
  const parameters = {
    params_version: 4, image_format: 'png', width: 1024, height: 1024,
    steps: number(input.steps, 1, 50, '단계', 1),
    scale: number(input.guidance, 0, 10, '프롬프트 가이던스', 0.1),
    cfg_rescale: number(input.rescale, 0, 1, '가이던스 리스케일', 0.01),
    sampler: 'k_euler_ancestral', noise_schedule: 'karras',
    seed: randomInt(0, 0x100000000), n_samples: 1,
    negative_prompt: negative, qualityToggle: false,
    sm: false, sm_dyn: false, dynamic_thresholding: false,
    legacy: false, legacy_v3_extend: false,
    deliberate_euler_ancestral_bug: false, prefer_brownian: true,
  };
  if (!input.model.endsWith('v3')) {
    parameters.v4_prompt = { caption: { base_caption: prompt, char_captions: [] }, use_coords: false, use_order: true };
    parameters.v4_negative_prompt = { caption: { base_caption: negative, char_captions: [] }, legacy_uc: false };
  }
  return { token, payload: { action: 'generate', model: spec.apiModel, input: prompt, parameters } };
}

function pngImage(buffer) {
  if (buffer.length < 33 || buffer.length > MAX_IMAGE || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || buffer.toString('ascii', 12, 16) !== 'IHDR') throw new ImageTestError('NovelAI 응답에 올바른 PNG 이미지가 없습니다.', 'INVALID_IMAGE_RESPONSE', 502);
  if (buffer.readUInt32BE(16) !== 1024 || buffer.readUInt32BE(20) !== 1024) throw new ImageTestError('NovelAI가 요청한 1024×1024 크기의 이미지를 반환하지 않았습니다.', 'UNEXPECTED_IMAGE_SIZE', 502);
  return buffer;
}
function unzipPng(buffer) {
  // Inspect the ZIP directory; never extract paths to the filesystem.
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('Invalid ZIP');
  let offset = buffer.readUInt32LE(end + 16);
  const count = buffer.readUInt16LE(end + 10);
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid directory');
    const flags = buffer.readUInt16LE(offset + 8), method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20), expanded = buffer.readUInt32LE(offset + 24);
    const nameSize = buffer.readUInt16LE(offset + 28), extra = buffer.readUInt16LE(offset + 30), comment = buffer.readUInt16LE(offset + 32);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameSize);
    const local = buffer.readUInt32LE(offset + 42);
    if (/\.png$/i.test(name)) {
      if (flags & 1 || expanded > MAX_IMAGE || size > MAX_IMAGE || local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid entry');
      const begin = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      if (begin + size > buffer.length) throw new Error('Truncated entry');
      const content = buffer.subarray(begin, begin + size);
      const png = method === 0 ? content : method === 8 ? inflateRawSync(content, { maxOutputLength: MAX_IMAGE }) : null;
      if (!png || png.length !== expanded) throw new Error('Invalid entry size');
      return pngImage(png);
    }
    offset += 46 + nameSize + extra + comment;
  }
  throw new Error('No PNG');
}
async function limitedBody(response) {
  const chunks = []; let size = 0;
  if (!response.body) throw new Error('Empty body');
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 30 * 1024 * 1024) throw new ImageTestError('이미지 응답 크기가 허용 범위를 초과했습니다.', 'IMAGE_TOO_LARGE', 502);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function testNovelAI(input, { fetchImpl = fetch, signal = AbortSignal.timeout(180000) } = {}) {
  const { token, payload } = buildImageTest(input);
  let response, raw;
  try {
    response = await fetchImpl(NOVELAI_ENDPOINT, {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    raw = await limitedBody(response);
  } catch (error) {
    if (error instanceof ImageTestError) throw error;
    if (signal.aborted) throw new ImageTestError('이미지 생성 대기 시간이 초과되었습니다. 처리 여부를 확인한 후 다시 시도해 주세요.', 'IMAGE_TIMEOUT', 504);
    const codes = [error.cause?.code, error.code, ...(error.cause?.errors || []).map(e => e.code)];
    throw new ImageTestError(codes.some(c => c === 'EACCES' || c === 'EPERM') ? '서버 실행 환경에서 NovelAI 접속이 차단됐습니다. start-local.cmd로 서버를 다시 실행해 주세요.' : 'NovelAI에 접속하지 못했습니다. 인터넷·방화벽·프록시 설정을 확인해 주세요.', 'IMAGE_NETWORK_ERROR', 502);
  }
  if (!response.ok) {
    let detail = '';
    try { const data = JSON.parse(raw.toString('utf8')); detail = typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error : ''; } catch {}
    detail = detail.split(token).join('[숨김]').slice(0, 1500);
    const hint = { 401: 'Persistent API Token을 확인해 주세요.', 402: '구독 상태와 Anlas 잔액을 확인해 주세요.', 403: '토큰 권한과 선택한 모델의 사용 가능 여부를 확인해 주세요.', 429: 'NovelAI의 요청 제한입니다. 잠시 후 직접 다시 시도해 주세요.' }[response.status] || '';
    throw new ImageTestError(`이미지 생성 실패 (HTTP ${response.status})${detail ? `\n${detail}` : ''}${hint ? `\n${hint}` : ''}`, 'IMAGE_GENERATION_FAILED', response.status >= 400 && response.status <= 599 ? response.status : 502);
  }
  let image;
  try {
    if (raw.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') image = pngImage(raw);
    else if (raw.readUInt32LE(0) === 0x04034b50) image = unzipPng(raw);
    else {
      const data = JSON.parse(raw.toString('utf8'));
      const base64 = data.images?.[0]?.image;
      if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('No image');
      image = pngImage(Buffer.from(base64, 'base64'));
    }
  } catch (error) {
    if (error instanceof ImageTestError) throw error;
    throw new ImageTestError('NovelAI의 이미지 응답을 읽지 못했습니다. PNG 또는 이미지 ZIP/JSON 응답이 필요합니다.', 'INVALID_IMAGE_RESPONSE', 502);
  }
  return { ok: true, image: `data:image/png;base64,${image.toString('base64')}`, width: 1024, height: 1024, model: payload.model };
}
