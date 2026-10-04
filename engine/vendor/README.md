# Pinned native JSON dependency

- Package: `nlohmann/json` v3.12.0 single-header distribution.
- Public release asset: `https://github.com/nlohmann/json/releases/download/v3.12.0/json.hpp`.
- Expected and verified SHA-256 of `json.hpp`: `aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63`.
- License: MIT; matching `LICENSE.MIT` came from the `v3.12.0` release tag. The header also states `SPDX-License-Identifier: MIT`.
- Build: reads vendored files only. No build-time network fetch.

The Scryer boundary wraps this library with a 20 MiB input cap, a depth cap of 64, duplicate-key rejection, and stable error codes. JSON syntax parsing alone is not Scryer case-schema validation.
