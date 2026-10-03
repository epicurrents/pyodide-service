/**
 * Epicurrents Pyodide service: a Python interpreter the application can run analysis scripts in.
 *
 * The two exports are the same contract on different threads. {@link PyodideService} commissions a
 * worker that holds the interpreter; {@link PyodideRunner} holds one on the main thread instead,
 * for a context that cannot start a worker. The montage components that compute biosignals in
 * Python are published separately under `./components`, because they belong to the worker side of
 * the boundary rather than to the service that drives it.
 * @package    epicurrents/pyodide-service
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 *
 * Pyodide is licenced under MPL-2.0. Source: https://github.com/pyodide/pyodide/
 */

import PyodideRunner from './PyodideRunner'
import PyodideService from './PyodideService'

export {
    PyodideRunner,
    PyodideService,
}
