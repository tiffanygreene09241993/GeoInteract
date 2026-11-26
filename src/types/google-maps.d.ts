declare namespace google {
  namespace maps {
    class LatLng {
      lat(): number;
      lng(): number;
    }

    class Circle {
      constructor(opts?: Record<string, any>);
      setMap(map: any): void;
    }

    class Polyline {
      constructor(opts?: Record<string, any>);
      setMap(map: any): void;
      setOptions(opts: Record<string, any>): void;
      getPath(): { getArray(): LatLng[] };
    }

    namespace marker {
      class AdvancedMarkerElement {}
    }

    namespace places {
      class AutocompleteSessionToken {}
      interface AutocompleteSuggestion {
        placePrediction?: {
          placeId?: string;
          text: { text: string };
          toPlace(): {
            id?: string;
            displayName?: string;
            formattedAddress?: string;
            location?: LatLng;
            rating?: number;
            userRatingCount?: number;
            primaryTypeDisplayName?: string;
            googleMapsURI?: string;
            fetchFields(opts: { fields: string[] }): Promise<void>;
          };
        };
      }
    }
  }
}
