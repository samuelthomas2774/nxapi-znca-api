nxapi znca API server
---

This repository contains a server for generating `f` parameters required to authenticate to the Nintendo Switch Online app API. This was previously part of [nxapi](https://gitlab.fancy.org.uk/samuel/nxapi) ([GitHub](https://github.com/samuelthomas2774/nxapi)), a library and command line and Electron app for using Nintendo's smart device app APIs.

This uses Frida to call the token generation functions in the Nintendo Switch Online app on a rooted Android device.

This server can be used instead of the imink/flapg API to avoid sending access tokens to third party APIs.

### Requirements

- adb is installed on the computer running the server
- The Android device is running adbd as root or a su-like command can be used to escalate to root
- The frida-server executable is located at `/data/local/tmp/frida-server` on the Android device (a different path can be provided using the `--frida-server-path` option)
- The Nintendo Switch Online app is installed on the Android device

No other software (e.g. frida-tools) needs to be installed on the computer running nxapi. The Android device must be constantly reachable using ADB. The server will attempt to reconnect to the Android device and will automatically retry any requests that would fail due to the device disconnecting. The server will exit if it fails to reconnect to the device. A service manager should be used to restart the server if it exits.

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
docker build . --tag gitlab.fancy.org.uk:5005/samuel/nxapi-znca-api
# # Run in Docker
# docker run -it --rm -v ./data:/data gitlab.fancy.org.uk:5005/samuel/nxapi-znca-api ...
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
docker run -it --rm -v ./data:/data gitlab.fancy.org.uk:5005/samuel/nxapi-znca-api ...
```

This server has a single endpoint, `/api/znca/f`, which is fully compatible with [the imink API](https://github.com/JoneWang/imink/wiki/imink-API-Documentation)'s `/f` endpoint. The following data should be sent as JSON:

```ts
interface AndroidZncaApiRequest {
    /**
     * `"1"` or `1` for Coral (Nintendo Switch Online app) authentication (`Account/Login` and `Account/GetToken`).
     * `"2"` or `2` for web service authentication (`Game/GetWebServiceToken`).
     */
    hash_method: '1' | '2' | 1 | 2;
    /**
     * The token used to authenticate to the Coral API:
     * The Nintendo Account `id_token` for Coral authentication.
     * The Coral access token for web service authentication.
     */
    token: string;
    /**
     * The current timestamp in milliseconds, either as a number or a string.
     */
    timestamp?: string | number;
    /**
     * A random (v4) UUID.
     */
    request_id?: string;
}
```

> Due to changes to Nintendo's API on [23/08/2022](https://github.com/samuelthomas2774/nxapi/discussions/10#discussioncomment-3464443) the `timestamp` parameter should not be sent. If the `timestamp` or `request_id` parameters are not sent their values will be generated and returned in the response. Note that unlike the imink API and [nsotokengen](https://github.com/clovervidia/nsotokengen), only parameters not included in the request will be included in the response.

```sh
# Make imink-compatible API requests using curl
curl --header "Content-Type: application/json" --data '{"hash_method": "1", "token": "..."}' "http://[::1]:12345/api/znca/f"
curl --header "Content-Type: application/json" --data '{"hash_method": "1", "token": "...", "request_id": "..."}' "http://[::1]:12345/api/znca/f"
curl --header "Content-Type: application/json" --data '{"hash_method": "1", "token": "...", "timestamp": "...", "request_id": "..."}' "http://[::1]:12345/api/znca/f"

# Make legacy nxapi v1.3.0-compatible API requests using curl
curl --header "Content-Type: application/json" --data '{"type": "nso", "token": "..."}' "http://[::1]:12345/api/znca/f"
curl --header "Content-Type: application/json" --data '{"type": "nso", "token": "...", "uuid": "..."}' "http://[::1]:12345/api/znca/f"
curl --header "Content-Type: application/json" --data '{"type": "nso", "token": "...", "timestamp": "...", "uuid": "..."}' "http://[::1]:12345/api/znca/f"

# Use the znca API server in nxapi
# This should be set when running any nso or web service commands as the access token will be refreshed automatically when it expires
ZNCA_API_URL=http://[::1]:12345/api/znca nxapi nso ...
```

Information about the device and the Nintendo Switch Online app, as well as information on how long the request took to process will be included in the response headers.

Header                          | Description
--------------------------------|------------------
`X-Android-Build-Type`          | Android build type, e.g. `user`
`X-Android-Release`             | Android release/marketing version, e.g. `8.0.0`
`X-Android-Platform-Version`    | Android SDK version, e.g. `26`
`X-znca-Platform`               | Device platform - always `Android`
`X-znca-Version`                | App release/marketing version, e.g. `2.2.0`
`X-znca-Build`                  | App build/internal version, e.g. `2832`

The following performance metrics are included in the `Server-Timing` header:

Name        | Description
------------|------------------
`validate`  | Time validating the request body.
`attach`    | Time waiting for the device to become available, start frida-server, start the app and attach the Frida script to the app process. This metric will not be included if the server is already connected to the device.
`queue`     | Time waiting for the processing thread to become available.
`init`      | Time waiting for `com.nintendo.coral.core.services.voip.Libvoipjni.init`.
`process`   | Time waiting for `com.nintendo.coral.core.services.voip.Libvoipjni.genAudioH`/`genAudioH2`.

#### Health monitoring

An additional endpoint is available for monitoring service availability.

When sending a GET request to `/api/znca/health`, the server will attempt to generate an `f` token if one was not successfully generated in the last 30 seconds, and return the timestamp the last `f` token was generated. The same headers as above will be returned, excluding validation time.
