module.exports = {
  apps: [
    {
      name: "nvidia-glm-proxy",
      script: "./proxy.js",
      cwd: __dirname,
      env_file: ".env",
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "./logs/error.log",
      out_file: "./logs/out.log",
      merge_logs: true,
      max_memory_restart: "200M",
    },
  ],
};
