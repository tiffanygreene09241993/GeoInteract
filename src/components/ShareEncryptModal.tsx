import React, { useEffect, useState } from 'react';
import {
  Check,
  CloudUpload,
  Copy,
  Download,
  KeyRound,
  Lock,
  Share2,
  ShieldCheck,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { User } from 'firebase/auth';
import { CollaboratorMember, Trip } from '../types/travel';
import {
  exportEncryptedTripKeyBundle,
  getOrCreateTripKey,
  getVaultSecurityStatus,
  importEncryptedTripKeyBundle,
  VaultSecurityStatus,
} from '../utils/e2ee';
import { triggerHaptic } from '../utils/haptics';

interface ShareEncryptModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeTrip: Trip | null;
  user: User | null;
  members: CollaboratorMember[];
  onSignIn: () => Promise<void>;
  onSyncLocalTrip: () => Promise<void>;
  onCreateShareLink: (role: 'editor' | 'viewer') => Promise<string>;
  onKeyRestored?: (tripId: string, fingerprint: string) => void;
}

export const ShareEncryptModal: React.FC<ShareEncryptModalProps> = ({
  isOpen,
  onClose,
  activeTrip,
  user,
  members,
  onSignIn,
  onSyncLocalTrip,
  onCreateShareLink,
  onKeyRestored,
}) => {
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [shareUrl, setShareUrl] = useState<string>('');
  const [sampleDemoUrl, setSampleDemoUrl] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [vaultStatus, setVaultStatus] = useState<VaultSecurityStatus | null>(null);
  const [recoveryMode, setRecoveryMode] = useState<'none' | 'export' | 'import'>('none');
  const [passphrase, setPassphrase] = useState('');
  const [backupOutput, setBackupOutput] = useState('');
  const [backupInput, setBackupInput] = useState('');
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    void getVaultSecurityStatus().then(setVaultStatus);
  }, [isOpen, activeTrip?.id]);

  if (!isOpen || !activeTrip) return null;

  const isCloudSynced = Boolean(user && activeTrip.collaboratorUids.includes(user.uid));

  const handleGenerate = async () => {
    setBusy(true);
    setError(null);
    triggerHaptic('medium');
    try {
      const link = await onCreateShareLink(role);
      setShareUrl(link);
      triggerHaptic('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to generate encrypted invite link.');
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateSampleDemoLink = async () => {
    setBusy(true);
    setError(null);
    triggerHaptic('light');
    try {
      const { fingerprint } = await getOrCreateTripKey(activeTrip.id);
      const base = `${window.location.origin}${window.location.pathname}`;
      setSampleDemoUrl(
        `${base}?demoTrip=${encodeURIComponent(activeTrip.id)}&role=${role}#key=DEMO_LOCAL_ONLY_${fingerprint}`
      );
      triggerHaptic('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to preview demo invite.');
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async (textToCopy: string) => {
    if (!textToCopy) return;
    triggerHaptic('light');
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError('Clipboard access blocked. Copy the URL manually.');
    }
  };

  const handleNativeShare = async () => {
    if (!shareUrl || typeof navigator.share !== 'function') return;
    triggerHaptic('light');
    try {
      await navigator.share({
        title: `Join "${activeTrip.title}" on GeoInteract`,
        text: `Collaborate on our end-to-end encrypted itinerary for ${activeTrip.destination}.`,
        url: shareUrl,
      });
    } catch {
      // User dismissed share sheet
    }
  };

  const handleExportRecoveryBundle = async () => {
    setRecoveryBusy(true);
    setRecoveryError(null);
    setRecoveryNotice(null);
    try {
      const bundle = await exportEncryptedTripKeyBundle(activeTrip.id, passphrase, activeTrip.title);
      const json = JSON.stringify(bundle, null, 2);
      setBackupOutput(json);
      setRecoveryNotice(
        'Encrypted key backup generated using PBKDF2-SHA256 + AES-GCM-256. Save it safely; your passphrase is never stored.'
      );
      triggerHaptic('success');
    } catch (err) {
      setRecoveryError(err instanceof Error ? err.message : 'Unable to create key backup.');
    } finally {
      setRecoveryBusy(false);
    }
  };

  const handleDownloadRecoveryFile = () => {
    if (!backupOutput) return;
    const blob = new Blob([backupOutput], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const slug = activeTrip.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'trip';
    a.href = url;
    a.download = `geointeract-key-${slug}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    triggerHaptic('light');
  };

  const handleImportRecoveryBundle = async () => {
    setRecoveryBusy(true);
    setRecoveryError(null);
    setRecoveryNotice(null);
    try {
      const res = await importEncryptedTripKeyBundle(backupInput, passphrase);
      const updatedStatus = await getVaultSecurityStatus();
      setVaultStatus(updatedStatus);
      setBackupInput('');
      setPassphrase('');
      setRecoveryNotice(
        `Recovered key (fingerprint ${res.fingerprint}) into your encrypted IndexedDB device vault.`
      );
      onKeyRestored?.(res.tripId, res.fingerprint);
      triggerHaptic('success');
    } catch (err) {
      setRecoveryError(err instanceof Error ? err.message : 'Unable to restore key backup.');
    } finally {
      setRecoveryBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-modal-title"
    >
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121824] shadow-2xl overflow-hidden flex flex-col max-h-[90dvh]">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-500 shrink-0">
              <Lock className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2
                id="share-modal-title"
                className="text-base font-semibold text-slate-900 dark:text-slate-100 truncate"
              >
                End-to-End Encrypted Sharing &amp; Vault
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                {activeTrip.title} · {activeTrip.destination}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onClose();
            }}
            aria-label="Close share dialog"
            className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 min-h-[44px] min-w-[44px] flex items-center justify-center"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4">
          {/* Hardened Device-Bound E2EE Key Vault Verification */}
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/8 p-3.5 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                <ShieldCheck className="w-4 h-4" />
                Encrypted Device Vault Required
              </span>
              <span className="text-xs font-mono text-emerald-600 dark:text-emerald-400">
                {activeTrip.encryptionAlgo}
              </span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              Trip keys are wrapped inside a non-extractable Web Crypto IndexedDB vault—never written to plaintext <code className="font-mono">localStorage</code>. Invite keys travel only in the URL fragment (<code className="font-mono">#key=</code>) and never reach servers.
            </p>
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs font-mono text-slate-500 dark:text-slate-400 tabular-nums">
              <span className="inline-flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5 text-emerald-500" />
                Fingerprint: {activeTrip.keyFingerprint}
              </span>
              {vaultStatus && (
                <span>
                  {vaultStatus.vaultAvailable
                    ? `Vault active · ${vaultStatus.legacyPlaintextKeyCount} legacy plaintext keys`
                    : 'Memory-only session (IndexedDB restricted)'}
                </span>
              )}
            </div>
          </div>

          {/* Auth & Cloud Sync Gate + Safe Local Demo Invite Preview */}
          {!user ? (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#182030] p-4 space-y-3">
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                Sign in with Google for live cloud sharing, or preview locally
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Your trip is already encrypted in your device vault. Sign in to sync encrypted updates with collaborators, or preview how zero-knowledge URL fragment invites work right now.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void onSignIn()}
                  className="flex-1 rounded-xl bg-emerald-500 text-slate-950 font-semibold text-xs py-2.5 px-3 hover:bg-emerald-400 transition-colors min-h-[44px] whitespace-nowrap"
                >
                  Continue with Google
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleGenerateSampleDemoLink()}
                  className="rounded-xl border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 font-medium text-xs py-2.5 px-3 hover:border-emerald-500/50 transition-colors min-h-[44px] whitespace-nowrap"
                >
                  Preview Sample Invite
                </button>
              </div>

              {sampleDemoUrl && (
                <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] p-3 space-y-2">
                  <div className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                    Sample Zero-Knowledge Link (Local Preview · No Cloud Upload)
                  </div>
                  <div className="text-[11px] font-mono text-slate-600 dark:text-slate-300 break-all">
                    {sampleDemoUrl}
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleCopy(sampleDemoUrl)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-emerald-500/50 min-h-[36px]"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? 'Copied Preview' : 'Copy Preview Link'}
                  </button>
                </div>
              )}
            </div>
          ) : !isCloudSynced ? (
            <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-4 space-y-3">
              <p className="text-xs text-amber-800 dark:text-amber-200">
                This trip is currently stored only in your local encrypted vault. Sync it to your account before inviting collaborators.
              </p>
              <button
                type="button"
                onClick={() => void onSyncLocalTrip()}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-amber-500 text-slate-950 font-semibold text-sm py-2.5 hover:bg-amber-400 transition-colors min-h-[44px]"
              >
                <CloudUpload className="w-4 h-4" />
                Encrypt &amp; Sync Trip to Cloud
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor="invite-role"
                  className="text-xs font-medium text-slate-600 dark:text-slate-300"
                >
                  Collaborator Permission
                </label>
                <select
                  id="invite-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] px-3 py-1.5 text-xs text-slate-900 dark:text-slate-100 min-h-[38px]"
                >
                  <option value="editor">Editor (Add/Edit Stops &amp; Geofences)</option>
                  <option value="viewer">Viewer (Read &amp; Chat)</option>
                </select>
              </div>

              <button
                type="button"
                disabled={busy}
                onClick={() => void handleGenerate()}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 text-slate-950 font-semibold text-sm py-2.5 hover:bg-emerald-400 disabled:opacity-50 transition-colors min-h-[44px]"
              >
                <Share2 className="w-4 h-4" />
                {busy ? 'Generating Encrypted Invite...' : 'Generate E2EE Invite Link'}
              </button>

              {shareUrl && (
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] p-3 space-y-2.5">
                  <div className="text-[11px] font-mono text-slate-600 dark:text-slate-300 break-all max-h-20 overflow-y-auto">
                    {shareUrl}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleCopy(shareUrl)}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#121824] px-3 py-2 text-xs font-medium text-slate-800 dark:text-slate-200 hover:border-emerald-500/50 min-h-[40px]"
                    >
                      {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                      {copied ? 'Copied Link' : 'Copy Link'}
                    </button>
                    {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
                      <button
                        type="button"
                        onClick={() => void handleNativeShare()}
                        className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3.5 py-2 text-xs font-medium min-h-[40px]"
                      >
                        <Share2 className="w-3.5 h-3.5" />
                        Share
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Deliberate Passphrase-Protected Key Backup & Recovery */}
          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200">
                <KeyRound className="w-3.5 h-3.5 text-amber-500" />
                <span>Encrypted Key Backup &amp; Recovery</span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('light');
                    setRecoveryMode((m) => (m === 'export' ? 'none' : 'export'));
                    setRecoveryError(null);
                    setRecoveryNotice(null);
                  }}
                  className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium min-h-[34px] whitespace-nowrap ${
                    recoveryMode === 'export'
                      ? 'border-emerald-500/60 bg-emerald-500/12 text-emerald-600 dark:text-emerald-300'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-emerald-500/50'
                  }`}
                >
                  <Download className="w-3 h-3" />
                  Backup Key
                </button>
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('light');
                    setRecoveryMode((m) => (m === 'import' ? 'none' : 'import'));
                    setRecoveryError(null);
                    setRecoveryNotice(null);
                  }}
                  className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium min-h-[34px] whitespace-nowrap ${
                    recoveryMode === 'import'
                      ? 'border-sky-500/60 bg-sky-500/12 text-sky-600 dark:text-sky-300'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-sky-500/50'
                  }`}
                >
                  <Upload className="w-3 h-3" />
                  Restore Key
                </button>
              </div>
            </div>

            {recoveryMode === 'export' && (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] p-3 space-y-2.5">
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  Protect this trip&apos;s key with a passphrase (min. 8 characters) to move or recover encrypted trips across devices without plaintext browser storage.
                </p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder="Choose recovery passphrase (8+ chars)"
                    aria-label="Recovery passphrase"
                    className="flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#121824] px-3 py-2 text-xs text-slate-900 dark:text-slate-100 min-h-[40px]"
                  />
                  <button
                    type="button"
                    disabled={recoveryBusy || passphrase.trim().length < 8}
                    onClick={() => void handleExportRecoveryBundle()}
                    className="rounded-lg bg-emerald-500 text-slate-950 font-semibold text-xs px-3.5 py-2 hover:bg-emerald-400 disabled:opacity-45 min-h-[40px] whitespace-nowrap"
                  >
                    {recoveryBusy ? 'Encrypting...' : 'Create Backup'}
                  </button>
                </div>

                {backupOutput && (
                  <div className="space-y-2">
                    <textarea
                      readOnly
                      value={backupOutput}
                      rows={4}
                      aria-label="Encrypted key backup JSON"
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121824] p-2 text-[11px] font-mono text-slate-600 dark:text-slate-300"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleDownloadRecoveryFile}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-3 py-2 text-xs font-medium min-h-[38px]"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Download .json
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleCopy(backupOutput)}
                        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 min-h-[38px]"
                      >
                        <Copy className="w-3.5 h-3.5" />
                        Copy JSON
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {recoveryMode === 'import' && (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] p-3 space-y-2.5">
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Paste your encrypted <code className="font-mono">geointeract-key-backup-v1</code> JSON bundle and enter the passphrase used during backup.
                </p>
                <textarea
                  value={backupInput}
                  onChange={(e) => setBackupInput(e.target.value)}
                  rows={4}
                  placeholder='{"format":"geointeract-key-backup-v1", ...}'
                  aria-label="Paste encrypted key backup JSON"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#121824] p-2 text-[11px] font-mono text-slate-800 dark:text-slate-200"
                />
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder="Enter recovery passphrase"
                    aria-label="Recovery passphrase for restore"
                    className="flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#121824] px-3 py-2 text-xs text-slate-900 dark:text-slate-100 min-h-[40px]"
                  />
                  <button
                    type="button"
                    disabled={recoveryBusy || !backupInput.trim() || !passphrase.trim()}
                    onClick={() => void handleImportRecoveryBundle()}
                    className="rounded-lg bg-sky-500 text-slate-950 font-semibold text-xs px-3.5 py-2 hover:bg-sky-400 disabled:opacity-45 min-h-[40px] whitespace-nowrap"
                  >
                    {recoveryBusy ? 'Restoring...' : 'Restore to Vault'}
                  </button>
                </div>
              </div>
            )}

            {recoveryNotice && (
              <div className="rounded-lg border border-emerald-500/35 bg-emerald-500/10 p-2.5 text-xs text-emerald-700 dark:text-emerald-300">
                {recoveryNotice}
              </div>
            )}
            {recoveryError && (
              <div className="rounded-lg border border-rose-500/35 bg-rose-500/10 p-2.5 text-xs text-rose-500">
                {recoveryError}
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-lg border border-rose-500/35 bg-rose-500/10 p-2.5 text-xs text-rose-500">
              {error}
            </div>
          )}

          {/* Collaborators Roster */}
          <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-300">
              <span className="inline-flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-sky-500" />
                Linked Accounts ({Math.max(activeTrip.collaboratorUids.length, members.length)})
              </span>
              <span className="text-slate-400 font-normal">Real-time sync</span>
            </div>

            <div className="space-y-1.5">
              {members.length > 0 ? (
                members.map((m) => (
                  <div
                    key={m.uid}
                    className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                  >
                    <span className="font-medium text-slate-800 dark:text-slate-200 truncate">
                      {m.displayName}
                    </span>
                    <span className="text-slate-500 dark:text-slate-400 capitalize">{m.role}</span>
                  </div>
                ))
              ) : (
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs text-slate-500 dark:text-slate-400 flex items-center justify-between">
                  <span>{user?.displayName || 'Local Explorer'}</span>
                  <span>Owner</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
