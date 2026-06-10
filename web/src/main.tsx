import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import SignIn from './routes/SignIn';
import { initAuth, isAuthEnabled, getAccount } from './lib/auth';
import './index.css';

function Root() {
  // When auth is enabled but nobody is signed in, show the sign-in screen.
  if (isAuthEnabled && !getAccount()) return <SignIn />;
  return <App />;
}

async function bootstrap() {
  // Process any MSAL redirect response before the first render.
  if (isAuthEnabled) await initAuth();

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <BrowserRouter>
        <Root />
      </BrowserRouter>
    </React.StrictMode>,
  );
}

void bootstrap();
