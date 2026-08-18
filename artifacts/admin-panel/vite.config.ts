import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// @replit/vite-plugin-runtime-error-modal is a Replit-only dev tool.
// Import it statically but only activate it when running inside Replit.
import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

// PORT is required by the dev server but not by `vite build`.
// Outside Replit (Docker, CI, local) NODE_ENV=production is set during build
// so we fall back to a placeholder rather than throwing.
const isDevServer = process.env.NODE_ENV !== 'production';
const rawPort = process.env.PORT;

if (isDevServer && !rawPort) {
  throw new Error(
    'PORT environment variable is required for the dev server but was not provided.',
  );
}

const port = Number(rawPort ?? '3000');

if (rawPort && (Number.isNaN(port) || port <= 0)) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    'BASE_PATH environment variable is required but was not provided.',
  );
}

const isReplit = process.env.REPL_ID !== undefined;

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    // Replit-only dev overlay — no-op outside Replit
    ...(isReplit ? [runtimeErrorOverlay()] : []),
    ...(isDevServer && isReplit
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
