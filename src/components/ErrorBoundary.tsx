import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    errorMessage: '',
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, errorMessage: error.message };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('GeoInteract ErrorBoundary caught:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#0B0F17] text-slate-100 p-6">
          <div className="max-w-md w-full rounded-2xl border border-slate-800 bg-[#121824] p-6 space-y-4">
            <h2 className="text-lg font-semibold">Something interrupted your trip view</h2>
            <p className="text-sm text-slate-400 break-words">
              {this.state.errorMessage || 'An unexpected error occurred.'}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-lg bg-emerald-500 text-slate-950 font-medium text-sm hover:bg-emerald-400 transition-colors"
            >
              Reload GeoInteract
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
