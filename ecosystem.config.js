module.exports = {
  apps: [
    {
      name: "dev",
      script: "dist/src/main.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        MAX_BROWSERS_PER_GEO: "5",
        MAX_TABS_PER_BROWSER: "10",
      },
    },
  ],
};
