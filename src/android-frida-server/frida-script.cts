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
                } finally {
                    user_data = null;
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

export interface UserData1 {
    na_id: string;
    na_id_token: string;
}
export interface UserData2 {
    coral_token: string;
    coral_user_id: string;
    na_id: string;
}

let user_data: UserData1 | UserData2 | null = null;

export function setUserDataForGenAudioH(data: UserData1) {
    user_data = data;
}
export function setUserDataForGenAudioH2(data: UserData2) {
    user_data = data;
}

function patchJavaMethod<A extends unknown[], R>(
    cls: any, method: string,
    callback: (original: (...args: A) => R, args: A) => R,
) {
    cls[method].implementation = function (...args: A) {
        let original = (...args: A) => {
            return this[method](...args);
        };

        try {
            return callback.call(null, original, args);
        } catch (err) {
            console.log('Error in patched method', cls, method, err);
        }
    };
}

export function initialiseJavaPatches(version: number) {
    // 2.4.0
    if (version >= 3467) {
        return perform(() => {
            const e = Java.use('com.nintendo.coral.core.network.e');

            patchJavaMethod(e, 'b', original => {
                return user_data && 'coral_token' in user_data ? user_data.coral_token : original();
            });

            const NAUser = Java.use('com.nintendo.coral.core.entity.NAUser');

            patchJavaMethod(NAUser, 'c', original => {
                return user_data ? user_data.na_id : original();
            });

            const m = Java.use('com.nintendo.nx.nasdk.m');

            patchJavaMethod(m, 'd', original => {
                return user_data && 'na_id_token' in user_data ? user_data.na_id_token : original();
            });

            /** com.nintendo.coral.models.AccountModel */
            const AccountModel = Java.use('za.h');

            patchJavaMethod(AccountModel, 'v', original => {
                const coral_user: any = original();

                if (user_data && 'coral_user_id' in user_data) {
                    coral_user.a.value = int64(user_data.coral_user_id);
                }

                return coral_user;
            });

            // android.content.SharedPreferences
            const SharedPreferences = Java.use('android.app.SharedPreferencesImpl');

            patchJavaMethod(SharedPreferences, 'getString', (original, args) => {
                const [key, default_value] = args;

                if (user_data) {
                    if (key === 'CoralNAUserKey') return JSON.stringify({
                        id: '0000000000000000',
                        nickname: '-',
                        country: 'GB',
                        birthday: '2000-01-01',
                        language: 'en-GB',
                        screenName: '•••@••• / •••',
                        mii: null,
                    });

                    if (key === 'CoralUserKeyV2') return JSON.stringify({
                        id: 0,
                        nsaId: '0000000000000000',
                        name: '-',
                        imageUri: 'https://cdn-image.baas.nintendo.com/0/0000000000000000',
                        supportId: '0000-0000-0000-0000-0000-0',
                        links: {
                            nintendoAccount: { membership: { active: true } },
                            friendCode: { regenerable: true, regenerableAt: 0, id: '0000-0000-0000' },
                        },
                        etag: '"0000000000000000"',
                        permissions: { presence: 'FRIENDS' },
                        presence: { state: 'OFFLINE', updatedAt: 0, logoutAt: 0, game: {} },
                    });
                }

                return original(...args);
            });
        });
    }
}

export function genAudioH(
    token: string, timestamp: string | number | undefined, request_id: string,
    user_data?: UserData1,
): Promise<FResult> {
    const called = Date.now();

    return perform(() => {
        if (user_data) setUserDataForGenAudioH(user_data);

        const start = Date.now();

        const libvoip = Java.use('com.nintendo.coral.core.services.voip.LibvoipJni');

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
    token: string, timestamp: string | number | undefined, request_id: string,
    user_data?: UserData2,
): Promise<FResult> {
    const called = Date.now();

    return perform(() => {
        if (user_data) setUserDataForGenAudioH2(user_data);

        const start = Date.now();

        const libvoip = Java.use('com.nintendo.coral.core.services.voip.LibvoipJni');

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
