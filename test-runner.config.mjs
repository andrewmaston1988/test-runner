// The package's own suites: it runs its tests through itself.

export default {
  suites: [
    { name: "unit", runs: [{ globs: ["tests/*.test.mjs"], timeoutMs: 10 * 60 * 1000 }] },
  ],
  wsl: {
    distro: "ubuntu",
    setup: "README.md, section \"WSL\", has the one-time setup.",
  },
};
