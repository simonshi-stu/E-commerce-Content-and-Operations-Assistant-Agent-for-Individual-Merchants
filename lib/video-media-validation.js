'use strict';

// Byte-level verification is not video verification. Decode only the bytes already
// hashed by the consumer, with no URLs, shell, external tracks or network protocols.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MAX_MEDIA_BYTES = 250 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

function validateVideoBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > MAX_MEDIA_BYTES) return 'MEDIA_SIZE_INVALID';
  // This output contract accepts MP4, not playlists or arbitrary containers.
  if (bytes.toString('ascii', 4, 8) !== 'ftyp') return 'MEDIA_CONTAINER_INVALID';
  let directory;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-decode-'));
    fs.chmodSync(directory, 0o700);
    const file = path.join(directory, 'input.mp4');
    fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
    const input = ['-protocol_whitelist', 'file', '-f', 'mov', '-enable_drefs', '0'];
    const options = { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true, shell: false };
    const probe = spawnSync('ffprobe', ['-v', 'error', ...input, '-show_entries', 'format=duration:stream=codec_type,width,height,duration', '-of', 'json', file], options);
    if (probe.error) return probe.error.code === 'ENOENT' ? 'MEDIA_DECODER_UNAVAILABLE' : 'MEDIA_DECODE_UNAVAILABLE';
    if (probe.status !== 0) return 'MEDIA_DECODE_FAILED';
    let metadata;
    try { metadata = JSON.parse(probe.stdout); } catch { return 'MEDIA_DECODE_FAILED'; }
    const video = metadata.streams?.find((stream) => stream.codec_type === 'video');
    const duration = Number(video?.duration ?? metadata.format?.duration);
    if (!video || !Number.isFinite(duration) || duration <= 0 || duration > 180
      || !Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height)
      || video.width < 1 || video.height < 1 || video.width > 8192 || video.height > 8192) return 'MEDIA_VIDEO_STREAM_INVALID';
    const decoded = spawnSync('ffmpeg', ['-v', 'error', '-xerror', '-err_detect', 'explode', '-threads', '1', ...input,
      '-i', file, '-map', '0:v:0', '-an', '-threads', '1', '-progress', 'pipe:1', '-nostats', '-f', 'null', '-'], options);
    if (decoded.error) return decoded.error.code === 'ENOENT' ? 'MEDIA_DECODER_UNAVAILABLE' : 'MEDIA_DECODE_UNAVAILABLE';
    const frames = [...String(decoded.stdout).matchAll(/^frame=(\d+)$/gm)].map((match) => Number(match[1]));
    return decoded.status === 0 && frames.some((count) => count > 0) ? null : 'MEDIA_DECODE_FAILED';
  } catch {
    return 'MEDIA_DECODE_UNAVAILABLE';
  } finally {
    if (directory) { try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* no secret data in diagnostics */ } }
  }
}

module.exports = { MAX_MEDIA_BYTES, validateVideoBytes };
