import { deflateSync } from 'node:zlib';
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function makeTestPng(width = 1024, height = 1024) {
  const chunk = (name, content) => {
    const type = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(content.length); crc.writeUInt32BE(crc32(Buffer.concat([type, content])));
    return Buffer.concat([size, type, content, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * (width * 3 + 1) + 1 + x * 3;
    pixels[i] = 60 + Math.floor(x / width * 130); pixels[i + 1] = 100 + Math.floor(y / height * 100); pixels[i + 2] = 170;
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
