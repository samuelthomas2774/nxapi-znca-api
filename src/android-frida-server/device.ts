import * as child_process from 'node:child_process';
import * as dns from 'node:dns/promises';
import * as util from 'node:util';
import createDebug from 'debug';
import frida, { Device, Script, Session } from 'frida';
import { v4 as uuidgen } from 'uuid';
import express from 'express';
import { DeviceConnection, DevicePool } from '../server/devices.js';
import { frida_script, setup_script, shutdown_script } from './scripts.js';
import { FridaScriptExports, PackageInfo, StartMethod, SystemInfo } from './types.js';
import { execAdb, execScript, pushScript } from './util.js';
import { UserData1, UserData2 } from './frida-script.cjs';

const debug = createDebug('nxapi:znca-api:android-frida-server:device');

const execFile = util.promisify(child_process.execFile);

export class AndroidDeviceConnection extends DeviceConnection {
    constructor(
        device: Device,
        session: Session,
        script: Script,
        readonly api: FridaScriptExports,
        readonly package_info: PackageInfo,
        readonly system_info: SystemInfo,
        data: {} = {},
    ) {
        super(device, session, script, 'Android', package_info.version, package_info.build, {
            android_release: system_info.version.release,
            android_platform_version: system_info.version.sdk_int,
        }, {
            android_build_type: system_info.type,
            android_release: system_info.version.release,
            android_platform_version: system_info.version.sdk_int,
            platform: 'Android',
            znca_version: package_info.version,
            znca_build: package_info.build,
        }, data);
    }

    setResponseHeaders(res: express.Response) {
        res.setHeader('X-Android-Build-Type', this.system_info.type);
        res.setHeader('X-Android-Release', this.system_info.version.release);
        res.setHeader('X-Android-Platform-Version', this.system_info.version.sdk_int);
    }

    async ping() {
        await this.api.ping();
    }

    genAudioH(token: string, timestamp: string | number | undefined, request_id: string, user_data?: UserData1) {
        return this.api.genAudioH(token, timestamp, request_id, user_data ?? undefined);
    }

    genAudioH2(token: string, timestamp: string | number | undefined, request_id: string, user_data?: UserData2) {
        return this.api.genAudioH2(token, timestamp, request_id, user_data ?? undefined);
    }

    generateRequestId() {
        return uuidgen();
    }
}

export class AndroidDeviceManager {
    ready: Promise<void> | null = null;
    private _destroyed = false;

    onReattachFailed: (() => void) | null = null;

    constructor(
        readonly devices: DevicePool,
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

        this.device.handleDeviceDisconnected();

        debug('Releasing wake lock', this.device_name);

        try {
            await this.device.script.unload();
            await this.device.session.detach();
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
        devices: DevicePool,
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

            await api.initialiseJavaPatches(package_info.build);

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

                await api.initialiseJavaPatches(package_info.build);

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

        if (start_method === StartMethod.SPAWN) {
            await device.resume(process.pid);
        }

        // Wait before attaching to the process
        // Calling LibvoipJni.init when Frida is loaded can cause issues
        debug('Waiting 10s to prevent interfering with libvoip init');
        await new Promise(rs => setTimeout(rs, 10000));

        debug('Attaching to app process');
        session = await device.attach(process.pid);
    } catch (err) {
        debug('Could not attach to process', err);
        throw new Error('Failed to attach to process');
    }

    debug('Attached to app process, pid %d', session.pid);

    const script = await session.createScript(frida_script);
    await script.load();

    return {device, session, script};
}
