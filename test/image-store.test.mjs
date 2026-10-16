import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createConnectionStore } from '../connection-store.mjs';
import { createAppServer } from '../server.mjs';

test('이미지 키와 모든 옵션의 암호화 저장·복원·수정 및 저장된 키로 이미지 테스트', {skip:process.platform!=='win32',timeout:60000}, async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'gacha-image-store-test-'));
  const store=createConnectionStore({directory});
  const token='pst-image-store-test-token';
  const settings={prefix:'접두사\nwith newline',suffix:'접미사',negativePrefix:'네거티브',steps:31,guidance:6.5,rescale:0.35,ucPreset:'human-focus',qualityTags:'light'};
  let tested=0;
  const app=createAppServer({store,testImage:async input=>{assert.equal(input.token,token);tested++;return {ok:true,image:'fixture'};}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.address().port}`;
  const post=(route,body)=>fetch(base+route,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
    const response=await post('/api/connections',{provider:'novelai',name:'내 이미지 모델',model:'v5-full',credentials:token,settings});
    assert.equal(response.status,200);
    const saved=(await response.json()).connection;
    assert.equal(saved.provider,'novelai');assert.equal(saved.name,'내 이미지 모델');assert.deepEqual(saved.settings,settings);
    assert.ok(!JSON.stringify(saved).includes(token));
    const encrypted=await readFile(path.join(directory,'connections.dpapi'),'utf8');
    assert.ok(!encrypted.includes(token));assert.ok(!encrypted.includes(settings.prefix));
    const restored=createConnectionStore({directory});
    const list=await restored.list();assert.equal(list.length,1);assert.deepEqual(list[0].settings,settings);
    assert.equal((await restored.get(saved.id)).credentials,token);
    const updatedSettings={...settings,steps:23,rescale:0.12,prefix:'수정된 접두사'};
    const updated=await post('/api/connections',{id:saved.id,provider:'novelai',name:'수정한 이미지 모델',model:'v5-curated',credentials:'',settings:updatedSettings});
    assert.equal(updated.status,200);assert.equal((await updated.json()).connection.id,saved.id);
    assert.equal((await restored.get(saved.id)).credentials,token);assert.deepEqual((await restored.list())[0].settings,updatedSettings);
    const result=await post('/api/images/test',{id:saved.id,token:'',model:'v5-curated',...updatedSettings});
    assert.equal(result.status,200);assert.equal(tested,1);
    const before=await readFile(path.join(directory,'connections.dpapi'),'utf8');
    assert.equal((await post('/api/connections',{id:saved.id,provider:'novelai',name:'invalid',model:'v4-full',credentials:'',settings:{...settings,qualityTags:'light'}})).status,400);
    assert.equal((await post('/api/connections',{id:saved.id,provider:'vertex',name:'invalid',credentials:''})).status,400);
    assert.equal((await post('/api/connections/test',{id:saved.id,credentials:'',model:'test-model',region:'global'})).status,400);
    assert.equal(await readFile(path.join(directory,'connections.dpapi'),'utf8'),before);
    const publicResponse=await(await fetch(base+'/api/connections')).text();assert.ok(!publicResponse.includes(token));assert.ok(!publicResponse.includes('credentials'));
  }finally{
    await new Promise(resolve=>app.close(resolve));
    await unlink(path.join(directory,'connections.dpapi')).catch(()=>{});
    await rmdir(directory);
  }
});
