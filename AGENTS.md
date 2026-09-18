# @epicurrents/pyodide-service — architecture notes for AI coding assistants

This file is the entry point for AI coding assistants working in the `@epicurrents/pyodide-service` package: a Python-in-browser compute service for the Epicurrents viewer, backed by [Pyodide](https://pyodide.org). It is also the **reference implementation of the service pattern** — every `*-service` package (`onnx-service`, …) follows the same commission/promise worker abstraction and the same source layout described below, so the layout section is a convention other services copy rather than a Pyodide-specific accident. It is tool-agnostic: the conventions apply to any assistant.

## Toolchain compliance — HIGH PRIORITY

This package depends on `@epicurrents/core` and shares a single toolchain with it. **Never pin package-specific versions that diverge from the canonical set** — a divergent TypeScript produces structurally incompatible `.d.ts` files that type-check locally but corrupt data at runtime, because the worker bundle and the main-thread code can then disagree on data layouts or API shapes while everything still compiles.

| Tool | Version |
|---|---|
| TypeScript | `^5.7.0` |
| Vite | `^7.3.1` |
| esbuild | `^0.28.2` (worker minification only) |
| tsconfig base | extends `@epicurrents/core/tsconfig.base.json` |

Do not override `tsconfig.base.json` options per-package without a comment explaining why.

```bash
npm run build          # build:workers then build:tsc — produces BOTH outputs (see below)
npm run build:tsc      # vite + epicurrents-build-types → dist/  (what consumers import)
npm run build:workers  # vite → umd/pyodide.worker.js  (the standalone bundle)
```

Both outputs must be regenerated together after any shared-code change: `dist/` carries the worker inlined and `umd/` holds the standalone bundle, so rebuilding one leaves a mismatch the type system cannot see. Declarations come from `epicurrents-build-types`, the tool core publishes as a bin; nothing here invokes `tsc` for emit.

---

## Services concept

**Pattern shared by all `*-service` packages.**

`GenericService` (from `@epicurrents/core`) abstracts a web worker: each method call creates a *commission* (a `Promise` keyed by a monotonically incrementing request number), and posts `{ action, rn, …props }` to the worker; the worker replies with the same `rn` so the promise can be resolved.

`PyodideService` extends this:

```
src/
  index.ts                # public exports: PyodideRunner and PyodideService
  constants.ts            # DEFAULT_PYODIDE_INDEX_URL — the pinned runtime location
  PyodideService.ts       # extends GenericService — manages the Pyodide worker
  PyodideRunner.ts        # main-thread variant: same API, runs Pyodide without a worker
  pyodide.worker.ts       # the worker entry — instantiates PyodideMontageWorker
  components/
    PyodideMontageProcessor.ts  # montage computation via Python (alt to JS montage)
  workers/
    pyodideWorkerBase.ts        # this-free runtime helpers + the shared Pyodide layer
    PyodideWorker.ts            # base worker class
    PyodideMontageWorker.ts     # worker-side implementation of montage processing
  scripts/
    biosignal.py          # biosignal processing utilities (filtering etc.)
  types/                  # PythonInterpreterService interface, etc.
```

The consumer constructs a service and registers it under a lower-case key — `app.registerService('pyodide', new PyodideService())` — then calls `setupWorker({ indexURL?, packages? })` on it, which is what loads the runtime. A modality module can then call into the service for filtering, PSD computation, or topographic mapping.

**Worker resolution.** The service resolves its own worker: `dist/` carries it inlined through Vite's `?worker&inline`, so the default costs the consumer no file to serve and no registration. A factory registered with `app.setWorkerOverride('pyodide', …)` takes precedence, which is the route for a content security policy that forbids `blob:` workers (see [Worker bundle exports](#worker-bundle-exports)).

The memory manager (`ServiceMemoryManager` in core, backed by `asymmetric-io-mutex`) uses `SharedArrayBuffer` to pass large signal arrays between threads without copying, when cross-origin isolation is available.

A new service package mirrors this shape: a `<Name>Service` extending `GenericService`, a worker entry under `src/`, worker-side classes under `src/workers/`, optional processors under `src/components/`, and the service's public interface under `src/types/`.

---

## Service internals

### Overview

Instead of implementing signal math in JS, complex algorithms (spectral analysis, topographic mapping) run as Python scripts inside a Pyodide web worker.

### `PyodideService` (main-thread side)

Source: `src/PyodideService.ts`

Key design: [biosignal.py](src/scripts/biosignal.py) is imported at **build time** via Vite's `?raw` loader and bundled into the module — no network fetch needed:

```ts
import biosignal from './scripts/biosignal.py?raw'
const DEFAULT_SCRIPTS = new Map([['biosignal', biosignal]])
```

**Script caching** — each named script has a state tracked in `_scripts: { [name: string]: ScriptState }`:

| State | Meaning |
|---|---|
| `'not_loaded'` | Not yet sent to worker |
| `'loading'` | Commission sent, awaiting worker ack |
| `'loaded'` | Python executed successfully |
| `'error'` | Execution failed |

`runScript(name, script, params, deps)` is idempotent:
- If `'loaded'` → returns immediately (no re-execution)
- If `'loading'` → awaits the action waiter for that commission
- If `'not_loaded'` → sends a `'run-code'` commission to the worker and transitions to `'loading'`

`setInputMutex(input, dataDuration, recordingDuration, bufferStart)` loads the `biosignal` script through `loadDefaultScript` unless it is already `'loaded'`, before commissioning `'setup-input-mutex'`. This guarantees the Python-side global state exists before the SAB is wired into it — a service that has never run the script holds no `_scripts` entry at all, so the check has to tolerate an absent one.

Only `'loading'` and `'loaded'` are ever assigned. `'not_loaded'` and `'error'` exist in the type but no code path sets them, so do not branch on them without making something produce them first.

`runCode(code, params, scriptDeps, transferList)` → `_commissionWorker('run-code', ...)` — for one-shot Python snippets that don't need persistent state.

`PyodideRunner` ([src/PyodideRunner.ts](src/PyodideRunner.ts)) implements the same `PythonInterpreterService` interface on the main thread instead of in a worker. Nothing selects it today: it is exported but unreferenced by the interface, the builder's setups and the profiles, and it cannot serve the SAB path — it has no `setInputMutex`, and `setupBiosignalRecording` returns `Not yet implemented`. Treat it as an unwired variant rather than a working fallback.

### Worker stack

`src/pyodide.worker.ts` — bare worker entry:
```ts
import PyodideMontageWorker from '#workers/PyodideMontageWorker'

const PYODIDE = new PyodideMontageWorker()

onmessage = async (message: WorkerMessage) => {
    PYODIDE.handlePythonMessage(message)
}
```

`PyodideMontageWorker` (in [src/workers/PyodideMontageWorker.ts](src/workers/PyodideMontageWorker.ts)) is declared as `extends WithPyodide(MontageWorker)` — core's `MontageWorker` wrapped in the `WithPyodide` mixin, adding a Python layer on top of the signal-processing pipeline. The shared Pyodide plumbing — runtime loading, the JS↔Python bridge, and the `load-packages` / `run-code` handlers — lives in [src/workers/pyodideWorkerBase.ts](src/workers/pyodideWorkerBase.ts) and is applied through that mixin to both `PyodideWorker` and `PyodideMontageWorker`.

This is a `type: 'module'` worker (required by Pyodide ≥0.27/314). `loadPyodideRuntime(config)` loads the loader script, the runtime, and all packages from a **single** configured `indexURL`, so one path and one pinned version are the single source of truth; `DEFAULT_PYODIDE_INDEX_URL` in [src/constants.ts](src/constants.ts) is the fallback when nothing is configured — shared with the main-thread `PyodideRunner`, so the pinned version lives in exactly one place. The loader is a deferred dynamic `import()` rather than a module top-level import, because the config only arrives with the init message.

#### `PyodideMontageWorker` action map additions

| Action | Handler |
|---|---|
| `load-packages` | Loads additional Python packages into Pyodide |
| `run-code` | Executes an arbitrary Python string via `runPythonCode()` |
| `set-filters` | Updates the Python-side filter settings |
| `get-signals` | Returns derived, filtered signals for the requested channels |
| `setup-input-mutex` | Registers the SAB-backed `Float32Array` views as `_biosignal['buffers']` via `biosignal_set_buffers()`. No per-channel numpy array is allocated yet. |
| `setup-montage` | Creates `PyodideMontageProcessor(this._runPythonCode, this._settings)` |
| `setup-worker` | Loads the runtime (from the shared `WithPyodide` layer) |

Actions are registered via `extendActionMap([...])` on top of the inherited `MontageWorker` map, so montage commissions added to the base worker in core are picked up here automatically. Trend commissions are not: they live in core's separate trend worker.

**Initialisation** takes two commissions, not one. `setup-worker` loads the runtime and drains the load waiters; the processor is created later by `setup-montage`, or by a `setup-worker` message that carries a `montage` property, which `handlePythonMessage` reroutes.

**Package resolution depends on `indexURL`**, which selects a strategy rather than only a location. Configured, the runtime loads `['numpy', 'scipy']` and every extra with `pyodide.loadPackage` from that distribution — the lock file encodes dependencies, so the tree resolves from that folder offline, with no micropip and no PyPI. Unconfigured, it falls back to the CDN for numpy and scipy and installs the extras through micropip from PyPI, which is what an un-bundled package such as mne requires.

#### `runPythonCode(code, context, simulateDocument)` — the JS↔Python bridge

1. Binds each `context` property onto `self` (the global JS scope), making them accessible as `from js import <name>` in Python (keys containing `__proto__` are rejected)
2. Optionally stands up a dummy `window` / `document` when `simulateDocument` is set — only matplotlib needs it
3. Calls `pyodide.runPython(code)`
4. Tears down the document simulation
5. Converts a Proxy result to JS and destroys the proxy, to avoid memory leaks
6. Unbinds all context properties from `self`

This is the central mechanism — every Python call from TypeScript goes through this bridge.

### `biosignal.py` — signal processing global state

Source: `src/scripts/biosignal.py`

A module-level `_biosignal` dict holds all shared state across calls:
Its keys cover the buffers (`buffers`, `input`, `output`), the layout of the per-channel metadata header (`data_fields`, `data_pos`, `empty_field`), the filter settings and their orders (`filters`, with `N_pass` and `N_stop`), the montage state (`available_montages`, `montage`) and the matplotlib canvases (`series_canvas`, `topomap_canvas`). Read the literal and the docstring under it in the source rather than a copy here, which is what drifts.

**SAB wiring** — `biosignal_set_buffers()` takes the views from JS, releases the previous per-channel numpy arrays before replacing the list (each can be tens of megabytes, and dropping the reference late keeps two generations alive), and clears the montage state, because channel indices belong to the buffer set they were resolved against.

Pyodide cannot alias an external `SharedArrayBuffer` into Python-visible memory: both `JsBuffer.to_py()` and `JsBuffer.to_memoryview()` materialise a snapshot at call time. Every refresh has to copy. To minimise per-call bandwidth, the design is **lazy-allocate + slice-refresh**:

- `_ensure_input_array(idx)` — a full-channel-sized `np.zeros` is allocated the first time anything touches channel `idx`. Channels a compute step never touches never allocate.
- `_refresh_channel_range(idx, start, end)` — copies the metadata header (`sampling_rate`, `updated_start`, `updated_end`) plus `[start:end]` from the live SAB into the channel's numpy array via `buf.subarray(start, end).assign_to(target[start:end])`. The header is always refreshed so load-status checks see live values.

**Signal computation** — `biosignal_get_signals(channels)`:
- Per channel: derivation (`active_signal - reference_signal`)
- Butterworth bandpass/highpass/lowpass/notch applied via `sosfiltfilt` (zero-phase)
- Filter coefficients are **cached** by `(signal_fs, freq)` key to avoid recomputation
- Gap handling: interruptions are zero-filled into the signal before filtering so the filter sees a continuous length, and removed again after
- Before reading: the active and reference channels for the requested derivation are slice-refreshed for `[start_pos:end_pos]`. A per-call `(channel_idx, start, end)` dedup set avoids re-copying the same slice when many montage channels share a reference (e.g. average reference).
- Returns a Python list of filtered float32 numpy arrays, which the JS side receives as typed-array views

**Batched preload** — `biosignal_refresh_channels()`:
- Takes `specs : list of [channel_idx, start, end]` from JS, imported over the bridge like every other entry point here.
- Calls `_refresh_channel_range` for each entry.
- Use this for workloads that read the same channel(s) repeatedly in many small windows: a trend computation that scans a full channel across many epochs (one bulk refresh of just the needed channels, then loop entirely in Python) or source-localization epoch extraction across scattered event timestamps (one batched refresh per event covering all channels). A per-frame `biosignal_get_signals` path does not need this — its own internal refresh handles small windows.

**Threading limitation**: Pyodide cannot block waiting for data. If the requested signal is not yet loaded (after the slice refresh), `biosignal_get_signals` prints a warning and returns the (mostly `None`) `signals` list early. The caller must ensure data availability before requesting.

### Consumer-supplied analysis scripts

[biosignal.py](src/scripts/biosignal.py) is the only script this package bundles. Everything else is supplied by the consumer and loaded on demand through `runScript(name, script, params, deps)` / `runCode(...)`, with any extra Python packages pulled in via the `load-packages` commission. The viewer interface, for example, ships its own `psd.py` (power spectral density) and `source_localize.py` under its `src/app/modules/eeg/scripts/` directory and hands them to this service at runtime; their internals are documented in that package, not here.

---

## Worker bundle exports

The worker is inlined into `dist/`, so a consumer that registers nothing gets a working worker with no file to serve, copy or resolve.

The bundle in `umd/` is the escape hatch, for a consumer whose content security policy forbids `worker-src blob:`: it serves that file and registers a factory with `setWorkerOverride`, which takes precedence over the inlined default. It is reachable through two `exports` keys in `package.json`:

```json
"./workers/*": "./umd/*",
"./umd/*": "./umd/*"
```

It suits `inlineWorker(src, 'module')` after a `?raw` import, and the third argument is required: despite the directory name, the bundle is an **ES module**, because Pyodide's loader is reached through a dynamic `import()` that only a module worker can perform. `dist/pyodide.worker.js` is Vite's inline wrapper around the same bundled worker — not a module to `?raw`-import for inlining.

---

## Code comment conventions

Comments and docstrings describe the code's **current contract** — what it does and the invariants it upholds, for a reader who has never seen an earlier version.

- **No change history or anecdotes.** Don't narrate what the code used to do, what a change replaced, or why it was added. That belongs in the commit message, where `git blame` surfaces it; in the file it rots as soon as the change lands.
- **Describe the layer's own contract, not its consumers.** A service or worker comment shouldn't name a specific upper-layer caller — state the invariant the layer guarantees so it holds regardless of who calls it.
- **Keep the `@package` / `@copyright` / `@license` header** on every source file.
- **Wrap TypeScript source at a 120-column soft cap** — code, docstrings, and comments alike. The one exception: `@param` docstrings stay on a single line regardless of length, because wrapping them renders poorly in the VS Code hover. Do not hard-wrap Markdown prose: one line per paragraph, since docs are read as rendered output at varying widths.
