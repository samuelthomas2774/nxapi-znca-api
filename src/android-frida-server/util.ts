import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import createDebug from 'debug';
import getPaths from 'env-paths';
import mkdirp from 'mkdirp';

const debug = createDebug('nxapi:znca-api:android-frida-server:util');

const paths = getPaths('nxapi');
const script_dir = path.join(paths.temp, 'android-znca-api-server');

await mkdirp(script_dir);

export function execAdb(args: string[], adb_path?: string, device?: string) {
    execFileSync(adb_path ?? 'adb', device ? ['-s', device, ...args] : args, {
        stdio: 'inherit',
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

    execAdb([
        'push',
        filename,
        path,
    ], adb_path, device);

    execAdb([
        'shell',
        'chmod 755 ' + JSON.stringify(path),
    ], adb_path, device);
}

export function execScript(device: string, path: string, exec_command?: string, adb_path?: string) {
    const command = exec_command ?
        exec_command.replace('{cmd}', JSON.stringify(path)) :
        path;

    debug('Running script', command);

    execAdb([
        'shell',
        command,
    ], adb_path, device);
}

const wrapper = [
    'const module = {exports: {}}; (function (module, exports) { ',
    '\n})(module, module.exports);',
];

const init_script = `
for (const key of Object.keys(module.exports)) {
    if (typeof module.exports[key] === 'function') {
        rpc.exports[key] = module.exports[key];
    }
}
`;

export async function getFridaScript(script_path: string | URL) {
    const script_cjs = await fs.readFile(script_path, 'utf-8');
    const script = wrapper[0] + script_cjs + wrapper[1] + init_script;

    return script;
}
