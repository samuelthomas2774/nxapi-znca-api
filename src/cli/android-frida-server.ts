import process from 'node:process';
import { execFileSync } from 'node:child_process';
import * as net from 'node:net';
import createDebug from 'debug';
import frida, { Session } from 'frida';
import Server from '../android-frida-server/server.js';
import { execAdb, execScript, pushScript } from '../android-frida-server/util.js';
import { frida_script, setup_script, shutdown_script } from '../android-frida-server/scripts.js';
import { FridaScriptExports, StartMethod } from '../android-frida-server/types.js';
import type { Arguments as ParentArguments } from './index.js';
import { ArgumentsCamelCase, Argv, YargsArguments } from '../util/yargs.js';
import { parseListenAddress } from '../util/net.js';

const debug = createDebug('cli:android-frida-server');

export const command = 'android-frida-server <device>';
export const desc = 'Connect to a rooted Android device with frida-server over ADB running the Nintendo Switch Online app and start a HTTP server to generate f parameters';

export function builder(yargs: Argv<ParentArguments>) {
    return yargs.positional('device', {
        describe: 'ADB server address/port',
        type: 'string',
        demandOption: true,
    }).option('exec-command', {
        describe: 'Command to use to run a file on the device',
        type: 'string',
    }).option('adb-path', {
        describe: 'Path to the adb executable',
        type: 'string',
    }).option('adb-root', {
        describe: 'Run `adb root` to restart adbd as root',
        type: 'boolean',
        default: false,
    }).option('frida-server-path', {
        describe: 'Path to the frida-server executable on the device',
        type: 'string',
        default: '/data/local/tmp/frida-server',
    }).option('start-method', {
        describe: 'Method to ensure the app is running (one of "spawn", "none", "activity", "service")',
        type: 'string',
        default: 'service',
    }).option('strict-validate', {
        describe: 'Validate data exactly matches the format that would be generated by Nintendo\'s Android app',
        type: 'boolean',
        default: false,
    }).option('validate-tokens', {
        describe: 'Validate tokens before passing them to znca',
        type: 'boolean',
        default: true,
    }).option('listen', {
        describe: 'Server address and port',
        type: 'array',
        default: ['[::]:0'],
    });
}

type Arguments = YargsArguments<ReturnType<typeof builder>>;

export async function handler(argv: ArgumentsCamelCase<Arguments>) {
    const start_method =
        argv.startMethod === 'spawn' ? StartMethod.SPAWN :
        argv.startMethod === 'activity' ? StartMethod.ACTIVITY :
        argv.startMethod === 'service' ? StartMethod.SERVICE :
        StartMethod.NONE;

    const server = new Server();

    server.start_method = start_method;
    server.validate_tokens = argv.validateTokens;
    server.strict_validate = argv.strictValidate;

    await setup(argv, start_method);

    {
        const {session, script} = await attach(argv, start_method);

        server.api = script.exports as FridaScriptExports;
        server.package_info = await server.api!.getPackageInfo();
        server.system_info = await server.api!.getSystemInfo();
    }

    const onexit = (code: number | NodeJS.Signals) => {
        process.removeListener('exit', onexit);
        process.removeListener('SIGTERM', onexit);
        process.removeListener('SIGINT', onexit);

        debug('Exiting', code);
        console.log('Exiting', code);
        debug('Releasing wake lock', argv.device);
        try {
            execScript(argv.device, '/data/local/tmp/android-znca-api-server-shutdown.sh', argv.execCommand, argv.adbPath);
        } catch (err) {
            console.error('Failed to run shutdown script, exiting anyway');
        }
        process.exit(typeof code === 'number' ? code : 0);
    };

    process.on('exit', onexit);
    process.on('SIGTERM', onexit);
    process.on('SIGINT', onexit);

    function reattach() {
        // Already attempting to reattach
        if (server.ready) return;

        debug('Attempting to reconnect to the device');

        server.ready = attach(argv, start_method).then(async ({session, script}) => {
            server.ready = null;
            server.api = script.exports as FridaScriptExports;

            const new_system_info = await server.api!.getSystemInfo();
            const new_package_info = await server.api!.getPackageInfo();

            if (server.system_info?.version.sdk_int !== new_system_info.version.sdk_int) {
                debug('Android system version updated while disconnected');
            }
            if (server.package_info?.build !== new_package_info.build) {
                debug('znca version updated while disconnected');
            }

            server.system_info = new_system_info;
            server.package_info = new_package_info;
        }).catch(err => {
            console.error('Reattach failed', err);
            process.exit(1);
        });
    }

    server.reattach = reattach;

    const app = server.app;

    for (const address of argv.listen) {
        const [host, port] = parseListenAddress(address);
        const server = app.listen(port, host ?? '::');
        server.on('listening', () => {
            const address = server.address() as net.AddressInfo;
            console.log('Listening on %s, port %d', address.address, address.port);
        });
    }

    setInterval(async () => {
        try {
            await server.api!.ping();
        } catch (err) {
            if ((err as any)?.message === 'Script is destroyed') {
                reattach();
                return;
            }

            throw err;
        }
    }, 5000);

    debug('System info', server.system_info);
    debug('Package info', server.package_info);

    try {
        debug('Test gen_audio_h');
        const result = await server.api!.genAudioH('id_token', 'timestamp', 'request_id');
        debug('Test returned', result);
    } catch (err) {
        debug('Test failed', err);
    }
}

async function setup(argv: ArgumentsCamelCase<Arguments>, start_method: StartMethod) {
    debug('Connecting to device %s', argv.device);
    let co = execFileSync(argv.adbPath ?? 'adb', [
        'connect',
        argv.device,
    ], {
        windowsHide: true,
    });

    while (co.toString().includes('failed to authenticate')) {
        console.log('');
        console.log('-- Allow this computer to connect to the device. --');
        console.log('');
        await new Promise(rs => setTimeout(rs, 5 * 1000));

        execAdb([
            'disconnect',
            argv.device,
        ], argv.adbPath);

        debug('Connecting to device %s', argv.device);
        co = execFileSync(argv.adbPath ?? 'adb', [
            'connect',
            argv.device,
        ], {
            windowsHide: true,
        });
    }

    debug('Pushing scripts');

    await pushScript(argv.device, setup_script({
        frida_server_path: argv.fridaServerPath,
        start_method,
    }), '/data/local/tmp/android-znca-api-server-setup.sh', argv.adbPath);
    await pushScript(argv.device, shutdown_script, '/data/local/tmp/android-znca-api-server-shutdown.sh', argv.adbPath);
}

async function attach(argv: ArgumentsCamelCase<Arguments>, start_method: StartMethod) {
    if (argv.adbRoot) {
        debug('Restarting adbd as root');

        execAdb([
            'root',
        ], argv.adbPath, argv.device);
    }

    debug('Running scripts');
    execScript(argv.device, '/data/local/tmp/android-znca-api-server-setup.sh', argv.execCommand, argv.adbPath);

    debug('Done');

    const device = await frida.getDevice(argv.device);
    debug('Connected to frida device %s', device.name);

    let session: Session;

    try {
        const process = start_method === StartMethod.SPAWN ?
            {pid: await device.spawn('com.nintendo.znca')} :
            await device.getProcess('Nintendo Switch Online');

        debug('process', process);

        session = await device.attach(process.pid);

        if (start_method === StartMethod.SPAWN) {
            await device.resume(session.pid);
        }
    } catch (err) {
        debug('Could not attach to process', err);
        throw new Error('Failed to attach to process');
    }

    debug('Attached to app process, pid %d', session.pid);

    const script = await session.createScript(frida_script);
    await script.load();

    return {session, script};
}
