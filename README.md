nxapi znca API server
---

This repository contains a server for generating `f` parameters required to authenticate to the Nintendo Switch Online app API. This was previously part of [nxapi](https://gitlab.fancy.org.uk/samuel/nxapi) ([GitHub](https://github.com/samuelthomas2774/nxapi)), a library and command line and Electron app for using Nintendo's smart device app APIs.

This uses Frida to call the token generation functions in the Nintendo Switch Online app on a rooted Android device.

### Public API

A server running this API is available at https://nxapi-znca-api.fancy.org.uk/api/znca. If you would like to use this please send me a message in the [nxapi Discord server](https://discord.com/invite/4D82rFkXRv). If your project authenticates as the user's Nintendo Account you must explain that their id_token will be sent to a third-party API, and include a link to here.

Status is available at https://nxapi-status.fancy.org.uk. Usage stats are available at https://grafana.tt.fancy.org.uk/public-dashboards/442f37612eed4c4a829fd7025b07d152.

Please read the requirements for using the public API in [docs/public-api-terms.md](docs/public-api-terms.md).

See [docs/api.md](docs/api.md) for API usage details.
