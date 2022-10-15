//
// Frida script
//

function perform<T>(callback: () => T | Promise<T>) {
    return new Promise<T>((rs, rj) => {
        Java.perform(() => {
            Java.scheduleOnMainThread(() => {
                try {
                    rs(callback());
                } catch (err) {
                    rj(err);
                }
            });
        });
    });
}

export function ping() {
    return true as const;
}

export interface PackageInfo {
    name: string;
    version: string;
    build: number;
}

export function getPackageInfo(): Promise<PackageInfo> {
    return perform(() => {
        const context = Java.use('android.app.ActivityThread').currentApplication().getApplicationContext();

        const info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);

        return {
            name: info.packageName.value,
            version: info.versionName.value,
            build: info.versionCode.value,
            // build: info.getLongVersionCode(),
        };
    });
}

export interface SystemInfo {
    board: string;
    bootloader: string;
    brand: string;
    abis: string[];
    device: string;
    display: string;
    fingerprint: string;
    hardware: string;
    host: string;
    id: string;
    manufacturer: string;
    model: string;
    product: string;
    tags: string;
    time: string;
    type: string;
    user: string;

    version: {
        codename: string;
        release: string;
        // release_display: string;
        sdk: string;
        sdk_int: number;
        security_patch: string;
    };
}

export function getSystemInfo(): Promise<SystemInfo> {
    return perform(() => {
        const Build = Java.use('android.os.Build');
        const Version = Java.use('android.os.Build$VERSION');

        return {
            board: Build.BOARD.value,
            bootloader: Build.BOOTLOADER.value,
            brand: Build.BRAND.value,
            abis: Build.SUPPORTED_ABIS.value,
            device: Build.DEVICE.value,
            display: Build.DISPLAY.value,
            fingerprint: Build.FINGERPRINT.value,
            hardware: Build.HARDWARE.value,
            host: Build.HOST.value,
            id: Build.ID.value,
            manufacturer: Build.MANUFACTURER.value,
            model: Build.MODEL.value,
            product: Build.PRODUCT.value,
            tags: Build.TAGS.value,
            time: Build.TIME.value,
            type: Build.TYPE.value,
            user: Build.USER.value,

            version: {
                codename: Version.CODENAME.value,
                release: Version.RELEASE.value,
                sdk: Version.SDK.value,
                sdk_int: Version.SDK_INT.value,
                security_patch: Version.SECURITY_PATCH.value,
            },
        };
    });
}

export interface FResult {
    f: string;
    timestamp: string | number;
    /** Queue wait duration */
    dw: number;
    /** Initialisation duration */
    di: number;
    /** Processing duration */
    dp: number;
}

export function genAudioH(
    token: string, timestamp: string | number | undefined, request_id: string
): Promise<FResult> {
    const called = Date.now();

    return perform(() => {
        const start = Date.now();

        const libvoip = Java.use('com.nintendo.coral.core.services.voip.LibvoipJni');
        const context = Java.use('android.app.ActivityThread').currentApplication().getApplicationContext();
        libvoip.init(context);

        if (!timestamp) timestamp = Date.now();

        const init = Date.now();
        const f = libvoip.genAudioH(token, '' + timestamp, request_id);
        const end = Date.now();

        return {
            f, timestamp,
            dw: start - called,
            di: init - start,
            dp: end - init,
        };
    });
}

export function genAudioH2(
    token: string, timestamp: string | number | undefined, request_id: string
): Promise<FResult> {
    const called = Date.now();

    return perform(() => {
        const start = Date.now();

        const libvoip = Java.use('com.nintendo.coral.core.services.voip.LibvoipJni');
        const context = Java.use('android.app.ActivityThread').currentApplication().getApplicationContext();
        libvoip.init(context);

        if (!timestamp) timestamp = Date.now();

        const init = Date.now();
        const f = libvoip.genAudioH2(token, '' + timestamp, request_id);
        const end = Date.now();

        return {
            f, timestamp,
            dw: start - called,
            di: init - start,
            dp: end - init,
        };
    });
}
