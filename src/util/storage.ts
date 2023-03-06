import path from 'node:path';
import getPaths from 'env-paths';
import * as persist from 'node-persist';

export const paths = getPaths('nxapi');

export async function initStorage(dir: string) {
    const storage = persist.create({
        dir: path.join(dir, 'persist'),
        stringify: data => JSON.stringify(data, null, 4) + '\n',
        expiredInterval: 0,
    });
    await storage.init();
    return storage;
}
