// Passkeys (WebAuthn / FIDO2): sign-in with fingerprint, face, device PIN or a
// security key. Phishing-resistant: a passkey only works on the domain it was
// created for, and the browser enforces that.
//
// - Verification by @simplewebauthn/server (signature, origin, RP ID, challenge,
//   signature counter); user verification (biometrics/PIN) is always required,
//   so a passkey sign-in counts as two-factor.
// - Discoverable credentials ("resident keys"): sign-in needs no email.
// - Challenges are single-use and expire after 5 minutes.
// - The user handle inside a passkey is random per account, never the email.

import crypto from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { db } from './db.js';
import { config } from './config.js';
import { brandName } from './branding.js';

const CHALLENGE_MS = 5 * 60 * 1000;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'));

export class PasskeyError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
    this.expose = true;
  }
}

// ---- Relying party (the domain passkeys belong to) ----------------------------------

const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');

/**
 * The domain and origin for this portal: from PANEL_PUBLIC_URL / ADMIN_PUBLIC_URL
 * when set, otherwise the address the browser used. Browsers only allow passkeys
 * on a domain name (or localhost), and only over https (or on localhost).
 */
export function relyingParty(scope, req) {
  const configured = config.oidc.publicUrl[scope];
  const url = configured ? new URL(configured) : new URL(`${req.protocol}://${req.host}`);
  const rpID = url.hostname;
  const secure = url.protocol === 'https:' || rpID === 'localhost' || rpID.endsWith('.localhost');
  const usable = config.passkeys.enabled && !isIp(rpID) && secure;
  return { rpID, origin: url.origin, usable };
}

function requireUsable(rp) {
  if (!config.passkeys.enabled) throw new PasskeyError(404, 'Passkeys are switched off');
  if (!rp.usable) {
    throw new PasskeyError(400, 'Passkeys need the panel to be opened by its domain name over https (or on localhost)');
  }
}

// ---- One-time challenges (kept in memory, short-lived) ------------------------------

const challenges = new Map(); // key -> { challenge, rpID, origin, userId?, expires }
function remember(entry) {
  const key = crypto.randomBytes(24).toString('base64url');
  challenges.set(key, { ...entry, expires: Date.now() + CHALLENGE_MS });
  for (const [k, v] of challenges) if (v.expires < Date.now()) challenges.delete(k);
  return key;
}
function take(key) {
  const entry = key && challenges.get(key);
  if (key) challenges.delete(key); // single use, even if verification fails
  if (!entry || entry.expires < Date.now()) return null;
  return entry;
}

// ---- Registration (signed-in user adds a passkey) ------------------------------------

function userHandle(userId) {
  const row = db.prepare('SELECT webauthn_user_id FROM users WHERE id = ?').get(userId);
  if (row?.webauthn_user_id) return row.webauthn_user_id;
  const handle = crypto.randomBytes(32).toString('base64url');
  db.prepare('UPDATE users SET webauthn_user_id = ? WHERE id = ?').run(handle, userId);
  return handle;
}

export async function registrationOptions(scope, req, user) {
  const rp = relyingParty(scope, req);
  requireUsable(rp);
  const existing = db.prepare('SELECT id, transports FROM passkeys WHERE user_id = ? AND rp_id = ?').all(user.id, rp.rpID);
  const options = await generateRegistrationOptions({
    rpName: brandName(),
    rpID: rp.rpID,
    userName: user.email,
    userDisplayName: user.email,
    userID: fromB64u(userHandle(user.id)),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    timeout: CHALLENGE_MS,
  });
  const key = remember({ challenge: options.challenge, rpID: rp.rpID, origin: rp.origin, userId: user.id });
  return { options, key };
}

export async function finishRegistration(user, key, response, name) {
  const pending = take(key);
  if (!pending || pending.userId !== user.id) throw new PasskeyError(400, 'This request expired. Please try again.');
  let result;
  try {
    result = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: pending.origin,
      expectedRPID: pending.rpID,
      requireUserVerification: true,
    });
  } catch (err) {
    throw new PasskeyError(400, `The passkey could not be verified: ${err.message}`);
  }
  if (!result.verified) throw new PasskeyError(400, 'The passkey could not be verified');
  const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
  if (db.prepare('SELECT 1 FROM passkeys WHERE id = ?').get(credential.id)) {
    throw new PasskeyError(409, 'This passkey is already registered');
  }
  const clean = String(name ?? '').trim().slice(0, 60) || 'Passkey';
  db.prepare(`
    INSERT INTO passkeys (id, user_id, rp_id, public_key, counter, transports, device_type, backed_up, name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    credential.id, user.id, pending.rpID, b64u(credential.publicKey), credential.counter,
    JSON.stringify(credential.transports ?? []), credentialDeviceType, credentialBackedUp ? 1 : 0, clean,
  );
  return { id: credential.id, name: clean, synced: credentialDeviceType === 'multiDevice' };
}

// ---- Sign-in -------------------------------------------------------------------------

export async function authenticationOptions(scope, req) {
  const rp = relyingParty(scope, req);
  requireUsable(rp);
  // No allowCredentials: the browser offers the passkeys it has for this domain.
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'required', timeout: CHALLENGE_MS });
  const key = remember({ challenge: options.challenge, rpID: rp.rpID, origin: rp.origin });
  return { options, key };
}

/** Verifies a sign-in; returns the user row. Same error for every failure reason. */
export async function finishAuthentication(key, response) {
  const refused = () => new PasskeyError(401, 'This passkey was not accepted. Use a passkey registered for this panel.');
  const pending = take(key);
  if (!pending) throw new PasskeyError(401, 'The sign-in took too long. Please try again.');
  const stored = typeof response?.id === 'string' ? db.prepare('SELECT * FROM passkeys WHERE id = ?').get(response.id) : null;
  if (!stored || stored.rp_id !== pending.rpID) throw refused();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(stored.user_id);
  if (!user || user.deleting) throw refused();
  // The passkey also says whose it is; it must match the account it's stored for.
  const handle = response.response?.userHandle;
  if (handle && user.webauthn_user_id && handle !== user.webauthn_user_id) throw refused();

  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: pending.origin,
      expectedRPID: pending.rpID,
      credential: {
        id: stored.id,
        publicKey: fromB64u(stored.public_key),
        counter: stored.counter,
        transports: stored.transports ? JSON.parse(stored.transports) : undefined,
      },
      requireUserVerification: true,
    });
  } catch {
    throw refused();
  }
  if (!result.verified) throw refused();
  db.prepare("UPDATE passkeys SET counter = ?, backed_up = ?, last_used_at = datetime('now') WHERE id = ?")
    .run(result.authenticationInfo.newCounter, result.authenticationInfo.credentialBackedUp ? 1 : 0, stored.id);
  return user;
}

// ---- Management ------------------------------------------------------------------------

export function listPasskeys(userId) {
  return db.prepare(`
    SELECT id, name, rp_id AS domain, device_type AS deviceType, backed_up AS backedUp,
           created_at AS createdAt, last_used_at AS lastUsedAt
    FROM passkeys WHERE user_id = ? ORDER BY created_at`).all(userId)
    .map((p) => ({ ...p, synced: p.deviceType === 'multiDevice', backedUp: !!p.backedUp }));
}

export function renamePasskey(userId, id, name) {
  const clean = String(name ?? '').trim().slice(0, 60);
  if (!clean) throw new PasskeyError(400, 'Give the passkey a name');
  const r = db.prepare('UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?').run(clean, id, userId);
  if (!r.changes) throw new PasskeyError(404, 'Passkey not found');
}

export function deletePasskey(userId, id) {
  const r = db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(id, userId);
  if (!r.changes) throw new PasskeyError(404, 'Passkey not found');
}

export function deleteAllPasskeys(userId) {
  return db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(userId).changes;
}

export const passkeyCount = (userId) => db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(userId).n;
