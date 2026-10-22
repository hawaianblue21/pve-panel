// Disk images uploaded from the browser for a template import (VMDK from VMware, or a
// qcow2 / raw disk that is not on the internet).
//
//   Create     name and size first: the panel checks the type, the size limit and its own
//              free disk space, and makes an empty file under UPLOAD_DIR.
//   Chunks     PUT with ?offset=<bytes received so far>: an interrupted upload continues
//              where it stopped (the browser asks for the offset again).
//   Complete   when every byte is there, the panel works out the SHA-256 (shown, and
//              compared with a checksum given for the import).
//   Clean-up   the import sends the file to Proxmox and then removes it; uploads not
//              finished within a day, or not used within a week, are removed.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { db, audit } from './db.js';
import { config } from './config.js';

const fail = (status, message) => Object.assign(new Error(message), { statusCode: status, expose: true });
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(path.resolve(config.dbPath)), 'uploads');
const MAX_BYTES = Math.max(1, Number(process.env.TEMPLATE_UPLOAD_MAX_GB || 200)) * 2 ** 30;
export const CHUNK_MAX = 64 * 2 ** 20;
const EXT = /\.(vmdk|qcow2|raw|img)$/i;
const nowIso = () => new Date().toISOString();
const fileOf = (id) => path.join(UPLOAD_DIR, `${id}.part`);
const rowOf = (id) => db.prepare('SELECT * FROM template_uploads WHERE id = ?').get(String(id));

export const pubUpload = (r) => ({
  id: r.id, filename: r.filename, size: r.size, received: r.received, complete: !!r.completed_at, sha256: r.sha256, createdAt: r.created_at,
});

export async function createUpload(req, { filename, size }) {
  const name = path.basename(String(filename ?? '')).replace(/[^\w.-]/g, '_');
  if (!EXT.test(name)) throw fail(400, 'A disk image: .vmdk, .qcow2, .raw or .img');
  const bytes = Number(size);
  if (!Number.isInteger(bytes) || bytes < 1) throw fail(400, 'Give the file size');
  if (bytes > MAX_BYTES) throw fail(413, `Up to ${Math.round(MAX_BYTES / 2 ** 30)} GB (TEMPLATE_UPLOAD_MAX_GB)`);
  await fs.promises.mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  const free = await fs.promises.statfs(UPLOAD_DIR).then((s) => s.bavail * s.bsize).catch(() => Infinity);
  const reserved = db.prepare('SELECT COALESCE(SUM(size - received), 0) AS n FROM template_uploads WHERE completed_at IS NULL').get().n;
  if (bytes + reserved + 2 ** 30 > free) throw fail(507, 'Not enough free disk space on the panel for this file');
  const id = crypto.randomBytes(12).toString('hex');
  await fs.promises.writeFile(fileOf(id), '', { mode: 0o600 });
  db.prepare('INSERT INTO template_uploads (id, filename, size, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(id, name, bytes, req.account?.id ?? null, nowIso());
  audit(req, null, 'admin_template_upload_started', { id, filename: name, size: bytes });
  return pubUpload(rowOf(id));
}

export function uploadStatus(id) {
  const r = rowOf(id);
  if (!r) throw fail(404, 'Upload not found');
  return pubUpload(r);
}

const busy = new Set();

/** Appends a chunk at `offset` (must equal what was received so far). */
export async function appendChunk(id, offset, stream) {
  const r = rowOf(id);
  if (!r) throw fail(404, 'Upload not found');
  if (r.completed_at) throw fail(409, 'This upload is complete');
  if (Number(offset) !== r.received) throw Object.assign(fail(409, `Continue at byte ${r.received}`), { received: r.received });
  if (busy.has(id)) throw fail(409, 'A chunk of this upload is being written');
  busy.add(id);
  let n = 0;
  try {
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        n += chunk.length;
        if (n > CHUNK_MAX) return cb(fail(413, `Chunks of up to ${CHUNK_MAX / 2 ** 20} MB`));
        if (r.received + n > r.size) return cb(fail(400, 'More data than the size given'));
        return cb(null, chunk);
      },
    });
    await pipeline(stream, counter, fs.createWriteStream(fileOf(id), { flags: 'r+', start: r.received }));
    const received = r.received + n;
    db.prepare('UPDATE template_uploads SET received = ? WHERE id = ?').run(received, id);
    if (received === r.size) {
      const hash = crypto.createHash('sha256');
      await pipeline(fs.createReadStream(fileOf(id)), hash);
      db.prepare('UPDATE template_uploads SET sha256 = ?, completed_at = ? WHERE id = ?').run(hash.digest('hex'), nowIso(), id);
    }
  } catch (err) {
    // keep only what was written completely: the browser re-sends from the recorded offset
    await fs.promises.truncate(fileOf(id), rowOf(id).received).catch(() => {});
    throw err;
  } finally {
    busy.delete(id);
  }
  return pubUpload(rowOf(id));
}

export async function removeUpload(id) {
  await fs.promises.rm(fileOf(id), { force: true });
  db.prepare('DELETE FROM template_uploads WHERE id = ?').run(String(id));
}

/** The finished upload behind an import source "upload:<id>". */
export function completedUpload(id) {
  const r = rowOf(id);
  if (!r || !r.completed_at) return null;
  return { ...pubUpload(r), path: fileOf(r.id) };
}

/** Unfinished after a day, or unused after a week: removed. */
export async function cleanUploads() {
  const day = new Date(Date.now() - 86_400_000).toISOString();
  const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const used = db.prepare("SELECT 1 FROM template_imports WHERE source = ? AND state NOT IN ('ready', 'failed')");
  for (const r of db.prepare('SELECT * FROM template_uploads WHERE (completed_at IS NULL AND created_at < ?) OR (completed_at IS NOT NULL AND completed_at < ?)').all(day, week)) {
    if (used.get(`upload:${r.id}`)) continue;
    await removeUpload(r.id);
  }
}
