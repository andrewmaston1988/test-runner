# Changes — 0.1.1

## WSL

- `--wsl` hands every argument to the distro unchanged instead of through a shell. It no longer
  fails before syncing on a distro whose PATH contains `Program Files (x86)`, and paths holding a
  space, `(` or `$` reach the mirror intact.
