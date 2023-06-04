import path from 'node:path';
import { createHash } from 'node:crypto';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as util from 'node:util';
import createDebug from 'debug';
import mkdirp from 'mkdirp';
import { paths } from '../util/storage.js';

const debug = createDebug('nxapi:znca-api:android-frida-server:util');

const execFile = util.promisify(child_process.execFile);

const script_dir = path.join(paths.temp, 'android-znca-api-server');

await mkdirp(script_dir);

export async function execAdb(args: string[], adb_path?: string, device?: string) {
    await execFile(adb_path ?? 'adb', device ? ['-s', device, ...args] : args, {
        // stdio: 'inherit',
        windowsHide: true,
    });
}

export async function getScriptPath(content: string) {
    const filename = path.join(script_dir, createHash('sha256').update(content).digest('hex') + '.sh');

    await fs.writeFile(filename, content);
    await fs.chmod(filename, 0o755);

    return filename;
}

export async function pushScript(device: string, content: string, path: string, adb_path?: string) {
    const filename = await getScriptPath(content);

    debug('Pushing script', path, filename);

    await execAdb([
        'push',
        filename,
        path,
    ], adb_path, device);

    await execAdb([
        'shell',
        'chmod 755 ' + JSON.stringify(path),
    ], adb_path, device);
}

export async function execScript(device: string, path: string, exec_command?: string, adb_path?: string) {
    const command = exec_command ?
        exec_command.replace('{cmd}', JSON.stringify(path)) :
        path;

    debug('Running script', command);

    await execAdb([
        'shell',
        command,
    ], adb_path, device);
}
