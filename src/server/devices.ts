import createDebug from 'debug';
import { Device, Script, Session } from 'frida';
import express from 'express';
import { ResponseError } from '../util/http-server.js';
import MetricsCollector from './metrics.js';
import { FResult } from './types.js';

const debug = createDebug('nxapi:znca-api:server:devices');

type WaitCallback = readonly [
    callback: (device: DeviceConnection) => void,
    filter: ((device: DeviceConnection) => boolean) | undefined,
];

export class DevicePool {
    devices: DeviceConnection[] = [];
    available: DeviceConnection[] = [];
    waiting: WaitCallback[] = [];

    onDeviceRemoved?: (device: DeviceConnection) => void;

    constructor(
        readonly metrics: MetricsCollector | null = null,
    ) {}

    getAvailableDevice(filter?: (device: DeviceConnection) => boolean) {
        for (const device of this.available) {
            if (!filter || filter.call(null, device)) {
                this.available.splice(this.available.indexOf(device), 1);

                debug('use worker, %d/%d available', this.available.length, this.devices.length, device.device.id);

                return device;
            }
        }
    }

    waitForAvailableDevice(
        filter?: (device: DeviceConnection) => boolean, timeout_ms?: number, signal?: AbortSignal,
    ) {
        const device = this.getAvailableDevice(filter);

        if (device) {
            return Promise.resolve([device, null] as const);
        }
        
        if (!timeout_ms) {
            return Promise.reject(new DeviceTimeoutError(this, filter));
        }

        if (this.devices.length && !this.devices.find(device => !filter || filter.call(null, device))) {
            return Promise.reject(new DeviceTimeoutError(this, filter));
        }

        const start = Date.now();

        debug('waiting for worker, 0/%d available', this.devices.length, filter);

        return new Promise<readonly [DeviceConnection, number | null]>((rs, rj) => {
            const callback = (device: DeviceConnection) => {
                const queue_duration = Date.now() - start;
                debug('use worker, %d/%d available, waited %d ms', this.available.length, this.devices.length, queue_duration, device.device.id);
                rs([device, queue_duration]);
                if (timeout) clearTimeout(timeout);
                signal?.removeEventListener('abort', onabort);
            };
            const entry: WaitCallback = [callback, filter];

            const timeout = timeout_ms ? setTimeout(() => {
                debug('timeout waiting for worker, 0/%d available', this.devices.length, filter);
                rj(new DeviceTimeoutError(this, filter));

                let index;
                while ((index = this.waiting.indexOf(entry)) !== -1) {
                    this.waiting.splice(index, 1);
                }

                signal?.removeEventListener('abort', onabort);
            }, timeout_ms) : null;

            const onabort = (event: Event) => {
                rj(event);

                let index;
                while ((index = this.waiting.indexOf(entry)) !== -1) {
                    this.waiting.splice(index, 1);
                }

                if (timeout) clearTimeout(timeout);
            };

            signal?.addEventListener('abort', onabort);

            this.waiting.push(entry);
        });
    }

    returnAvailableDevice(device: DeviceConnection) {
        if (!this.devices.includes(device)) {
            // Device was removed from the available device pool
            return;
        }

        this.handleDeviceAvailable(device);

        debug('return worker, %d/%d available', this.available.length, this.devices.length, device.device.id);
    }

    protected handleDeviceAvailable(device: DeviceConnection) {
        for (const next of this.waiting) {
            const [callback, filter] = next;

            if (!filter || filter.call(null, device)) {
                this.waiting.splice(this.waiting.indexOf(next), 1);

                callback.call(null, device);
                return;
            }
        }

        this.available.push(device);
    }

    protected handleDeviceUnavailable(device: DeviceConnection, err?: unknown) {
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
            platform: device.platform,
            znca_version: device.znca_version,
            znca_build: device.znca_build,
            ...device.platform_version_info,
        });
    }

    add(device: DeviceConnection) {
        if (this.devices.includes(device)) return;

        this.devices.push(device);
        this.handleDeviceAvailable(device);

        debug('worker added, %d/%d available', this.available.length, this.devices.length, device);

        this.metrics?.total_devices.inc({
            platform: device.platform,
            znca_version: device.znca_version,
            znca_build: device.znca_build,
            ...device.platform_version_info,
        });
    }

    remove(device: DeviceConnection) {
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
            platform: device.platform,
            znca_version: device.znca_version,
            znca_build: device.znca_build,
            ...device.platform_version_info,
        });
    }

    async callWithDevice<T>(
        fn: (device: DeviceConnection, queue_duration: number | null) => Promise<T> | T,
        filter?: (device: DeviceConnection) => boolean, timeout = 30000, retry = 1, signal?: AbortSignal,
        /** @internal */ _attempts = 0,
    ): Promise<T> {
        const [device, queue_duration] = await this.waitForAvailableDevice(filter, timeout);

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
                    debug('Error in callback, retrying %d/%d', _attempts + 1, retry, device.device.id, err);
                    return this.callWithDevice(fn, filter, timeout, retry, signal, _attempts + 1);
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
                await device.ping();
            } catch (err) {
                this.handleDeviceUnavailable(device, err);
            }
        }));
    }
}

export abstract class DeviceConnection {
    onDeviceDisconnected?: () => void;

    constructor(
        readonly device: Device,
        readonly session: Session,
        readonly script: Script,
        readonly platform: 'iOS' | 'Android',
        readonly znca_version: string,
        readonly znca_build: number,
        readonly platform_version_info: object,
        readonly debug_info: object,
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

    abstract setResponseHeaders(res: express.Response): void;

    abstract ping(): Promise<void>;
    abstract genAudioH(token: string, timestamp: string | number | undefined, request_id: string,
        user_data?: unknown): Promise<FResult>;
    abstract genAudioH2(token: string, timestamp: string | number | undefined, request_id: string,
        user_data?: unknown): Promise<FResult>;

    abstract generateRequestId(): string;
}

export class DeviceTimeoutError extends ResponseError {
    constructor(
        devices: DevicePool,
        filter?: (device: DeviceConnection) => boolean,
    ) {
        if (devices.devices.find(device => !filter || filter.call(null, device))) {
            super(503, 'service_unavailable', 'Timeout waiting for a worker to become available');
        } else if (filter) {
            super(406, 'unsupported_version', 'No matching workers available');
        } else {
            super(503, 'service_unavailable', 'No workers available');
        }
    }
}
