# Changes — 0.2.1

## Kept temp roots are pruned

- A failed or timed-out run keeps its temp root as evidence. Every run now prunes the kept roots first: it keeps the newest three per suite label and removes anything older than three days, so recent failures stay inspectable without the temp dir growing without bound. A root written to within the last day is never touched, since a dispatch still running may own it, and those roots take no keep slot. There is no command to run.
