API usage
---

The server has two endpoints, `/api/znca/f` and `/api/znca/config`, which are compatible with [the imink API](https://github.com/JoneWang/imink/wiki/imink-API-Documentation)'s `/f` and `/config` endpoints.

### `/config`

`/api/znca/config` can be used to check which app versions are available.

`nso_version` is the latest version supported by the server.

The `versions` field is not supported by the imink API. `worker_count` is provided for monitoring/debugging and should not be used by clients.

```jsonc
{
    "versions": [
        {
            "platform": "Android",
            "name": "com.nintendo.znca",
            "version": "2.4.0",
            "build": 3467,
            "worker_count": 2
        },
        {
            "platform": "Android",
            "name": "com.nintendo.znca",
            "version": "2.5.0",
            "build": 3828,
            "worker_count": 2
        }
    ],
    "nso_version": "2.5.0"
}
```

### `/f`

The following data should be sent as JSON to generate an `f` parameter:

```ts
interface ZncaApiRequest {
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
    /**
     * The user's Nintendo Account ID from https://api.accounts.nintendo.com/2.0.0/users/me (`id`).
     *
     * For Coral authentication (hash method 1) this will be set automatically from the `token` if not provided.
     * (Although providing it is recommended.)
     * For web service authentication (hash method 2) this must be provided. If it is not provided an empty string
     * will be used, which will cause the resulting f token to be rejected if/when Nintendo starts validating this.
     */
    na_id?: string;
    /**
     * The user's Coral user ID from Account/Login or Account/GetToken (`result.user.id`).
     *
     * Only used for web service authentication (hash method 2).
     *
     * This will be set automatically from the `token` if not provided. (Providing it is recommended.)
     */
    coral_user_id?: string;
}
```

As the server can support multiple versions of the Nintendo Switch Online app (which generate different `f` values), the `X-znca-Platform` and `X-znca-Version` headers should be used to indicate which version the client is using.

> Due to changes to Nintendo's API on [23/08/2022](https://github.com/samuelthomas2774/nxapi/discussions/10#discussioncomment-3464443) the `timestamp` parameter should not be sent. If the `timestamp` or `request_id` parameters are not sent their values will be generated and returned in the response. Note that unlike the imink API and [nsotokengen](https://github.com/clovervidia/nsotokengen), only parameters not included in the request will be included in the response.

```sh
# Make imink-compatible API requests using curl
curl --header "Content-Type: application/json" --header "X-znca-Platform: Android" --header "X-znca-Version: 2.4.0" \
    --data '{"hash_method": "1", "token": "..."}' "http://[::1]:12345/api/znca/f"
curl --header "Content-Type: application/json" --header "X-znca-Platform: Android" --header "X-znca-Version: 2.4.0" \
    --data '{"hash_method": "1", "token": "...", "request_id": "..."}' "http://[::1]:12345/api/znca/f"
curl --header "Content-Type: application/json" --header "X-znca-Platform: Android" --header "X-znca-Version: 2.4.0" \
    --data '{"hash_method": "1", "token": "...", "timestamp": "...", "request_id": "..."}' "http://[::1]:12345/api/znca/f"

# Make legacy nxapi v1.3.0-compatible API requests using curl
curl --header "Content-Type: application/json" --header "X-znca-Platform: Android" --header "X-znca-Version: 2.4.0" \
    --data '{"type": "nso", "token": "..."}' "http://[::1]:12345/api/znca/f"
curl --header "Content-Type: application/json" --header "X-znca-Platform: Android" --header "X-znca-Version: 2.4.0" \
    --data '{"type": "nso", "token": "...", "uuid": "..."}' "http://[::1]:12345/api/znca/f"
curl --header "Content-Type: application/json" --header "X-znca-Platform: Android" --header "X-znca-Version: 2.4.0" \
    --data '{"type": "nso", "token": "...", "timestamp": "...", "uuid": "..."}' "http://[::1]:12345/api/znca/f"

# Use the znca API server in nxapi
# This should be set when running any nso or web service commands as the access token will be refreshed automatically when it expires
ZNCA_API_URL=http://[::1]:12345/api/znca nxapi nso ...
```

Information about the device and the Nintendo Switch Online app, as well as information on how long the request took to process will be included in the response headers.

Header                          | Description
--------------------------------|------------------
`X-Device-Id`                   | ADB device ID (IP address and ADB port) of the Android device
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

### Health monitoring

An additional endpoint is available for monitoring service availability.

When sending a GET request to `/api/znca/health`, the server will attempt to generate an `f` token if one was not successfully generated in the last 30 seconds, and return the timestamp the last `f` token was generated. The same headers as above will be returned, excluding validation time.

`/api/znca/devices` will return the list of worker devices connected to the server.

These endpoints are only provided for monitoring/debugging purposes.
