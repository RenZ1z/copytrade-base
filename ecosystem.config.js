module.exports = {
  apps: [
    {
      name: "copytrade-base",
      script: "dist/index.js",
      watch: false,
      restart_delay: 5000,
      max_restarts: 50,
      env: {
        NODE_ENV: "production",
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "logs/pm2-error.log",
      out_file: "logs/pm2-out.log",
    },
  ],
};
