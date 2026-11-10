import { randomBytes, createCipheriv, createDecipheriv, scrypt as derive } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(derive);
const PROFILE = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
const inputError = message => Object.assign(new Error(message), { status: 400, code: 'VAULT_INPUT' });
const fail = () => { throw Object.assign(new Error('Vault authentication failed or encrypted data is damaged'), { status: 400, code: 'VAULT_AUTH' }); };
function bytes(value, size) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail();
  const result = Buffer.from(value, 'base64');
  if (size !== undefined && result.length !== size) fail();
  return result;
}
export function validateVaultKey(key) {
  if (typeof key !== 'string' || !key.trim() || [...key.trim()].length > 120 || /[\x00-\x1f\x7f]/.test(key)) throw inputError('Vault key must contain 1–120 characters without control characters');
  return key.trim();
}
export function validateVaultValue(value) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 65536 || value.includes('\0')) throw inputError('Vault value must contain 1–65536 UTF-8 bytes without NUL');
  return value;
}
export function seal(key, plaintext, aad) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
export function unseal(key, envelope, aad) {
  try {
    if (!envelope || envelope.v !== 1) fail();
    const cipher = createDecipheriv('aes-256-gcm', key, bytes(envelope.iv, 12));
    cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(bytes(envelope.tag, 16));
    return Buffer.concat([cipher.update(bytes(envelope.ciphertext)), cipher.final()]);
  } catch { fail(); }
}
const wrappingAAD = 'agent-canvas/vault/wrapped-key/v1';
export const valueAAD = (id, key) => JSON.stringify(['agent-canvas/vault/value/v1', id, key]);
function passwordInput(password) {
  if (typeof password !== 'string' || !password.length || Buffer.byteLength(password) > 1024) throw inputError('Password must contain 1–1024 UTF-8 bytes');
}
export async function newVault(password) {
  passwordInput(password);
  if ([...password].length < 8) throw inputError('Choose a master password with at least 8 characters');
  const salt = randomBytes(16), key = randomBytes(32);
  let wrapping;
  try {
    wrapping = await scrypt(password, salt, 32, PROFILE);
    return { key, config: { version: 1, kdf: 'scrypt-N131072-r8-p1', salt: salt.toString('base64'), wrapped: seal(wrapping, key, wrappingAAD) } };
  } catch (error) { key.fill(0); throw error; }
  finally { wrapping?.fill(0); }
}
export function validateVaultConfig(config) {
  if (!config || config.version !== 1 || config.kdf !== 'scrypt-N131072-r8-p1') fail();
  bytes(config.salt, 16);
  if (!config.wrapped || config.wrapped.v !== 1) fail();
  bytes(config.wrapped.iv, 12); bytes(config.wrapped.tag, 16); bytes(config.wrapped.ciphertext, 32);
  return config;
}
export async function openVault(password, config) {
  passwordInput(password); validateVaultConfig(config);
  const wrapping = await scrypt(password, bytes(config.salt, 16), 32, PROFILE);
  try { return unseal(wrapping, config.wrapped, wrappingAAD); }
  finally { wrapping.fill(0); }
}
