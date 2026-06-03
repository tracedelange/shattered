// .cjs required because the project uses "type": "module"
module.exports = {
  apps: [
    {
      name: 'mmo',
      script: 'server/index.ts',
      interpreter: 'tsx',
      interpreter_args: '--env-file=.env',
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
      interpreter_args: '--env-file=.env',
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
