module.exports = {
  apps: [
    {
      name: "dev",
      script: "dist/src/main.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
