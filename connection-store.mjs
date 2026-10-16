import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export class StoreError extends Error {
  constructor(message, code = 'STORAGE_ERROR', status = 500) {
    super(message); this.code = code; this.status = status;
  }
}

export function windowsProtect(value, decrypt = false) {
  if (process.platform !== 'win32') return Promise.reject(new StoreError('연결 저장은 현재 Windows에서 지원합니다.', 'UNSUPPORTED_OS'));
  return new Promise((resolve, reject) => {
    const operation = decrypt ? 'Unprotect' : 'Protect';
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $data=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $result=[System.Security.Cryptography.ProtectedData]::${operation}($data,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (error) reject(new StoreError('Windows 암호화 저장소에 접근하지 못했습니다. 같은 Windows 계정으로 서버를 실행했는지 확인해 주세요.', 'ENCRYPTION_ERROR'));
      else resolve(result);
    };
    const timer = setTimeout(() => { child.kill(); finish(true); }, 15000);
    child.stdout.on('data', chunk => { output += chunk.toString('ascii'); if (output.length > 4 * 1024 * 1024) { child.kill(); finish(true); } });
    child.stderr.resume();
    child.on('error', () => finish(true));
    child.stdin.on('error', () => finish(true));
    child.on('close', code => {
      const result = output.trim();
      if (code !== 0 || !result || !/^[A-Za-z0-9+/=]+$/.test(result)) return finish(true);
      finish(false, decrypt ? Buffer.from(result, 'base64').toString('utf8') : result);
    });
    child.stdin.end(decrypt ? value : Buffer.from(value, 'utf8').toString('base64'));
  });
}

export function createConnectionStore({ directory = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'GachaGame'), protect = windowsProtect } = {}) {
  const filename = path.join(directory, 'connections.dpapi');
  let queue = Promise.resolve();
  const serialize = task => { const job = queue.then(task); queue = job.catch(() => {}); return job; };
  async function load() {
    let encrypted;
    try { encrypted = await readFile(filename, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw new StoreError('저장된 연결 파일을 읽지 못했습니다.'); }
    try {
      const data = JSON.parse(await protect(encrypted, true));
      if (data.version !== 1 || !Array.isArray(data.connections)) throw new Error();
      if (data.connections.some(item => !item || typeof item.id !== 'string' || typeof item.credentials !== 'string' || typeof item.name !== 'string')) throw new Error();
      return data.connections;
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw new StoreError('저장된 연결 파일을 해석하지 못했습니다. 기존 파일은 변경하지 않았습니다.', 'INVALID_STORE');
    }
  }
  const summary = item => ({ id: item.id, name: item.name, provider: item.provider || 'vertex', model: item.model, region: item.region, settings: item.provider === 'novelai' ? item.settings : undefined, createdAt: item.createdAt, updatedAt: item.updatedAt });
  return {
    list: () => serialize(async () => (await load()).map(summary)),
    get: id => serialize(async () => {
      const item = (await load()).find(item => item.id === id);
      if (!item) throw new StoreError('저장된 연결을 찾지 못했습니다.', 'CONNECTION_NOT_FOUND', 404);
      return item;
    }),
    save: input => serialize(async () => {
      const items = await load();
      const existing = input.id ? items.find(item => item.id === input.id) : null;
      if (input.id && !existing) throw new StoreError('수정할 연결을 찾지 못했습니다.', 'CONNECTION_NOT_FOUND', 404);
      const provider = input.provider || 'vertex';
      if (!['vertex', 'novelai'].includes(provider)) throw new StoreError('지원하지 않는 연결 종류입니다.', 'INVALID_PROVIDER', 400);
      if (existing && (existing.provider || 'vertex') !== provider) throw new StoreError('기존 연결의 모델 종류는 변경할 수 없습니다. 새 연결로 추가해 주세요.', 'PROVIDER_MISMATCH', 400);
      const now = new Date().toISOString();
      const item = { id: existing?.id || randomUUID(), provider, name: input.name, model: input.model, region: provider === 'vertex' ? input.region : undefined, settings: provider === 'novelai' ? input.settings : undefined, credentials: input.credentials, createdAt: existing?.createdAt || now, updatedAt: now };
      if (existing) items[items.indexOf(existing)] = item;
      else { if (items.length >= 100) throw new StoreError('저장 가능한 연결은 최대 100개입니다.', 'STORE_FULL', 400); items.push(item); }
      const encrypted = await protect(JSON.stringify({ version: 1, connections: items }));
      const temporary = path.join(directory, `connections-${randomUUID()}.tmp`);
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
        await rename(temporary, filename);
      } catch {
        await unlink(temporary).catch(() => {});
        throw new StoreError('연결을 저장하지 못했습니다. 저장 폴더의 권한과 디스크 공간을 확인해 주세요.');
      }
      return summary(item);
    }),
  };
}
