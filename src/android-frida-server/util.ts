import path from 'node:path';
import { createHash } from 'node:crypto';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as util from 'node:util';
import createDebug from 'debug';
import mkdirp from 'mkdirp';
import persist from 'node-persist';
import express from 'express';
import { ResponseError } from '../util/http-server.js';
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

export const LIMIT_REQUESTS = 4;
export const LIMIT_PERIOD = 60 * 60 * 1000; // 60 minutes

type RateLimitAttempts = number[];

export async function checkUseLimit(
    storage: persist.LocalStorage,
    key: string, user: string, req: express.Request,
    /** Set to false to count the attempt but ignore the limit */ ratelimit = true,
    limits: [requests: number, period_ms: number] = [LIMIT_REQUESTS, LIMIT_PERIOD],
) {
    let attempts: RateLimitAttempts = await storage.getItem('RateLimitAttempts-' + key + '.' + user) ?? [];
    attempts = attempts.filter(a => a >= Date.now() - limits[1]);

    if (ratelimit && attempts.length >= limits[0]) {
        debug('User %s from %s (%s) exceeded rate limit', user, req.ips, req.headers['user-agent'], attempts);
        throw new ResponseError(429, 'rate_limit', 'Too many attempts to authenticate');
    }

    attempts.unshift(Date.now());
    await storage.setItem('RateLimitAttempts-' + key + '.' + user, attempts);

    debug('rate limit', user, req.ips, attempts);
}
