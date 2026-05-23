import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/global.css';
import App from './App';
import { ErrorBoundary, appRootFallback } from './components/ErrorBoundary';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary name="App" fallback={appRootFallback}>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
