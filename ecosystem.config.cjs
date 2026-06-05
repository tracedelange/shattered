// .cjs required because the project uses "type": "module"
const fs = require('fs');
const path = require('path');

function loadEnv(filePath) {
  try {
    return Object.fromEntries(
      fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(line => line.trim() && !line.startsWith('#') && line.includes('='))
        .map(line => {
          const idx = line.indexOf('=');
          return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
        })
    );
  } catch { return {}; }
}

const env = loadEnv(path.join(__dirname, '.env'));

module.exports = {
  apps: [
    {
      name: 'mmo',
      script: 'server/index.ts',
      interpreter: 'tsx',
      env,
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      merge_logs: false,
      time: true,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
    },
    {
      name: 'mmo-webhook',
      script: 'server/webhook.ts',
      interpreter: 'tsx',
      env,
      out_file: 'logs/webhook.out.log',
      error_file: 'logs/webhook.error.log',
      merge_logs: false,
      time: true,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
