import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';
import { isChunkLoadError, reloadForNewBuild } from './lib/staleBuild';

// A tab opened before a studio update asks for page chunks of the old build: load the new build instead of a blank page.
window.addEventListener('vite:preloadError', (event) => {
  if (reloadForNewBuild()) event.preventDefault();
});
window.addEventListener('unhandledrejection', (event) => {
  if (isChunkLoadError(event.reason)) reloadForNewBuild();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
