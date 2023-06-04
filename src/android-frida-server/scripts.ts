import path from 'node:path';
import { StartMethod } from './types.js';
import { getFridaScript } from '../server/util.js';

export const frida_script = await getFridaScript(new URL('../android-frida-server/frida-script.cjs', import.meta.url));

export const setup_script = (options: {
    frida_server_path?: string;
    start_method: StartMethod;
}) => `#!/system/bin/sh

if [ "\`id -u\`" != "0" ]; then
    echo ""
    echo "-- Not running as root, this will not work --"
    echo "Use --adb-root to restart adbd as root (or run adb root manually) or use --exec-command to specify a su-like command to escalate to root."
    echo ""
fi

${options.frida_server_path ? `
# Ensure frida-server is running
if [ "\`netstat -lnt | awk '$6 == "LISTEN" && $4 ~ /\\:27042$/'\`" != "" ]; then
    echo "frida-server is already running"
else
    echo "Running frida-server"
    killall ${JSON.stringify(path.basename(options.frida_server_path))}
    nohup ${JSON.stringify(options.frida_server_path)} >/dev/null 2>&1 &

    if [ "$?" != "0" ]; then
        echo "Failed to start frida-server"
        exit 1
    fi

    sleep 1
fi
`.trim() : ''}

${(options.start_method === StartMethod.FORCE_ACTIVITY || options.start_method === StartMethod.FORCE_SERVICE ? `
# Stop the app
killall com.nintendo.znca
sleep 5
killall -9 com.nintendo.znca
` : '').trim()}

${(options.start_method === StartMethod.ACTIVITY || options.start_method === StartMethod.FORCE_ACTIVITY ? `
# Ensure the app is running
echo "Starting com.nintendo.znca in foreground"
am start-activity com.nintendo.znca/com.nintendo.coral.ui.boot.BootActivity
` : options.start_method === StartMethod.SERVICE || options.start_method === StartMethod.FORCE_SERVICE ? `
# Ensure the app is running
echo "Starting com.nintendo.znca"
am start-foreground-service com.nintendo.znca/com.google.firebase.messaging.FirebaseMessagingService
am start-service com.nintendo.znca/com.google.firebase.messaging.FirebaseMessagingService
` : '').trim()}

if [ "$?" != "0" ]; then
    echo "Failed to start com.nintendo.znca"
    exit 1
fi

echo "Acquiring wake lock"
echo androidzncaapiserver > /sys/power/wake_lock

exit 0
`;

export const shutdown_script = `#!/system/bin/sh

echo "Releasing wake lock"
echo androidzncaapiserver > /sys/power/wake_unlock

exit 0
`;
