import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/global.css';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { appRootFallback } from './components/ErrorBoundary.helpers';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary name="App" fallback={appRootFallback}>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
