# Pinned native JSON dependency

- Package: `nlohmann/json` v3.12.0 single-header distribution.
- Public release asset: `https://github.com/nlohmann/json/releases/download/v3.12.0/json.hpp`.
- Expected and verified SHA-256 of `json.hpp`: `aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63`.
- License: MIT; matching `LICENSE.MIT` came from the `v3.12.0` release tag. The header also states `SPDX-License-Identifier: MIT`.
- Build: reads vendored files only. No build-time network fetch.

The Scryer boundary wraps this library with a 20 MiB input cap, a depth cap of 64, duplicate-key rejection, and stable error codes. JSON syntax parsing alone is not Scryer case-schema validation.

## Pinned native SHA-256 dependency

- Package: [PicoSHA2](https://github.com/okdshin/PicoSHA2) v1.0.1 single header.
- Source: `https://raw.githubusercontent.com/okdshin/PicoSHA2/v1.0.1/picosha2.h`.
- Verified SHA-256 of `picosha2.h`: `b13c180161ffac8d0adc81e033e493c409457c4d1258ab9781ac80579ba3bdd8`.
- License: MIT; `LICENSE.PICOSHA2` came from the same v1.0.1 tag. The full MIT grant is also embedded in the header.
- Build: reads vendored files only; the two standard SHA-256 vectors for empty input and `abc` are executable receipt tests.
