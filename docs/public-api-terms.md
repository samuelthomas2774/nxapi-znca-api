### Requirements for developing clients using the public API

- The `X-znca-Platform` and `X-znca-Version` headers *should* be sent, and may use the config endpoint to retrieve the latest version
- The `X-znca-Client-Version` header *must* be sent and *must not* be set dynamically
- The `timestamp` and `request_id` fields *should not* be sent (from 2.12.0, these will not work)
- The `User-Agent` header *must* be sent and *must* contain your project's name and version, and contact details
    - The preferred format is `project/version (+url)`, e.g. `nxapi/1.0.0 (+https://github.com/samuelthomas2774/nxapi)`; libraries that use the API should include a User-Agent component for both the library and the dependent software, e.g. `library/1.0.0 (...) nxapi/1.0.0 (...)`
- The client *must* authenticate to the API using credentials obtained via [nxapi-auth](https://nxapi-auth.fancy.org.uk)
    - Authentication using user credentials/authorisation is not required
    - For confidential clients, i.e. clients that access the API via the developer's server, authentication must use a client secret or client assertion
    - For public clients, i.e. clients that access the API via the user's device, authentication may optionally use a client assertion or only the client identifier
    - The token should not be stored and can only be used by a single Coral user
    - The token should be refreshed using the returned refresh token when it expires if the client is still using the API
- The client *should* attempt to imitate Nintendo's official apps as closely as possible
- Where the below requirements include informing the user that data is sent to any non-Nintendo service, including this API and the service itself, the client/service *must* do so *before* asking the user to sign in using their Nintendo Account, and *must* require the user to explicitly acknowledge this before contacting non-Nintendo services
- The client *must* cache tokens for their full validity period, unless deletion is requested, or access is no longer required, and *must* only renew tokens as Nintendo's official apps/web services do
- You may want to include a link to [docs/end-user-help.md](./end-user-help.md)

For clients that authenticate using a user's account:

- The client *must* inform the user that their Nintendo Account id_token, coral token, and all data sent to and received from the Coral API will be sent to a third-party API
- The client *must* include a link to this project

For services that authenticate using a user's account via another server:

- The service *must* inform the user that their Nintendo Account session token will be sent to/stored by your service
- The service *may* use the authorisation code grant, without requesting the `offline` scope, instead of Nintendo's custom session token code grant as normally used by the Nintendo Switch Online app, when only temporary access to the user's account is required
- The service *must* suitably encrypt stored Nintendo Account session tokens, and *must not* allow retrieval of session tokens
- The service *must not* allow anyone other than the user who provided the session token/session token code/similar long-term token to cause the service to perform requests to Nintendo services using that user's account, including by administrators (this does not mean that you can't share data retrieved by that user with other users or services)
- The service *must* provide an option to allow users to delete their Nintendo Account session tokens/similar provided tokens, and any cached tokens, and cease sending any requests to Nintendo services using their account immediately on request
- The service *must* only perform requests to Nintendo services using a user's account in response to the user interacting with the service
- The service *may* make automated requests to Nintendo services using a user's account, at a limited frequency, only if the user has explicitly allowed this, and has recently interacted with the service
- The service *must* limit requests to this API to 1 concurrent request for users that are not interacting with the service (that means, when handling interactions for multiple users, multiple simultaneous requests can be sent, but only one automated request)
- The service *must* appropriately handle errors, such as by deleting a user's session token if an `invalid_grant` error is received
- The service *must not* automatically retry requests to this API, except for network errors where the connection is closed before a HTTP response is received, or as specified by the `Retry-After` header
- The service *must not* automatically retry requests to Nintendo services, except for network errors where the connection is closed before a HTTP response is received
