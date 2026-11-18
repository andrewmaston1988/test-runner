# Changes — 0.1.2

## Temp files

- Every run now gets its own temp directory under a `test-runner` folder in the OS temp directory, and every test process the run starts uses it. The temp files tests leave behind collect in one place instead of piling up across the whole temp directory.
- A passing run's temp directory is deleted. A run that fails or times out keeps it and prints where it is, because a failing test's evidence is often in there; an empty one is deleted anyway.
- A run that sets `TEMP`, `TMP` or `TMPDIR` in its own `env` keeps its value and gets no temp directory.
- If the temp directory cannot be made, for example on a full disk, the run goes ahead without one and says so.
