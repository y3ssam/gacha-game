import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { buildImageTest, testNovelAI, NOVELAI_MODELS, NOVELAI_ENDPOINT } from '../novelai.mjs';
import { createAppServer } from '../server.mjs';
import { makeTestPng, crc32 } from './image-fixture.mjs';
const png = makeTestPng();
const token = 'pst-disposable-test-token';
const input = { token, model:'v5-full', prefix:'test prefix', suffix:'test suffix', negativePrefix:'negative prefix', steps:28, guidance:6.5, rescale:0.35, ucPreset:'none', qualityTags:'standard' };

test('8개 모델 ID, 1024 크기, 사용자 옵션과 태그 및 모델별 프롬프트 구성', () => {
  assert.equal(Object.keys(NOVELAI_MODELS).length, 8);
  for (const [model, spec] of Object.entries(NOVELAI_MODELS)) {
    const { payload } = buildImageTest({ ...input, model });
    assert.equal(payload.model, spec.apiModel);
    assert.equal(payload.action, 'generate');
    assert.match(payload.input, /^test prefix, Spaghetti, eating spaghetti, test suffix/);
    assert.equal(payload.parameters.width, 1024); assert.equal(payload.parameters.height, 1024);
    assert.equal(payload.parameters.scale, 6.5); assert.equal(payload.parameters.cfg_rescale, 0.35); assert.equal(payload.parameters.steps, 28);
    assert.equal(payload.parameters.n_samples, 1);
    assert.ok(Number.isInteger(payload.parameters.seed));
    assert.match(payload.parameters.negative_prompt, /^negative prefix/);
    if (model.endsWith('v3')) assert.equal(payload.parameters.v4_prompt, undefined);
    else assert.equal(payload.parameters.v4_prompt.caption.base_caption, payload.input);
  }
});

test('모델별 UC/품질 프리셋을 실제 프롬프트에 적용하고 미지원 조합 거절', () => {
  for (const [model, spec] of Object.entries(NOVELAI_MODELS)) for (const ucPreset of Object.keys(spec.uc)) for (const qualityTags of Object.keys(spec.quality)) {
    const { payload } = buildImageTest({...input, model, ucPreset, qualityTags});
    if (spec.uc[ucPreset].prefix) assert.ok(payload.parameters.negative_prompt.includes(spec.uc[ucPreset].prefix));
    if (spec.quality[qualityTags].suffix) assert.ok(payload.input.endsWith(spec.quality[qualityTags].suffix));
  }
  for (const change of [{model:'v4-full',qualityTags:'light'}, {model:'furry-v3',ucPreset:'human-focus'}, {steps:51}, {guidance:NaN}, {rescale:-1}, {token:'bad token\n'}, {model:'__proto__'}]) assert.throws(() => buildImageTest({...input,...change}));
});

function zipped(png, deflate) {
  const name = Buffer.from('image_0.png'), data = deflate ? deflateRawSync(png) : png;
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50,0); local.writeUInt16LE(20,4); local.writeUInt16LE(deflate?8:0,8); local.writeUInt32LE(crc32(png),14); local.writeUInt32LE(data.length,18); local.writeUInt32LE(png.length,22); local.writeUInt16LE(name.length,26);
  central.writeUInt32LE(0x02014b50,0); central.writeUInt16LE(20,6); central.writeUInt16LE(deflate?8:0,10); central.writeUInt32LE(crc32(png),16); central.writeUInt32LE(data.length,20); central.writeUInt32LE(png.length,24); central.writeUInt16LE(name.length,28);
  end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(1,8); end.writeUInt16LE(1,10); end.writeUInt32LE(central.length+name.length,12); end.writeUInt32LE(local.length+name.length+data.length,16);
  return Buffer.concat([local,name,data,central,name,end]);
}

test('공식 주소·Bearer 인증·JSON 요청과 JSON/PNG/ZIP 응답 복원', async () => {
  for (const body of [JSON.stringify({images:[{image:png.toString('base64')}]}), png, zipped(png,false), zipped(png,true)]) {
    let calls = 0;
    const result = await testNovelAI(input, {fetchImpl:async(url, options)=>{
      calls++; assert.equal(url,NOVELAI_ENDPOINT); assert.equal(options.headers.Authorization,`Bearer ${token}`); assert.equal(options.headers.Accept,'application/json');
      assert.equal(JSON.parse(options.body).parameters.height,1024); assert.equal(options.redirect,'error');
      return new Response(body,{status:201});
    }});
    assert.equal(calls,1); assert.equal(result.image,`data:image/png;base64,${png.toString('base64')}`);
    assert.ok(!JSON.stringify(result).includes(token));
  }
});

test('인증·크레딧·요청 제한 오류는 토큰을 숨기고 자동 재시도하지 않음', async () => {
  for (const status of [401,402,429,500]) {
    let count=0;
    await assert.rejects(testNovelAI(input,{fetchImpl:async()=>{count++;return new Response(JSON.stringify({message:`upstream error ${token}`}),{status});}}), error=>error.status===status&&!error.message.includes(token));
    assert.equal(count,1);
  }
  for(const body of ['{}','not-json',makeTestPng(1,1)]) await assert.rejects(testNovelAI(input,{fetchImpl:async()=>new Response(body,{status:201})}));
  await assert.rejects(testNovelAI(input,{signal:AbortSignal.abort(),fetchImpl:async()=>{throw new Error();}}),error=>error.code==='IMAGE_TIMEOUT');
});

test('이미지 테스트 로컬 API 출처 검사와 결과 전달', async () => {
  let hits=0;
  const app=createAppServer({testImage:async body=>{hits++;assert.equal(body.token,token);return {ok:true,image:`data:image/png;base64,${png.toString('base64')}`,width:1024,height:1024};}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.address().port}`;
  try {
    const post=origin=>fetch(base+'/api/images/test',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(input)});
    assert.equal((await post('https://other.invalid')).status,403); assert.equal(hits,0);
    const response=await post(base); assert.equal(response.status,200); assert.ok((await response.json()).image.startsWith('data:image/png;base64,')); assert.equal(hits,1);
  }finally{await new Promise(resolve=>app.close(resolve));}
});
