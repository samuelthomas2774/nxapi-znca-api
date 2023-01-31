import process from 'node:process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import * as util from 'node:util';
import createDebug from 'debug';

const debug = createDebug('nxapi:util:product');

//
// Package/version info
//

export const dir = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

export const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf-8'));
const match = pkg.version.match(/^(\d+\.\d+\.\d+)-next\b/i);
export const version: string = match?.[1] ?? pkg.version;
export const release: string | null = pkg.__nxapi_release ?? null;

export const docker: string | true | null = pkg.__nxapi_docker ?? await (async () => {
    try {
        await fs.stat('/.dockerenv');
        return true;
    } catch (err) {
        return null;
    }
})();

export const git = pkg.__nxapi_git ?? await (async () => {
    try {
        await fs.stat(path.join(dir, '.git'));
    } catch (err) {
        if (!release) debug('Unable to find revision');
        return null;
    }

    const child_process = await import('node:child_process');
    const execFile = util.promisify(child_process.execFile);
    const git = (...args: string[]) => execFile('git', args, {cwd: dir}).then(({stdout}) => stdout.toString().trim());

    const [revision, branch, changed_files] = await Promise.all([
        git('rev-parse', 'HEAD'),
        git('rev-parse', '--abbrev-ref', 'HEAD'),
        git('diff', '--name-only', 'HEAD'),
    ]);

    return {
        revision,
        branch: branch && branch !== 'HEAD' ? branch : null,
        changed_files: changed_files.length ? changed_files.split('\n') : [],
    };
})();

export const dev = process.env.NODE_ENV !== 'production' &&
    (!release || process.env.NODE_ENV === 'development');

export const product = 'nxapi-znca-api ' + version +
    (!release && git ? '-' + git.revision.substr(0, 7) + (git.branch ? ' (' + git.branch + ')' : '') :
        !release ? '-?' : '');
