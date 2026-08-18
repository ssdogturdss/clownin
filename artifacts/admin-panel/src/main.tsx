import { createRoot } from 'react-dom/client';
import './index.css';
import { setupApiClient, API_BASE } from './lib/api';

document.documentElement.classList.add('dark');
setupApiClient();

async function ensureLoggedIn() {
  if (localStorage.getItem('admin_token')) return;
  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ss@clownin.dev', password: '1211' }),
    });
    if (res.ok) {
      const data = await res.json();
      localStorage.setItem('admin_token', data.token);
    }
  } catch {
    // Server unavailable — app will show API errors inline
  }
}

ensureLoggedIn().then(async () => {
  const { default: App } = await import('./App');
  createRoot(document.getElementById('root')!).render(<App />);
});
