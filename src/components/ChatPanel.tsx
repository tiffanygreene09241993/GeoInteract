import React, { FormEvent, useEffect, useRef, useState } from 'react';
import {
  Check,
  Compass,
  ExternalLink,
  MapPin,
  Navigation,
  Plus,
  Radio,
  Route,
  Send,
  Sparkles,
  WifiOff,
} from 'lucide-react';
import {
  AgentProposal,
  ChatMessage,
  DiscoveredPlace,
  GroundingMode,
  LatLng,
  Trip,
  TripStop,
  UserPreferences,
} from '../types/travel';
import { triggerHaptic } from '../utils/haptics';
import { sanitizeExternalUrl } from '../utils/url';

interface ChatPanelProps {
  messages: ChatMessage[];
  activeTrip: Trip | null;
  stops: TripStop[];
  userLocation: LatLng;
  prefs: UserPreferences;
  isOffline: boolean;
  onSendMessage: (text: string, groundingMode: GroundingMode) => Promise<void>;
  onAddPlace: (place: DiscoveredPlace) => void;
  onFocusPlace: (place: DiscoveredPlace) => void;
  onRouteToPlace: (place: DiscoveredPlace) => void;
  onApplyProposal: (messageId: string, proposal: AgentProposal) => Promise<void>;
}

const EXPLORER_PROMPTS = [
  'Plan 3 top stops nearby and propose adding them to Day 1',
  'Best specialty coffee & bakeries nearby',
  'Create a geofence alert around the nearest transit hub',
  'Current transit or weather advisories here',
];

export const ChatPanel: React.FC<ChatPanelProps> = ({
  messages,
  activeTrip,
  userLocation,
  isOffline,
  onSendMessage,
  onAddPlace,
  onFocusPlace,
  onRouteToPlace,
  onApplyProposal,
}) => {
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [applyingProposalId, setApplyingProposalId] = useState<string | null>(null);
  const [dismissedProposals, setDismissedProposals] = useState<Record<string, boolean>>({});
  const [groundingMode, setGroundingMode] = useState<GroundingMode>('hybrid');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, isSending]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isSending || isOffline) return;
    setInput('');
    setErrorMsg(null);
    setIsSending(true);
    triggerHaptic('light');
    try {
      await onSendMessage(trimmed, groundingMode);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not reach GeoInteract AI.');
    } finally {
      setIsSending(false);
    }
  };

  const handleQuickPrompt = async (prompt: string) => {
    if (isSending || isOffline) return;
    setErrorMsg(null);
    setIsSending(true);
    triggerHaptic('light');
    try {
      await onSendMessage(prompt, groundingMode);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not reach GeoInteract AI.');
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Grounding Mode Segmented Toggle */}
      <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
        <span className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums truncate">
          {userLocation.lat.toFixed(3)}, {userLocation.lng.toFixed(3)}
        </span>
        <div className="flex items-center gap-1 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/60 shrink-0">
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              setGroundingMode('hybrid');
            }}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
              groundingMode === 'hybrid'
                ? 'bg-white dark:bg-[#121824] text-slate-900 dark:text-slate-100 shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            Search + Places
          </button>
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              setGroundingMode('maps');
            }}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
              groundingMode === 'maps'
                ? 'bg-white dark:bg-[#121824] text-slate-900 dark:text-slate-100 shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            Maps Grounding
          </button>
        </div>
      </div>

      {/* Scrollable Thread */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
          >
            <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mb-1">
              <span>{msg.role === 'user' ? msg.senderName : 'GeoInteract Concierge'}</span>
              <span>·</span>
              <span className="font-mono tabular-nums">
                {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>

            <div
              className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                msg.role === 'user'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-100 dark:bg-[#182030] border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-100'
              }`}
            >
              {msg.text}
            </div>

            {/* Actionable Agent Proposals (One-Tap Apply / Dismiss) */}
            {msg.proposals && msg.proposals.length > 0 && (
              <div className="mt-2.5 w-full space-y-2">
                {msg.proposals
                  .filter((p) => !dismissedProposals[p.id])
                  .map((proposal) => {
                    const isApplying = applyingProposalId === proposal.id;
                    const Icon =
                      proposal.kind === 'create_geofence'
                        ? Radio
                        : proposal.kind === 'optimize_day'
                        ? Route
                        : Sparkles;
                    return (
                      <div
                        key={proposal.id}
                        className="rounded-xl border border-emerald-500/35 bg-emerald-500/8 dark:bg-emerald-500/10 p-3 space-y-2"
                      >
                        <div className="flex items-start gap-2">
                          <Icon className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                              {proposal.summary}
                            </div>
                            {proposal.kind === 'add_stops' && proposal.stops && (
                              <div className="text-[11px] text-slate-600 dark:text-slate-300 mt-0.5">
                                Day {(proposal.dayIndex ?? 0) + 1} ·{' '}
                                {proposal.stops.map((s) => s.name).join(' → ')}
                              </div>
                            )}
                            {proposal.kind === 'create_geofence' && proposal.geofence && (
                              <div className="text-[11px] text-slate-600 dark:text-slate-300 mt-0.5 font-mono tabular-nums">
                                {proposal.geofence.label} · {proposal.geofence.radiusMeters}m ·{' '}
                                {proposal.geofence.triggerOn}
                              </div>
                            )}
                            {proposal.kind === 'optimize_day' && (
                              <div className="text-[11px] text-slate-600 dark:text-slate-300 mt-0.5">
                                Reorders Day {(proposal.dayIndex ?? 0) + 1} waypoints via Google Maps Routes API
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 pt-1 border-t border-emerald-500/20">
                          {proposal.applied ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                              <Check className="w-3.5 h-3.5" />
                              Applied to Trip
                            </span>
                          ) : (
                            <>
                              <button
                                type="button"
                                disabled={isApplying}
                                onClick={async () => {
                                  triggerHaptic('medium');
                                  setApplyingProposalId(proposal.id);
                                  try {
                                    await onApplyProposal(msg.id, proposal);
                                  } finally {
                                    setApplyingProposalId(null);
                                  }
                                }}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 text-slate-950 px-3 py-1.5 text-xs font-semibold hover:bg-emerald-400 disabled:opacity-50 min-h-[36px] whitespace-nowrap"
                              >
                                <Check className="w-3.5 h-3.5" />
                                {isApplying ? 'Applying...' : 'Apply to Trip'}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  triggerHaptic('light');
                                  setDismissedProposals((prev) => ({
                                    ...prev,
                                    [proposal.id]: true,
                                  }));
                                }}
                                className="px-2.5 py-1.5 rounded-lg text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 min-h-[36px]"
                              >
                                Dismiss
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}

            {/* Discovered Places Cards from Real-Time Google Places API */}
            {msg.discoveredPlaces && msg.discoveredPlaces.length > 0 && (
              <div className="mt-2.5 w-full space-y-2">
                {msg.discoveredPlaces.slice(0, 5).map((place, i) => (
                  <div
                    key={place.placeId || `${place.name}_${i}`}
                    className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121824] p-3 space-y-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('light');
                          onFocusPlace(place);
                        }}
                        className="text-left min-w-0 flex-1 group"
                      >
                        <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 group-hover:text-emerald-500 transition-colors truncate">
                          {place.name}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">
                          {place.address}
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 mt-1 tabular-nums">
                          {place.primaryType && <span>{place.primaryType}</span>}
                          {typeof place.rating === 'number' && (
                            <>
                              {place.primaryType && <span>·</span>}
                              <span className="text-amber-500 font-medium">★ {place.rating.toFixed(1)}</span>
                            </>
                          )}
                          {typeof place.openNow === 'boolean' && (
                            <>
                              <span>·</span>
                              <span className={place.openNow ? 'text-emerald-500' : 'text-rose-400'}>
                                {place.openNow ? 'Open now' : 'Closed'}
                              </span>
                            </>
                          )}
                        </div>
                      </button>
                    </div>

                    <div className="flex items-center gap-2 pt-1 border-t border-slate-100 dark:border-slate-800/80">
                      <button
                        type="button"
                        onClick={() => onAddPlace(place)}
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 px-2.5 py-1.5 text-xs font-medium hover:bg-emerald-500/25 transition-colors min-h-[36px]"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add to Trip
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('light');
                          onRouteToPlace(place);
                        }}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 px-2.5 py-1.5 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors min-h-[36px]"
                      >
                        <Navigation className="w-3.5 h-3.5" />
                        Route
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('light');
                          onFocusPlace(place);
                        }}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 px-2.5 py-1.5 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors min-h-[36px]"
                      >
                        <MapPin className="w-3.5 h-3.5" />
                        Pin
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Grounding Source Citations (Google Search & Google Maps Grounding) */}
            {msg.groundingLinks && msg.groundingLinks.length > 0 && (
              <div className="mt-2 w-full space-y-1">
                <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  Verified Sources
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {msg.groundingLinks.map((link, idx) => {
                    const safeUri = sanitizeExternalUrl(link.uri);
                    if (!safeUri) return null;
                    return (
                      <a
                        key={`${safeUri}_${idx}`}
                        href={safeUri}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-sky-600 dark:text-sky-400 hover:underline max-w-full truncate"
                      >
                        <ExternalLink className="w-3 h-3 shrink-0" />
                        <span className="truncate">{link.title}</span>
                      </a>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ))}

        {isSending && (
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 py-1">
            <Compass className="w-4 h-4 animate-spin text-emerald-500" />
            <span>Querying real-time Google Maps &amp; Search data...</span>
          </div>
        )}

        {errorMsg && (
          <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 p-3 text-xs text-rose-500 dark:text-rose-300">
            {errorMsg}
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* Quick Prompts */}
      {!isOffline && (
        <div className="px-4 py-2 border-t border-slate-200 dark:border-slate-800/80 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          {EXPLORER_PROMPTS.map((p) => (
            <button
              key={p}
              type="button"
              disabled={isSending}
              onClick={() => void handleQuickPrompt(p)}
              className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#182030] text-xs text-slate-700 dark:text-slate-300 hover:border-emerald-500/50 whitespace-nowrap shrink-0 transition-colors min-h-[36px]"
            >
              {p}
            </button>
          ))}
        </div>
      )}

      {/* Composer */}
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="p-3 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121824] flex items-center gap-2"
      >
        {isOffline ? (
          <div className="flex-1 flex items-center gap-2 text-xs text-amber-500 py-2.5 px-3 rounded-xl border border-amber-500/30 bg-amber-500/10">
            <WifiOff className="w-4 h-4 shrink-0" />
            <span>Offline Mode · Chat history remains readable &amp; encrypted</span>
          </div>
        ) : (
          <>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`Ask about ${activeTrip?.destination || 'this area'}...`}
              aria-label="Ask GeoInteract AI"
              className="flex-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] px-3.5 py-2.5 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-emerald-500 min-h-[44px]"
            />
            <button
              type="submit"
              disabled={!input.trim() || isSending}
              aria-label="Send message"
              className="w-11 h-11 rounded-xl bg-emerald-500 text-slate-950 flex items-center justify-center hover:bg-emerald-400 disabled:opacity-40 transition-colors shrink-0"
            >
              <Send className="w-4 h-4" />
            </button>
          </>
        )}
      </form>
    </div>
  );
};
