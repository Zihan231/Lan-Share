import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { engine } from './services/app/Engine';
import { useApp } from './stores/app';

// Diagnostics hook for automated tests and troubleshooting: open the app with ?debug in the URL.
if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { __lanshare: { engine, useApp } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
