/**
 * Copy Python script files to dist folder. Also copies the folder structure of the given
 * source directory if it contains Python files.
 * NOTE: This script only copies new and rewrites existing files, it does not remove obsolete
 * files or folders from dist.
 */
const fs = require('fs')

const srcPath = './src/'
const trgPath = './dist/'

const missingDirs = []
let fileCreated = false

function copyConfig (path) {
    const wrkPath = srcPath + path
    console.debug(`Traversing source path ${path}.`)
    if (fs.existsSync(wrkPath) && fs.lstatSync(wrkPath).isDirectory()) {
        const rootPath = trgPath + path
        if (!fs.existsSync(rootPath)) {
            console.debug(`Creating root directory ${rootPath}.`)
            fs.mkdirSync(rootPath)
        }
        fs.readdirSync(wrkPath).forEach(item => {
            const curPath = path + "/" + item
            const fullPath = srcPath + curPath
            if (fs.lstatSync(fullPath).isDirectory()) {
                if (!fs.existsSync(trgPath + curPath)) {
                    console.debug(`Missing target directory ${curPath} waiting to be created.`)
                    missingDirs.push(curPath)
                }
                copyConfig(curPath)
                if (!fileCreated && missingDirs.length) {
                    const emptyDir = missingDirs.pop()
                    console.debug(`Source directory ${emptyDir} did not contain config files.`)
                } else {
                    fileCreated = false
                }
            } else if (curPath.endsWith('.py')) {
                while (missingDirs.length) {
                    const nextDir = missingDirs.shift()
                    console.debug(`Creating target directory ${nextDir}.`)
                    fs.mkdirSync(trgPath + nextDir)
                }
                console.debug(`Copying file ${curPath}.`)
                fs.copyFileSync(fullPath, trgPath + curPath)
                fileCreated = true
            }
        })
    }
}

console.info('Copying Python script files.')
;[
    'scripts'
].forEach(path => {
    copyConfig(path)
})
console.info('Copy complete.')