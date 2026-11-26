const LEGACY_KEY_STORAGE_PREFIX = 'waypost_e2ee_key_';
const VAULT_DB_NAME = 'waypost-key-vault';
const VAULT_DB_VERSION = 1;
const MASTER_KEY_ID = 'device_master_aes_gcm_256';
const PBKDF2_ITERATIONS = 210_000;

interface WrappedTripKeyRecord {
  tripId: string;
  encryptedKey: string;
  iv: string;
  fingerprint: string;
  updatedAt: number;
}

export interface EncryptedKeyBackupBundle {
  format: 'geointeract-key-backup-v1';
  tripId: string;
  tripTitle?: string;
  fingerprint: string;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  exportedAt: number;
}

export interface VaultSecurityStatus {
  vaultAvailable: boolean;
  legacyPlaintextKeyCount: number;
  vaultTripKeyCount: number;
}

let cachedMasterKeyPromise: Promise<CryptoKey | null> | null = null;
const memoryTripKeyCache = new Map<string, { key: CryptoKey; rawBase64: string; fingerprint: string }>();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function openVaultDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VAULT_DB_NAME, VAULT_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('masterKeys')) {
        db.createObjectStore('masterKeys', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('tripKeys')) {
        db.createObjectStore('tripKeys', { keyPath: 'tripId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Returns a device-bound NON-EXTRACTABLE AES-GCM-256 CryptoKey stored directly
 * in IndexedDB. Raw key bytes can never be read by scripts or localStorage.
 */
export async function getDeviceVaultMasterKey(): Promise<CryptoKey | null> {
  if (typeof indexedDB === 'undefined' || !crypto?.subtle) return null;
  if (cachedMasterKeyPromise) return cachedMasterKeyPromise;

  cachedMasterKeyPromise = (async () => {
    try {
      const db = await openVaultDB();
      const existing = await new Promise<CryptoKey | null>((resolve, reject) => {
        const tx = db.transaction('masterKeys', 'readonly');
        const req = tx.objectStore('masterKeys').get(MASTER_KEY_ID);
        req.onsuccess = () => resolve((req.result?.key as CryptoKey) || null);
        req.onerror = () => reject(req.error);
      });
      if (existing) return existing;

      // Non-extractable master key: browser holds raw material securely inside IndexedDB
      const masterKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('masterKeys', 'readwrite');
        tx.objectStore('masterKeys').put({ id: MASTER_KEY_ID, key: masterKey, createdAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      return masterKey;
    } catch {
      return null;
    }
  })();

  return cachedMasterKeyPromise;
}

export async function generateTripKey(): Promise<{ key: CryptoKey; rawBase64: string; fingerprint: string }> {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  const rawBase64 = toBase64Url(raw);
  const fingerprint = await computeKeyFingerprint(raw);
  return { key, rawBase64, fingerprint };
}

export async function importTripKey(rawBase64: string): Promise<{ key: CryptoKey; fingerprint: string }> {
  const raw = fromBase64Url(rawBase64);
  if (raw.byteLength !== 32) {
    throw new Error('Invalid trip key length (expected 256-bit AES key).');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    raw as BufferSource,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  const fingerprint = await computeKeyFingerprint(raw);
  return { key, fingerprint };
}

export async function computeKeyFingerprint(rawBytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', rawBytes as BufferSource);
  const hex = Array.from(new Uint8Array(digest))
    .slice(0, 6)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.toUpperCase();
}

export async function encryptJson(
  key: CryptoKey,
  data: unknown
): Promise<{ encryptedPayload: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );
  return {
    encryptedPayload: toBase64Url(new Uint8Array(cipherBuffer)),
    iv: toBase64Url(iv),
  };
}

export async function decryptJson<T>(
  key: CryptoKey,
  encryptedPayload: string,
  iv: string
): Promise<T> {
  const cipherBytes = fromBase64Url(encryptedPayload);
  const ivBytes = fromBase64Url(iv);
  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes as BufferSource },
    key,
    cipherBytes as BufferSource
  );
  const text = new TextDecoder().decode(plainBuffer);
  return JSON.parse(text) as T;
}

/**
 * Encrypts sensitive local IndexedDB payloads at rest using the non-extractable
 * device Vault Master Key.
 */
export async function encryptForLocalVault(
  data: unknown
): Promise<{ encryptedPayload: string; iv: string } | null> {
  const masterKey = await getDeviceVaultMasterKey();
  if (!masterKey) return null;
  try {
    return await encryptJson(masterKey, data);
  } catch {
    return null;
  }
}

export async function decryptFromLocalVault<T>(
  encryptedPayload: string,
  iv: string
): Promise<T | null> {
  const masterKey = await getDeviceVaultMasterKey();
  if (!masterKey) return null;
  try {
    return await decryptJson<T>(masterKey, encryptedPayload, iv);
  } catch {
    return null;
  }
}

/**
 * Rounds outer Firestore lat/lng metadata to ~1.1km privacy grid (2 decimal places)
 * while exact 6-decimal coordinates live strictly inside the AES-GCM ciphertext.
 */
export function toCoarsePrivacyCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

async function saveWrappedTripKeyToVault(tripId: string, rawBase64: string, fingerprint: string): Promise<boolean> {
  const masterKey = await getDeviceVaultMasterKey();
  if (!masterKey) return false;
  try {
    const enc = await encryptJson(masterKey, { rawBase64 });
    const db = await openVaultDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('tripKeys', 'readwrite');
      const rec: WrappedTripKeyRecord = {
        tripId,
        encryptedKey: enc.encryptedPayload,
        iv: enc.iv,
        fingerprint,
        updatedAt: Date.now(),
      };
      tx.objectStore('tripKeys').put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    // Scrub any legacy plaintext localStorage key immediately after secure vault write
    try {
      localStorage.removeItem(`${LEGACY_KEY_STORAGE_PREFIX}${tripId}`);
    } catch {
      // Ignore storage access errors
    }
    return true;
  } catch {
    return false;
  }
}

async function loadWrappedTripKeyFromVault(tripId: string): Promise<string | null> {
  const masterKey = await getDeviceVaultMasterKey();
  if (!masterKey) return null;
  try {
    const db = await openVaultDB();
    const rec = await new Promise<WrappedTripKeyRecord | undefined>((resolve, reject) => {
      const tx = db.transaction('tripKeys', 'readonly');
      const req = tx.objectStore('tripKeys').get(tripId);
      req.onsuccess = () => resolve(req.result as WrappedTripKeyRecord | undefined);
      req.onerror = () => reject(req.error);
    });
    if (!rec?.encryptedKey || !rec?.iv) return null;
    const dec = await decryptJson<{ rawBase64: string }>(masterKey, rec.encryptedKey, rec.iv);
    return dec?.rawBase64 || null;
  } catch {
    return null;
  }
}

/**
 * Persists a trip key exclusively into the encrypted IndexedDB vault (with in-memory
 * session caching). Never writes raw trip key material to plaintext localStorage.
 */
export async function saveTripKeyLocally(tripId: string, rawBase64: string): Promise<boolean> {
  const { key, fingerprint } = await importTripKey(rawBase64);
  memoryTripKeyCache.set(tripId, { key, rawBase64, fingerprint });
  return saveWrappedTripKeyToVault(tripId, rawBase64, fingerprint);
}

/**
 * Reads an already-loaded trip key strictly from in-memory session cache.
 * Does not expose or read plaintext localStorage keys directly.
 */
export function getSavedTripKeyRaw(tripId: string): string | null {
  const mem = memoryTripKeyCache.get(tripId);
  return mem ? mem.rawBase64 : null;
}

/**
 * One-way read migration: detects any legacy plaintext localStorage trip keys,
 * wraps them into the device-bound encrypted IndexedDB vault, and deletes the
 * plaintext localStorage entries so existing users never lose access.
 */
export async function migrateAllLegacyKeysToVault(): Promise<{ migrated: number; remaining: number }> {
  const legacyEntries: Array<{ storageKey: string; tripId: string; rawBase64: string }> = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LEGACY_KEY_STORAGE_PREFIX)) {
        const val = localStorage.getItem(k);
        const tripId = k.slice(LEGACY_KEY_STORAGE_PREFIX.length);
        if (val && tripId) {
          legacyEntries.push({ storageKey: k, tripId, rawBase64: val });
        }
      }
    }
  } catch {
    return { migrated: 0, remaining: 0 };
  }

  let migrated = 0;
  for (const entry of legacyEntries) {
    try {
      const { key, fingerprint } = await importTripKey(entry.rawBase64);
      memoryTripKeyCache.set(entry.tripId, { key, rawBase64: entry.rawBase64, fingerprint });
      const stored = await saveWrappedTripKeyToVault(entry.tripId, entry.rawBase64, fingerprint);
      if (stored) {
        migrated += 1;
      }
    } catch {
      // Remove corrupted legacy entry only if unreadable; leave intact otherwise
    }
  }

  let remaining = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LEGACY_KEY_STORAGE_PREFIX)) remaining += 1;
    }
  } catch {
    remaining = 0;
  }

  return { migrated, remaining };
}

export async function getVaultSecurityStatus(): Promise<VaultSecurityStatus> {
  const masterKey = await getDeviceVaultMasterKey();
  let legacyPlaintextKeyCount = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LEGACY_KEY_STORAGE_PREFIX)) legacyPlaintextKeyCount += 1;
    }
  } catch {
    legacyPlaintextKeyCount = 0;
  }

  let vaultTripKeyCount = 0;
  if (masterKey) {
    try {
      const db = await openVaultDB();
      vaultTripKeyCount = await new Promise<number>((resolve, reject) => {
        const tx = db.transaction('tripKeys', 'readonly');
        const req = tx.objectStore('tripKeys').count();
        req.onsuccess = () => resolve(Number(req.result || 0));
        req.onerror = () => reject(req.error);
      });
    } catch {
      vaultTripKeyCount = 0;
    }
  }

  return {
    vaultAvailable: Boolean(masterKey),
    legacyPlaintextKeyCount,
    vaultTripKeyCount,
  };
}

export async function getOrCreateTripKey(tripId: string): Promise<{
  key: CryptoKey;
  rawBase64: string;
  fingerprint: string;
}> {
  const mem = memoryTripKeyCache.get(tripId);
  if (mem) return mem;

  // 1. Try hardened IndexedDB wrapped key vault first
  const vaultRaw = await loadWrappedTripKeyFromVault(tripId);
  if (vaultRaw) {
    try {
      const { key, fingerprint } = await importTripKey(vaultRaw);
      const entry = { key, rawBase64: vaultRaw, fingerprint };
      memoryTripKeyCache.set(tripId, entry);
      return entry;
    } catch {
      // Fall through to legacy migration check or regenerate
    }
  }

  // 2. One-way read-only migration from any legacy localStorage plaintext key
  //    (immediately scrubbed once safely wrapped inside IndexedDB vault)
  let legacyRaw: string | null = null;
  try {
    legacyRaw = localStorage.getItem(`${LEGACY_KEY_STORAGE_PREFIX}${tripId}`);
  } catch {
    legacyRaw = null;
  }
  if (legacyRaw) {
    try {
      const { key, fingerprint } = await importTripKey(legacyRaw);
      const entry = { key, rawBase64: legacyRaw, fingerprint };
      memoryTripKeyCache.set(tripId, entry);
      await saveWrappedTripKeyToVault(tripId, legacyRaw, fingerprint);
      return entry;
    } catch {
      // Regenerate if corrupt
    }
  }

  // 3. Generate fresh AES-GCM-256 trip key & store wrapped in IndexedDB vault
  //    (if IndexedDB is restricted, retain strictly in session memory — never plaintext localStorage)
  const created = await generateTripKey();
  memoryTripKeyCache.set(tripId, created);
  await saveWrappedTripKeyToVault(tripId, created.rawBase64, created.fingerprint);
  return created;
}

async function derivePassphraseKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Creates a deliberate, passphrase-encrypted recovery bundle for a trip key
 * using PBKDF2-SHA256 + AES-GCM-256 so users can back up and restore access
 * across devices without storing plaintext keys in browser storage.
 */
export async function exportEncryptedTripKeyBundle(
  tripId: string,
  passphrase: string,
  tripTitle?: string
): Promise<EncryptedKeyBackupBundle> {
  if (!passphrase || passphrase.trim().length < 8) {
    throw new Error('Use a recovery passphrase with at least 8 characters.');
  }
  const { rawBase64, fingerprint } = await getOrCreateTripKey(tripId);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrappingKey = await derivePassphraseKey(passphrase, salt, PBKDF2_ITERATIONS);
  const enc = await encryptJson(wrappingKey, { tripId, rawBase64, fingerprint });
  return {
    format: 'geointeract-key-backup-v1',
    tripId,
    tripTitle,
    fingerprint,
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    salt: toBase64Url(salt),
    iv: enc.iv,
    ciphertext: enc.encryptedPayload,
    exportedAt: Date.now(),
  };
}

/**
 * Decrypts a passphrase-protected key backup bundle and stores the recovered
 * trip key directly into the encrypted IndexedDB vault.
 */
export async function importEncryptedTripKeyBundle(
  bundleJson: string,
  passphrase: string
): Promise<{ tripId: string; fingerprint: string; storedInVault: boolean }> {
  if (!passphrase || passphrase.trim().length < 1) {
    throw new Error('Enter the recovery passphrase used when exporting this backup.');
  }
  let parsed: EncryptedKeyBackupBundle;
  try {
    parsed = JSON.parse(bundleJson) as EncryptedKeyBackupBundle;
  } catch {
    throw new Error('Invalid key backup format. Paste the full JSON backup bundle.');
  }
  if (
    parsed?.format !== 'geointeract-key-backup-v1' ||
    !parsed.tripId ||
    !parsed.salt ||
    !parsed.iv ||
    !parsed.ciphertext
  ) {
    throw new Error('Unrecognized GeoInteract key backup file.');
  }
  const iterations =
    typeof parsed.iterations === 'number' && parsed.iterations >= 100_000 && parsed.iterations <= 1_000_000
      ? parsed.iterations
      : PBKDF2_ITERATIONS;
  const salt = fromBase64Url(parsed.salt);
  const wrappingKey = await derivePassphraseKey(passphrase, salt, iterations);

  let payload: { tripId: string; rawBase64: string; fingerprint?: string };
  try {
    payload = await decryptJson<{ tripId: string; rawBase64: string; fingerprint?: string }>(
      wrappingKey,
      parsed.ciphertext,
      parsed.iv
    );
  } catch {
    throw new Error('Incorrect passphrase or corrupted key backup.');
  }

  if (!payload?.tripId || !payload?.rawBase64) {
    throw new Error('Backup payload is missing trip key material.');
  }

  const storedInVault = await saveTripKeyLocally(payload.tripId, payload.rawBase64);
  const { fingerprint } = await importTripKey(payload.rawBase64);
  return {
    tripId: payload.tripId,
    fingerprint,
    storedInVault,
  };
}
