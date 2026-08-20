import { createRoot } from 'react-dom/client';
import './index.css';
import { setupApiClient } from './lib/api';

document.documentElement.classList.add('dark');
setupApiClient();

const { default: App } = await import('./App');
createRoot(document.getElementById('root')!).render(<App />);
