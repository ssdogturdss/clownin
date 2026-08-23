const { spawn } = require('node:child_process');

const port = process.env.PORT || '8081';
const isReplitPreview = Boolean(process.env.REPLIT_EXPO_DEV_DOMAIN && process.env.REPLIT_DEV_DOMAIN);
const env = { ...process.env };

if (isReplitPreview) {
  env.EXPO_PACKAGER_PROXY_URL = `https://${process.env.REPLIT_EXPO_DEV_DOMAIN}`;
  env.EXPO_PUBLIC_DOMAIN = env.EXPO_PUBLIC_DOMAIN || process.env.REPLIT_DEV_DOMAIN;
  env.EXPO_PUBLIC_REPL_ID = env.EXPO_PUBLIC_REPL_ID || process.env.REPL_ID || '';
  env.REACT_NATIVE_PACKAGER_HOSTNAME = process.env.REPLIT_DEV_DOMAIN;
}

const args = ['exec', 'expo', 'start', '--port', port, isReplitPreview ? '--localhost' : '--lan'];
const expo = spawn('pnpm', args, { cwd: __dirname + '/..', env, stdio: 'inherit' });

expo.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});