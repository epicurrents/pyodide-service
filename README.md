# @epicurrents/pyodide-service

Runs Python in the browser for the Epicurrents viewer, through [Pyodide](https://pyodide.org). The application hands it a script and gets a result back; what the script does — a periodogram, a source localisation, a montage derivation — is the caller's business, and the heavy scientific packages (numpy, scipy, and optionally mne) are loaded into the interpreter rather than reimplemented in JavaScript.

## Public surface

| Export | What it is |
|---|---|
| `PyodideService` | The service. Holds a worker that holds the interpreter, and answers every call with a result object. |
| `PyodideRunner` | The same interface with the interpreter on the main thread, for a context that cannot start a worker. See [ROADMAP.md](ROADMAP.md) before reaching for it. |
| `PyodideMontageProcessor` (`./components`) | Derives and filters biosignal montages in Python instead of in core's own montage worker. |
| `PythonInterpreterService`, `RunCodeResult`, `RunPythonCode`, … (`./types`) | Types. |

## Running code

```ts
import { PyodideService } from '@epicurrents/pyodide-service'

const service = new PyodideService()
app.registerService('pyodide', service)
await service.setupWorker({ packages: ['matplotlib', 'mne'] })

const result = await service.runCode('psd_welch_periodogram()', { data: signals, fs: 250 })
if (result.success) {
    // result.result is what the Python function returned, converted to plain data.
}
```

Every method here resolves a result object carrying a `success` property, failures included: a refused commission is not a rejected promise, because a caller reading `success` would never see one. The parameters are bound as Python globals for the duration of the call — `from js import data, fs` reads them — and released afterwards, so a name is visible to the call that passed it and to nothing else.

### Commissions

| Commission | Reply |
|---|---|
| `setup-worker` | acknowledged, once the runtime and its packages have loaded |
| `load-packages` | acknowledged, once the interpreter holds them |
| `run-code` | `result`, the value the Python code returned |
| `setup-montage` | acknowledged; a `setup-worker` carrying a `montage` property means this one |
| `setup-input-mutex` | `cacheProperties`, the shared buffers the montage derivation writes into |
| `get-signals`, `set-filters` | core's montage commissions, answered against the Python processor |
| `shutdown` | acknowledged, whether or not the interpreter ever loaded |

The setup commission must come first: every other commission but `shutdown` is refused until the runtime is there. Shutting down is exempt because the service terminates its worker only once that commission comes back successful, and a worker whose runtime never loaded is exactly the one a caller wants to be rid of.

## Where the runtime comes from

`setupWorker({ indexURL, packages })` takes a path, and the path selects a strategy as well as a location.

With `indexURL` set, the loader, the runtime and every package come from that folder — which means the folder's own `pyodide-lock.json` has to name them all. A deployment that self-hosts the distribution extends that lock with mne and its dependency closure, and package loading then resolves offline with no PyPI.

With `indexURL` left out, everything comes from the pinned upstream distribution in [src/constants.ts](src/constants.ts): numpy and scipy from its lock, and the extras through micropip from PyPI, which is what a package upstream no longer bundles needs. Handing an upstream CDN path as `indexURL` takes the first branch against a lock that has no mne, and package loading fails.

## Scripts

A script is a named piece of Python that is run once and kept: `runScript(name, source, params, dependencies)` runs it, a second call with the same name does not, and a caller that arrives while the first run is still in flight waits for it rather than running it again. What a run leaves behind is the state the script defined — functions, globals — which later `runCode` calls then use.

A failed script is recorded as failed, and `runScript` reports it. The run is retried the next time it is asked for, and anything waiting on it as a dependency is refused with a reason rather than left waiting. A dependency this service has never been asked to load is not waited for at all: nothing here knows which scripts exist, so an unknown name can only mean the caller loads it by another route.

[src/scripts/biosignal.py](src/scripts/biosignal.py) is the only script this package carries. Everything else is the consumer's, loaded on demand; the viewer interface keeps its own under its EEG module.

## Computing biosignals in Python

The montage half is opt-in and separate from running analysis scripts. The service commissions `setup-montage` and `setup-input-mutex`, the worker builds a [PyodideMontageProcessor](src/components/PyodideMontageProcessor.ts) over core's own montage processor, and signal derivation and filtering then happen in [biosignal.py](src/scripts/biosignal.py) — a channel derivation, zero-phase Butterworth filters through scipy, and interruptions zero-filled across the filter and removed again afterwards.

Two properties of that path are worth knowing before building on it. Pyodide cannot alias a `SharedArrayBuffer` into Python-visible memory, so every read copies the range it needs; the script allocates per channel on first touch and refreshes only the slices a computation asks for. And Pyodide cannot wait: a request for signals that have not been loaded yet returns empty rather than blocking, so the caller is the one that has to know the data is there.

## The worker

The worker is inlined into `dist/`, so a consumer that registers nothing still gets one — there is no file to serve and nothing to resolve at run time except the Pyodide runtime itself. A consumer whose content security policy forbids `blob:` workers serves the standalone bundle the worker build emits instead, and registers a factory with `setWorkerOverride('pyodide', …)`, which takes precedence.

That bundle is an ES module despite the directory name, because the Pyodide loader is reached through a dynamic `import()` that only a module worker can perform. A consumer inlining it by hand passes `'module'` to core's `inlineWorker`.

## Development

```bash
npm install
npm run build     # the standalone worker bundle, then the library and its declarations
npm test          # type-checks the suite, then runs it
npm run lint
```

Both build outputs are regenerated together: `dist/` carries the worker inlined and `umd/` holds the standalone bundle, so rebuilding one alone leaves a mismatch nothing type-checks.

## License

Copyright 2019-2026 Sampsa Lohi

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

Pyodide is licensed under MPL-2.0. Source: https://github.com/pyodide/pyodide/
