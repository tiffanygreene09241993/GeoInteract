import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import './index.css';

// Demo Key Quota Defense (Google Maps Platform Case A)
if (typeof window !== 'undefined') {
  (window as any).gm_authFailure = () => {
    window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
  };

  const origConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    origConsoleError(...args);
    const joined = args.map((a) => String(a)).join(' ');
    if (
      joined.includes('OverQuotaMapError') ||
      joined.includes('QuotaExceededError') ||
      joined.includes('ApiTargetBlockedMapError')
    ) {
      window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
    }
  };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
