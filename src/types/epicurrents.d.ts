/**
 * Epicurrents property type declarations.
 * @package    epicurrents/pyodide-service
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

/* eslint-disable */
type OpenDirectoryOptions = {
    /**
     * By specifying an ID, the browser can remember different directories for different IDs. If the same ID is used
     * for another picker, the picker opens in the same directory.
     */
    id?: string
    /**
     * A string that defaults to "read" for read-only access or "readwrite" for read and write access to the directory.
     */
    mode?: 'read' | 'readwrite'
    /**
     * A FileSystemHandle or a well known directory ("desktop", "documents", "downloads", "music", "pictures", or
     * "videos") to open the dialog in.
     */
    startIn?: FileSystemHandle | string
}
declare global {
    interface Window {
        /**
         * Experimental FileSystemAPI directory picker. May not be available in the user's browser.
         * @param options - Options for the picker; optional.
         * @returns Promise of a FileSystemDirectoryHandle.
         */
        showDirectoryPicker: (options?: OpenDirectoryOptions) => Promise<FileSystemDirectoryHandle>
    }
}
export {} // Guarantees the global declaration to work.
