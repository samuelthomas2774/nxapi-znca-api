nxapi znca API server
---

This repository contains a server for generating `f` parameters required to authenticate to the Nintendo Switch Online app API. This was previously part of [nxapi](https://gitlab.fancy.org.uk/samuel/nxapi) ([GitHub](https://github.com/samuelthomas2774/nxapi)), a library and command line and Electron app for using Nintendo's smart device app APIs.

This uses Frida to call the token generation functions in the Nintendo Switch Online app on a rooted Android device.

This server can be self hosted to avoid sending access tokens to third party APIs.

### Public API

A server running this API is available at https://nxapi-znca-api.fancy.org.uk/api/znca. If you would like to use this set a `User-Agent` header including your project's name and version number (and contact information if your project is not easily discoverable, e.g. on GitHub), and send me a message in the [nxapi Discord server](https://discord.com/invite/4D82rFkXRv). If your project authenticates as the user's Nintendo Account you must explain that their id_token will be sent to a third-party API, and include a link to here.

Status is available at https://nxapi-status.fancy.org.uk. Usage stats are available at https://ubuntu-2204-vm-test.fancy.org.uk/grafana/public-dashboards/57854670274a4ddf98b12332a6c47cf4.

The API is mostly compatible with the imink API, however:

- If the `timestamp` and/or `request_id` options are included in the request body they will not be included in the response.
- The `X-znca-Platform` and `X-znca-Version` headers should be used to indicate which version of the Nintendo Switch Online app should be used.
    - This makes it easier to migrate to newer versions of the app and prevents using invalid `f` parameters when the client version (the `X-ProductVersion` header sent to Nintendo's API) does not match the version used to generate `f`.
    - If these headers are not sent, any version available on the server will be used.
    - `/api/znca/config` can be used to get the latest supported app version. This is compatible with the imink API's `/config` endpoint.

See [docs/api.md](docs/api.md) for API usage details.

### Requirements

- adb is installed on the computer running the server
- The Android device is running adbd as root or a su-like command can be used to escalate to root
- The frida-server executable is located at `/data/local/tmp/frida-server` on the Android device (a different path can be provided using the `--frida-server-path` option)
- The Nintendo Switch Online app is installed on the Android device

No other software (e.g. frida-tools) needs to be installed on the computer running nxapi. The Android device must be constantly reachable using ADB. The server will attempt to reconnect to the Android device and will automatically retry any requests that would fail due to the device disconnecting. The server will exit if it fails to reconnect to the device. A service manager should be used to restart the server if it exits.

The service can also run in a container. The Android device can also run in a container using [redroid](https://github.com/remote-android/redroid-doc). See [Docker](#docker).

### Install

#### Install with npm

Node.js and npm must already be installed.

```sh
# From registry.npmjs.com
npm install --global nxapi-znca-api

# From gitlab.fancy.org.uk
npm install --global --registry https://gitlab.fancy.org.uk/api/v4/packages/npm/ @samuel/nxapi-znca-api

# From npm.pkg.github.com
npm install --global --registry https://npm.pkg.github.com @samuelthomas2774/nxapi-znca-api

# From gitlab.com
npm install --global --registry https://gitlab.com/api/v4/packages/npm/ @samuelthomas2774/nxapi-znca-api
```

#### Install from source

Node.js and npm must already be installed.

```sh
# Don't download an archive, as nxapi detects the current git revision
git clone https://gitlab.fancy.org.uk/samuel/nxapi-znca-api.git
cd nxapi-znca-api

npm install
npx tsc
npm link

# Build Docker image
docker build . --tag registry.fancy.org.uk/samuel/nxapi-znca-api
# # Run in Docker
# docker run -it --rm -v ./data:/data registry.fancy.org.uk/samuel/nxapi-znca-api ...
```

#### Docker

A docker-compose project using a redroid container is included.

```sh
# Don't download an archive, as nxapi detects the current git revision
git clone https://gitlab.fancy.org.uk/samuel/nxapi-znca-api.git
cd nxapi-znca-api

# Optionally build Docker image (by default docker-compose will pull the latest version from Docker Hub)
# docker build . --tag registry.fancy.org.uk/samuel/nxapi-znca-api --tag samuelthomas2774/nxapi-znca-api

# Load kernel modules for redroid
modprobe binder_linux devices="binder,hwbinder,vndbinder"
modprobe ashmem_linux

# The URL to download the Nintendo Switch Online app from must be provided (a .env file can also be used)
CORAL_APK_URL="https://example.com/com.nintendo.znca-2.4.0.apk" docker compose up -d
```

### Usage

The server can be run using the `nxapi-znca-api android-frida-server` command.

```sh
# Start the server using the ADB server "android.local:5555" listening on all interfaces on a random port
nxapi-znca-api android-frida-server android.local:5555

# Start the server listening on a specific address/port
# The `--listen` option can be used multiple times
nxapi-znca-api android-frida-server android.local:5555 --listen "[::1]:12345"

# Use a command to escalate to root to start frida-server and the Nintendo Switch Online app
# "{cmd}" will be replaced with the path to a temporary script in double quotes
nxapi-znca-api android-frida-server android.local:5555 --exec-command "/system/bin/su -c {cmd}"

# Specify a different location for the adb executable if it is not in the search path
nxapi-znca-api android-frida-server android.local:5555 --adb-path "/usr/local/bin/adb"

# Run `adb root` when connecting to the device to restart adbd as root
nxapi-znca-api android-frida-server android.local:5555 --adb-root

# Specify a different location for the frida-server executable on the device
nxapi-znca-api android-frida-server android.local:5555 --frida-server-path "/data/local/tmp/frida-server-15.1.17-android-arm"

# Use Frida to start the app on the device (even if it is already running) (recommended)
nxapi-znca-api android-frida-server android.local:5555 --start-method spawn
# Use `am start-activity` to ensure the app process is running
nxapi-znca-api android-frida-server android.local:5555 --start-method activity
# Use `am start-service` to ensure the app process is running, without causing Android to show the app (default)
nxapi-znca-api android-frida-server android.local:5555 --start-method service
# Do not attempt to start the app on the device automatically - this will cause the server to fail if the app is not already running
nxapi-znca-api android-frida-server android.local:5555 --start-method none

# Strictly validate the timestamp and request_id parameters sent by the client are likely to be accepted by Nintendo's API
nxapi-znca-api android-frida-server android.local:5555 --strict-validate

# Don't validate the token sent by the client
nxapi-znca-api android-frida-server android.local:5555 --no-validate-tokens

# Docker
# From docker.io
docker run -it --rm -v ./data:/data samuelthomas2774/nxapi-znca-api ...
# From gitlab.fancy.org.uk
docker run -it --rm -v ./data:/data registry.fancy.org.uk/samuel/nxapi-znca-api ...
```

See [docs/api.md](docs/api.md) for API usage details.
