import React, { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useMapsLibrary } from '@vis.gl/react-google-maps';
import { MapPin, Search, X } from 'lucide-react';
import { DiscoveredPlace } from '../types/travel';
import { triggerHaptic } from '../utils/haptics';

interface PlaceAutocompleteBarProps {
  onPlaceSelected: (place: DiscoveredPlace) => void;
  onQuickCategorySearch: (categoryQuery: string, includedTypes: string[]) => void;
  isOffline: boolean;
}

const QUICK_CATEGORIES = [
  { label: 'Coffee', query: 'specialty coffee', types: ['cafe'] },
  { label: 'Food', query: 'local restaurants', types: ['restaurant'] },
  { label: 'Sights', query: 'landmarks and museums', types: ['tourist_attraction', 'museum'] },
  { label: 'Parks', query: 'parks and scenic trails', types: ['park'] },
  { label: 'Transit', query: 'transit stations', types: ['train_station', 'subway_station'] },
];

export const PlaceAutocompleteBar: React.FC<PlaceAutocompleteBarProps> = ({
  onPlaceSelected,
  onQuickCategorySearch,
  isOffline,
}) => {
  const placesLib = useMapsLibrary('places');
  const [inputValue, setInputValue] = useState('');
  const [suggestions, setSuggestions] = useState<google.maps.places.AutocompleteSuggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const sessionTokenRef = useRef<google.maps.places.AutocompleteSessionToken | null>(null);

  useEffect(() => {
    if (!placesLib || isOffline) return;
    const trimmed = inputValue.trim();
    if (!trimmed) {
      setSuggestions([]);
      return;
    }

    const timer = setTimeout(() => {
      const { AutocompleteSessionToken, AutocompleteSuggestion } = placesLib;
      if (!sessionTokenRef.current) {
        sessionTokenRef.current = new AutocompleteSessionToken();
      }
      setIsLoading(true);
      AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input: trimmed,
        sessionToken: sessionTokenRef.current,
      })
        .then((res: { suggestions?: google.maps.places.AutocompleteSuggestion[] }) => {
          setSuggestions(res.suggestions || []);
          setIsLoading(false);
        })
        .catch(() => {
          setSuggestions([]);
          setIsLoading(false);
        });
    }, 220);

    return () => clearTimeout(timer);
  }, [placesLib, inputValue, isOffline]);

  const handleInput = useCallback((e: FormEvent<HTMLInputElement>) => {
    setInputValue((e.target as HTMLInputElement).value);
  }, []);

  const handleSelectSuggestion = useCallback(
    async (suggestion: google.maps.places.AutocompleteSuggestion) => {
      if (!placesLib || !suggestion.placePrediction) return;
      triggerHaptic('medium');

      const place = suggestion.placePrediction.toPlace();
      await place.fetchFields({
        fields: [
          'id',
          'displayName',
          'formattedAddress',
          'location',
          'rating',
          'userRatingCount',
          'primaryTypeDisplayName',
          'googleMapsURI',
        ],
      });

      const loc = place.location;
      if (loc) {
        onPlaceSelected({
          placeId: place.id || '',
          name: place.displayName || suggestion.placePrediction.text.text,
          address: place.formattedAddress || '',
          lat: loc.lat(),
          lng: loc.lng(),
          rating: typeof place.rating === 'number' ? place.rating : undefined,
          userRatingCount: typeof place.userRatingCount === 'number' ? place.userRatingCount : undefined,
          primaryType: place.primaryTypeDisplayName || undefined,
          googleMapsUri: place.googleMapsURI || undefined,
        });
      }

      sessionTokenRef.current = null;
      setSuggestions([]);
      setInputValue('');
    },
    [placesLib, onPlaceSelected]
  );

  return (
    <div className="w-full max-w-md space-y-2 pointer-events-auto">
      <div className="relative">
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-[#121824]/95 backdrop-blur-md px-3 shadow-lg">
          <Search className="w-4 h-4 text-slate-400 shrink-0" />
          <input
            type="text"
            value={inputValue}
            onInput={handleInput}
            disabled={isOffline}
            placeholder={isOffline ? 'Offline · Search paused (cached stops active)' : 'Search places, neighborhoods, transit...'}
            aria-label="Search Google Maps places"
            className="w-full bg-transparent py-2.5 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none disabled:opacity-60 min-h-[44px]"
          />
          {inputValue && (
            <button
              type="button"
              onClick={() => {
                setInputValue('');
                setSuggestions([]);
              }}
              className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 min-h-[40px] min-w-[40px] flex items-center justify-center"
              aria-label="Clear search"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {(suggestions.length > 0 || isLoading) && (
          <ul className="absolute left-0 right-0 mt-1.5 max-h-64 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121824] shadow-xl divide-y divide-slate-100 dark:divide-slate-800/80 z-30">
            {isLoading && suggestions.length === 0 && (
              <li className="px-3.5 py-2.5 text-xs text-slate-400">Searching Google Places...</li>
            )}
            {suggestions.map((s, idx) => (
              <li key={s.placePrediction?.placeId || idx}>
                <button
                  type="button"
                  onClick={() => void handleSelectSuggestion(s)}
                  className="w-full text-left px-3.5 py-2.5 flex items-start gap-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors min-h-[44px]"
                >
                  <MapPin className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />
                  <span className="text-xs sm:text-sm text-slate-800 dark:text-slate-200 line-clamp-2">
                    {s.placePrediction?.text.text}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
        {QUICK_CATEGORIES.map((cat) => {
          const isActive = activeCategory === cat.label;
          return (
            <button
              key={cat.label}
              type="button"
              disabled={isOffline}
              onClick={() => {
                triggerHaptic('light');
                setActiveCategory(cat.label);
                onQuickCategorySearch(cat.query, cat.types);
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 border transition-colors min-h-[36px] ${
                isActive
                  ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                  : 'bg-white/90 dark:bg-[#121824]/90 backdrop-blur-md text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-800 hover:border-emerald-500/50'
              } disabled:opacity-50`}
            >
              {cat.label}
            </button>
          );
        })}
      </div>
    </div>
  );
};
