import createDebug from 'debug';
import frida, { Device, Script, Session } from 'frida';
import * as child_process from 'node:child_process';
import * as dns from 'node:dns/promises';
import * as util from 'node:util';
import MetricsCollector from './metrics.js';
import { frida_script, setup_script, shutdown_script } from './scripts.js';
import { FridaScriptExports, PackageInfo, StartMethod, SystemInfo } from './types.js';
import { execAdb, execScript, pushScript } from './util.js';

const debug = createDebug('nxapi:znca-api:android-frida-server:device');

const execFile = util.promisify(child_process.execFile);

export class AndroidDevicePool {
    devices: AndroidDeviceConnection[] = [];
    available: AndroidDeviceConnection[] = [];
    waiting: ((device: AndroidDeviceConnection) => void)[] = [];

    onDeviceRemoved?: (device: AndroidDeviceConnection) => void;

    constructor(
        readonly metrics: MetricsCollector | null = null,
    ) {}

    getAvailableDevice() {
        const device = this.available.shift();

        if (device) debug('use worker, %d/%d available', this.available.length, this.devices.length);

        return device;
    }

    waitForAvailableDevice(timeout_ms?: number, signal?: AbortSignal) {
        const device = this.getAvailableDevice();

        if (device) {
            return Promise.resolve([device, null] as const);
        }
        
        if (!timeout_ms) {
            return Promise.reject(new AndroidDeviceTimeoutError(this));
        }

        const start = Date.now();

        debug('waiting for worker, 0/%d available', this.devices.length);

        return new Promise<readonly [AndroidDeviceConnection, number | null]>((rs, rj) => {
            const callback = (device: AndroidDeviceConnection) => {
                const queue_duration = Date.now() - start;
                debug('use worker, %d/%d available, waited %d ms', this.available.length, this.devices.length, queue_duration);
                rs([device, queue_duration]);
                if (timeout) clearTimeout(timeout);
                signal?.removeEventListener('abort', onabort);
            };

            const timeout = timeout_ms ? setTimeout(() => {
                debug('timeout waiting for worker, 0/%d available', this.devices.length);
                rj(new AndroidDeviceTimeoutError(this));

                let index;
                while ((index = this.waiting.indexOf(callback)) !== -1) {
                    this.waiting.splice(index, 1);
                }

                signal?.removeEventListener('abort', onabort);
            }, timeout_ms) : null;

            const onabort = (event: Event) => {
                rj(event);

                let index;
                while ((index = this.waiting.indexOf(callback)) !== -1) {
                    this.waiting.splice(index, 1);
                }

                if (timeout) clearTimeout(timeout);
            };

            signal?.addEventListener('abort', onabort);

            this.waiting.push(callback);
        });
    }

    returnAvailableDevice(device: AndroidDeviceConnection) {
        if (!this.devices.includes(device)) {
            // Device was removed from the available device pool
            return;
        }

        this.handleDeviceAvailable(device);

        debug('return worker, %d/%d available', this.available.length, this.devices.length);
    }

    protected handleDeviceAvailable(device: AndroidDeviceConnection) {
        const next = this.waiting.shift();

        if (next) {
            next.call(null, device);
            return;
        }

        this.available.push(device);
    }

    protected handleDeviceUnavailable(device: AndroidDeviceConnection, err?: unknown) {
        let index;
        while ((index = this.devices.indexOf(device)) !== -1) {
            this.devices.splice(index, 1);
        }
        while ((index = this.available.indexOf(device)) !== -1) {
            this.available.splice(index, 1);
        }

        debug('worker died, %d/%d available', this.available.length, this.devices.length, device.device.id);

        device.handleDeviceDisconnected(err);
        this.onDeviceRemoved?.(device);

        this.metrics?.total_devices.dec({
            platform: 'Android',
            znca_version: device.package_info.version,
            znca_build: device.package_info.build,
            android_release: device.system_info.version.release,
            android_platform_version: device.system_info.version.sdk_int,
        });
    }

    add(device: AndroidDeviceConnection) {
        if (this.devices.includes(device)) return;

        this.devices.push(device);
        this.handleDeviceAvailable(device);

        debug('worker added, %d/%d available', this.available.length, this.devices.length, device);

        this.metrics?.total_devices.inc({
            platform: 'Android',
            znca_version: device.package_info.version,
            znca_build: device.package_info.build,
            android_release: device.system_info.version.release,
            android_platform_version: device.system_info.version.sdk_int,
        });
    }

    remove(device: AndroidDeviceConnection) {
        if (!this.devices.includes(device)) return;

        let index;
        while ((index = this.devices.indexOf(device)) !== -1) {
            this.devices.splice(index, 1);
        }
        while ((index = this.available.indexOf(device)) !== -1) {
            this.available.splice(index, 1);
        }

        debug('worker removed, %d/%d available', this.available.length, this.devices.length, device.device.id);

        this.onDeviceRemoved?.(device);

        this.metrics?.total_devices.dec({
            platform: 'Android',
            znca_version: device.package_info.version,
            znca_build: device.package_info.build,
            android_release: device.system_info.version.release,
            android_platform_version: device.system_info.version.sdk_int,
        });
    }

    async callWithDevice<T>(
        fn: (device: AndroidDeviceConnection, queue_duration: number | null) => Promise<T> | T,
        timeout = 30000, retry = 1, signal?: AbortSignal,
        /** @internal */ _attempts = 0,
    ): Promise<T> {
        const [device, queue_duration] = await this.waitForAvailableDevice(timeout);

        try {
            const result = await fn.call(null, device, queue_duration);
            this.returnAvailableDevice(device);
            return result;
        } catch (err) {
            if ((err as any)?.message === 'Script is destroyed') {
                // Do not return the device to the available pool
                this.handleDeviceUnavailable(device);

                // @ts-expect-error
                err.device = device;

                if (retry > _attempts) {
                    debug('Error in callback, retrying %d/%d', _attempts + 1, retry, err);
                    return this.callWithDevice(fn, timeout, retry, signal, _attempts + 1);
                }
            } else {
                this.returnAvailableDevice(device);
            }

            throw err;
        }
    }

    ping() {
        return Promise.all(this.available.map(async device => {
            try {
                await device.api.ping();
            } catch (err) {
                this.handleDeviceUnavailable(device, err);
            }
        }));
    }
}

export class AndroidDeviceConnection {
    onDeviceDisconnected?: () => void;

    constructor(
        readonly device: Device,
        readonly session: Session,
        readonly script: Script,
        readonly api: FridaScriptExports,
        readonly package_info: PackageInfo,
        readonly system_info: SystemInfo,
        readonly data: {} = {},
    ) {}

    private _destroyed = false;

    get destroyed() {
        return this._destroyed;
    }

    handleDeviceDisconnected(err?: unknown) {
        this._destroyed = true;

        this.onDeviceDisconnected?.();
    }
}

export class AndroidDeviceManager {
    ready: Promise<void> | null = null;
    private _destroyed = false;

    onReattachFailed: (() => void) | null = null;

    constructor(
        readonly devices: AndroidDevicePool,
        public device: AndroidDeviceConnection,
        readonly reattach: () => void,
        readonly device_name: string,
        public adb_path?: string,
        public adb_root = false,
        public exec_command?: string,
        public frida_server_path?: string,
        public start_method = StartMethod.SPAWN,
    ) {}

    async ping() {
        try {
            await this.ready;
            await this.device.api.ping();
        } catch (err) {
            if ((err as any)?.message === 'Script is destroyed') {
                this.reattach();
                return;
            }

            throw err;
        }
    }

    async destroy() {
        this._destroyed = true;

        this.devices.remove(this.device);

        this.device.session.detach();
        this.device.script.unload();
        this.device.handleDeviceDisconnected();

        debug('Releasing wake lock', this.device_name);

        try {
            await execScript(this.device_name, '/data/local/tmp/android-znca-api-server-shutdown.sh',
                this.exec_command, this.adb_path);
        } catch (err) {
            debug('Failed to run shutdown script', err);
        }
    }

    get destroyed() {
        return this._destroyed;
    }

    static async create(
        devices: AndroidDevicePool,
        device_name: string,
        adb_path?: string,
        adb_root = false,
        exec_command?: string,
        frida_server_path?: string,
        start_method = StartMethod.SPAWN,
    ) {
        await setup(
            device_name,
            adb_path,
            frida_server_path,
            start_method,
        );

        const hostname = await this.getDeviceHostname(device_name);

        let device: AndroidDeviceConnection | null;

        {
            const {device: frida_device, session, script} = await attach(
                device_name,
                adb_path,
                adb_root,
                exec_command,
                start_method,
            );

            const api = script.exports as FridaScriptExports;
            const package_info = await api.getPackageInfo();
            const system_info = await api.getSystemInfo();

            device = new AndroidDeviceConnection(frida_device, session, script, api, package_info, system_info, {
                name: hostname ?? device_name,
                connected_at: new Date().toISOString(),
            });
        }

        const reattach = () => {
            // Already attempting to reattach
            if (device_manager.ready || device_manager.destroyed) return;

            debug('Attempting to reconnect to %s', device_name);

            devices.remove(device!);

            device_manager.ready = attach(
                device_name,
                adb_path,
                adb_root,
                exec_command,
                start_method,
            ).then(async ({device: frida_device, session, script}) => {
                const api = script.exports as FridaScriptExports;
                const system_info = await api.getSystemInfo();
                const package_info = await api.getPackageInfo();

                if (device_manager.destroyed) {
                    device_manager.ready = null;
                    session.detach();
                    script.unload();
                    return;
                }

                if (device?.system_info.version.sdk_int !== system_info.version.sdk_int) {
                    debug('Android system version updated while disconnected');
                }
                if (device?.package_info.build !== package_info.build) {
                    debug('znca version updated while disconnected');
                }

                device = new AndroidDeviceConnection(frida_device, session, script, api, package_info, system_info, {
                    name: hostname ?? device_name,
                    connected: new Date().toISOString(),
                });
                device.onDeviceDisconnected = reattach;
                devices.add(device);
                device_manager.device = device;
                device_manager.ready = null;
            }).catch(err => {
                device_manager.ready = null;
                debug('Reattach failed', err);
                device_manager.onReattachFailed?.();
            });
        };

        device.onDeviceDisconnected = reattach;
        devices.add(device);

        const device_manager = new AndroidDeviceManager(
            devices,
            device,
            reattach,
            device_name,
            adb_path,
            adb_root,
            exec_command,
            frida_server_path,
            start_method,
        );

        return device_manager;
    }

    static async getDeviceHostname(name: string) {
        const match = name.match(/^(\[(0-9a-f:.]+\])|[0-9.]+)/);
        const ip_address = match?.[2] || match?.[1];
        if (!ip_address) return null;

        const hostnames = await dns.reverse(ip_address);

        debug('hostname', ip_address, hostnames);
        return hostnames[0] ?? null;
    }
}

export class AndroidDeviceTimeoutError extends Error {
    constructor(
        devices: AndroidDevicePool,
    ) {
        super(devices.devices.length ?
            'Timeout waiting for a worker to become available' :
            'No workers available');
    }
}

async function setup(
    device_name: string,
    adb_path?: string,
    frida_server_path?: string,
    start_method = StartMethod.SPAWN,
) {
    debug('Connecting to device %s', device_name);
    let co = await execFile(adb_path ?? 'adb', [
        'connect',
        device_name,
    ], {
        windowsHide: true,
    });

    while (co.toString().includes('failed to authenticate')) {
        console.log('');
        console.log('-- Allow this computer to connect to the device. --');
        console.log('');
        await new Promise(rs => setTimeout(rs, 5 * 1000));

        await execAdb([
            'disconnect',
            device_name,
        ], adb_path);

        debug('Connecting to device %s', device_name);
        co = await execFile(adb_path ?? 'adb', [
            'connect',
            device_name,
        ], {
            windowsHide: true,
        });
    }

    await execAdb([
        'shell',
        'echo',
        'ready',
    ], adb_path, device_name);

    debug('Pushing scripts');

    await pushScript(device_name, setup_script({
        frida_server_path,
        start_method,
    }), '/data/local/tmp/android-znca-api-server-setup.sh', adb_path);
    await pushScript(device_name, shutdown_script, '/data/local/tmp/android-znca-api-server-shutdown.sh', adb_path);
}

async function attach(
    device_name: string,
    adb_path?: string,
    adb_root = false,
    exec_command?: string,
    start_method = StartMethod.SPAWN,
) {
    await execFile(adb_path ?? 'adb', [
        'connect',
        device_name,
    ], {
        windowsHide: true,
    });

    if (adb_root) {
        debug('Restarting adbd as root');

        await execAdb([
            'root',
        ], adb_path, device_name);

        await execFile(adb_path ?? 'adb', [
            'connect',
            device_name,
        ], {
            windowsHide: true,
        });
    }

    debug('Running scripts');
    await execScript(device_name, '/data/local/tmp/android-znca-api-server-setup.sh', exec_command, adb_path);

    debug('Done');

    const device = await frida.getDevice(device_name);
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

    return {device, session, script};
}
