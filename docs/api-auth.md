API authentication
---

The API requires client authentication via [nxapi-auth](https://nxapi-auth.fancy.org.uk).

This uses the standard OAuth 2 client credentials grant. In OAuth 2 terms:

- nxapi-auth is the authorisation server
- nxapi-znca-api is the resource server and itself the protected resource

OAuth clients must be registered at https://nxapi-auth.fancy.org.uk/oauth/clients.

### Tokens

Clients can obtain a token by sending an OAuth 2 token request to nxapi-auth.

```ts
const params = new URLSearchParams();

params.append('grant_type', 'client_credentials');
params.append('client_id', import.meta.env.NXAPI_AUTH_CLIENT_ID);
// optionally also a client assertion, or for confidential clients either a client assertion or client secret
// if using a client assertion, client_id is optional
// if the client already has a token, use the refresh_token grant instead
params.append('scope', 'ca:gf ca:er ca:dr');

const response = await fetch('https://nxapi-auth.fancy.org.uk/api/oauth/token', {
    method: 'POST',
    headers: {
        'Accept': 'application/json',
    },
    body: params,
});

const token = await response.json() as {
    access_token: string;
    token_type: 'Bearer';
    expires_in: number;
    scope?: string;
    refresh_token?: string;
};
```

The returned token, including refresh token, is short-lived and must not be saved persistently. Instead, the client should always attempt to obtain a new token using it's client credentials if it does not already have a token. Tokens can only be used for a single Coral user; if the client authenticates using multiple Nintendo Accounts it must obtain a separate token for each user.

If the client is attempting to refresh a token using the `refresh_token` grant and receives an `invalid_grant` error it should attempt to obtain a new token using it's client credentials. If the client receives an `invalid_grant` error in any other case it should not retry.

- [RFC 6749: The OAuth 2.0 Authorization Framework](https://datatracker.ietf.org/doc/html/rfc6749)
    - [Client Credentials Grant](https://datatracker.ietf.org/doc/html/rfc6749#section-4.4)
    - [Issuing an Access Token](https://datatracker.ietf.org/doc/html/rfc6749#section-5)
    - [Refreshing an Access Token](https://datatracker.ietf.org/doc/html/rfc6749#section-6)
- [RFC 7521: Assertion Framework for OAuth 2.0 Client Authentication and Authorization Grants](https://datatracker.ietf.org/doc/html/rfc7521)
    - [Using Assertions for Client Authentication](https://datatracker.ietf.org/doc/html/rfc7521#section-4.2)

#### Client assertions

The token endpoint supports `urn:ietf:params:oauth:client-assertion-type:jwt-bearer` assertions. This must be configured in nxapi-auth.

JWTs must have these claims:

- `aud`, exactly or an array including `https://nxapi-auth.fancy.org.uk`
- `typ`, exactly `client_assertion`
- `exp`, and not be expired

JWTs must also:

- Have a `jku` value in the token header, matching a JSON Web Key Set URI configured in nxapi-auth
- Have a `kid` value in the token header
- Have a `alg` value in the token header of `RS256`

### Token authentication

Requests to the f-generation API should send the token in the `Authorization` header.

If the client receives an `invalid_token` error it should attempt to refresh the token.

- [RFC 6750: The OAuth 2.0 Authorization Framework: Bearer Token Usage](https://datatracker.ietf.org/doc/html/rfc6750)

### Authorisation scope

Tokens have limited access to the f-generation API by the requested scope.

Available token scopes are listed below. All access scopes have two names, one used by nxapi-auth and one used by the f-generation API. When requesting a token, use the nxapi-auth name.

nxapi-auth  | nxapi-znca-api        | Description
------------|-----------------------|---------------
`ca:gf`     | `generate-f`          | Allows the client to use the `/f` endpoint.
`ca:er`     | `encrypt-request`     | Allows the client to use the `/encrypt-request` endpoint, and the `encrypt_token_request` field in the `/f` endpoint.
`ca:dr`     | `decrypt-response`    | Allows the client to use the `/decrypt-response` endpoint.
`ca:da`     | `decrypt-any`         | Allows the client to use the `/decrypt-response` endpoint to decrypt data that is not a valid Coral response.

All clients can request the `ca:gf`, `ca:er` and `ca:dr` scopes. `ca:da` requires approval and is limited to confidential clients; this scope is intended for development only.
