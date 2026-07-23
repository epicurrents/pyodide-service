/**
 * This is an example Pyodide worker.
 * @package    epicurrents/pyodide-service
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

/**
 * Pyodide is licenced under MPL-2.0.
 * Source: https://github.com/pyodide/pyodide/
 */

import { BaseWorker } from '@epicurrents/core/dist/workers'
import { WithPyodide } from '#workers/pyodideWorkerBase'

/**
 * A minimal Pyodide worker: the shared Pyodide layer (``WithPyodide``) on the
 * plain ``BaseWorker``, with no montage machinery. Kept as a reference/template;
 * the live path uses ``PyodideMontageWorker``.
 */
export class PyodideWorker extends WithPyodide(BaseWorker) {
    constructor () {
        super()
        // Register the Python commissions handled by the shared layer.
        this.extendActionMap([
            ['load-packages', this.loadPackages],
            ['run-code', this.runCode],
            ['setup-worker', this.setupWorker],
        ])
    }
}
export default PyodideWorker
