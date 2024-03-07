const path = require('path')
const TerserPlugin = require('terser-webpack-plugin')
require('dotenv').config()

const ASSET_PATH = process.env.ASSET_PATH || '/pyodide-service/'

module.exports = {
    mode: 'production',
    entry: {
        'pyodide-service': { import: path.join(__dirname, 'src', 'index.ts') },
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                exclude: '/node_modules/',
                use: 'ts-loader',
            },
        ],
    },
    optimization: {
        minimize: true,
        minimizer: [
            new TerserPlugin(),
        ],
        splitChunks: false,
    },
    output: {
        path: path.resolve(__dirname, 'umd'),
        publicPath: ASSET_PATH,
        library: 'EpiCPyodideService',
        libraryTarget: 'umd',
    },
    resolve: {
        extensions: ['.ts', '.js', '.json'],
        alias: {
            '#root': path.resolve(__dirname, './'),
            '#types': path.resolve(__dirname, 'src', 'types'),
        },
        symlinks: false
    },
}