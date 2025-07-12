API usage
---

The server has four endpoints, `/api/znca/f` and `/api/znca/config`, which are compatible with [the imink API](https://github.com/JoneWang/imink/wiki/imink-API-Documentation)'s `/f` and `/config` endpoints, and `/api/znca/encrypt-request` and `/api/znca/decrypt-request`, which are used for request encryption in 3.0.1 and later.

> From June 2025, authentication is required. See [api-auth.md](api-auth.md) for more information.

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
interface ZncaApiFRequest {
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

    /**
     * Additional data used in the Account/Login, Account/GetToken or Game/GetWebServiceToken request.
     *
     * If provided the API will return a base64-encoded `encrypted_token_request` field containing the encrypted
     * request body to send to the Coral API.
     *
     * The `f`, `requestId` and `timestamp` fields in `parameter` are required and must be set to an empty string
     * or `0`. This will be replaced with the generated values.
     */
    encrypt_token_request?: {
        url: string;
        parameter:
            import('nxapi/coral').AccountLoginParameter |
            import('nxapi/coral').AccountTokenParameter |
            import('nxapi/coral').WebServiceTokenParameter;
    };
}
```

As the server can support multiple versions of the Nintendo Switch Online app (which generate different `f` values), the `X-znca-Platform` and `X-znca-Version` headers should be used to indicate which version the client is using.

The `X-znca-Client-Version` header is used to check if the client may be incompatible with newer coral versions and should never be set dynamically. It must be hardcoded as the latest version you've tested, even if the `X-znca-Version` header is set dynamically using the `/config` endpoint. From 2.12.0 this header is required.

> Due to changes to Nintendo's API on [23/08/2022](https://github.com/samuelthomas2774/nxapi/discussions/10#discussioncomment-3464443) the `timestamp` parameter should not be sent. If the `timestamp` or `request_id` parameters are not sent their values will be generated and returned in the response. Note that unlike the imink API and [nsotokengen](https://github.com/clovervidia/nsotokengen), only parameters not included in the request will be included in the response.
>
> From 2.12.0, the `timestamp` and `request_id` parameters cannot be used.

```sh
# Make imink-compatible API requests using curl
curl --header "Content-Type: application/json" --header "X-znca-Platform: Android" --header "X-znca-Version: 2.4.0" \
    --data '{"hash_method": "1", "token": "...", "na_id": "0000000000000000"}' "http://[::1]:12345/api/znca/f"

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

### `/encrypt-request`

The following data should be sent as JSON to encrypt a request body to send to the Coral API.

```ts
interface ZncaApiEncryptRequestRequest {
    /**
     * The URL of the Coral API request, e.g. "https://api-lp1.znc.srv.nintendo.net/v4/Friend/List".
     */
    url: string;
    /**
     * The Coral token.
     *
     * This is the token sent in the `Authorization` header in the request to the Coral API. For requests that do
     * not send a token, e.g. Account/Login and Account/GetToken, this should be null, but is required for all
     * requests that do send a token.
     */
    token: string | null;
    /**
     * The request body of the Coral API request.
     *
     * This must be provided as a plain JSON-encoded string, e.g. "{\"parameter\":{}}".
     */
    data: string;
}
```

The encrypted data will be returned as binary data with the content type `application/octet-stream`. This may at some point also support returning JSON with the base64-encoded encrypted data if requested in the `Accept` header. For now please send an `Accept: application/octet-stream` header.

This endpoint currently does not return information about the device used to process the request.

### `/decrypt-response`

The following data should be sent as JSON to decrypt a response from the Coral API.

```ts
interface ZncaApiDecryptResponseRequest {
    /**
     * The response received from the Coral API.
     *
     * This must be base64-encoded.
     */
    data: string;
}
```

The decrypted data will be returned as plain text, which should be valid JSON, with the content type `text/plain`. This may at some point also support returning JSON with the decrypted data if requested in the `Accept` header. For now please send an `Accept: text/plain` header.

While the app can decrypt data it encrypts itself, this endpoint will only return decrypted data that contains a valid Coral API response.

This endpoint currently does not return information about the device used to process the request.

### Health monitoring

An additional endpoint is available for monitoring service availability.

When sending a GET request to `/api/znca/health`, the server will attempt to generate an `f` token if one was not successfully generated in the last 30 seconds, and return the timestamp the last `f` token was generated. The same headers as above will be returned, excluding validation time.

`/api/znca/devices` will return the list of worker devices connected to the server.

These endpoints are only provided for monitoring/debugging purposes.

### Errors

Error responses are always sent as JSON, and will include an `error` field, with an appropriate HTTP status code. Some errors may also include a human-readable `error_description` field intended for client developers.

`error`                             | Description
------------------------------------|---------------
`unknown_error` (500)               | Misc. error, may include an `error_description` with more information
`service_unavailable` (503)         | The server was unable to connect to a worker device, or it took too long for a worker to become available
`unauthorised` (401)                | No authentication was provided but is required, see [api-auth.md](api-auth.md)
`invalid_token` (401)               | The access token was invalid/expired
`insufficient_scope` (403)          | The access token scope does not allow use of the requested endpoint or optional request field
`invalid_request` (400)             | Request parameters are not valid, may include an `errors` and/or `warnings` field with more information
`invalid_request` (415)             | Invalid request body/unsupported content type
`request_parameter_not_set` (400)   | Request parameters are not valid
`unsupported_platform` (400)        | Unsupported `X-znca-Platform`
`unsupported_version` (406)         | Unsupported `X-znca-Version`
`incompatible_client` (400)         | The `X-znca-Client-Version` header indicates the client may not be compatible with the Coral version it requested - this means the client likely needs updating
`rate_limit` (429)                  | See [rate limits](#rate-limits)

Error responses will also include a `debug_id` field containing a random string that may be used to find more information about errors. This is also included in the `X-Trace-Id` header in all responses.

Some success responses will also include a `warnings` field, usually if request data can be accepted by the f-generation API but may return tokens that could be rejected by Nintendo.

### Rate limits

Request type                                | Rate limit                | Key
--------------------------------------------|---------------------------|---------------
Coral authentication (hash method 1)        | 10 requests/60 minutes    | Nintendo Account user
Web service authentication (hash method 2)  | 20 requests/30 minutes    | Coral user
Request encryption                          | TODO                      | nxapi-auth session
Response decryption                         | TODO                      | nxapi-auth session

f-generation requests with a `encrypt_token_request` field currently are only counted as coral/web service auth requests; the request encryption rate limit is not used.
