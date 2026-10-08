# Native JSON boundary self-review — 2026-10-04

Review type: author self-review of M3 Task 2. No independent human or second-agent review occurred.

The parser dependency is `nlohmann/json` v3.12.0 from the public release asset. Its 953436-byte header matched the release SHA-256 `aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63`; the matching MIT license is included. The build uses this vendored copy and has no network fetch.

The boundary checks raw size before allocation, bounds nesting to 64 outside quoted strings, rejects duplicate decoded keys with an object-local key set, and translates parser failures to stable codes without echoing input. A 65-level array, escaped duplicate key, malformed UTF-8, oversized document, and input-buffer lifetime were tested. Native optimized and address/undefined sanitizer runs exited 0. The 137-test Python reference suite remained green.

This boundary does not validate Scryer case fields, monetary JSON types, cross references, or event causality; those are Task 3. A 20 MiB syntactically valid document can still require substantial parser memory, so M3/M4 need measured memory behavior before claiming the 256 MiB WASM ceiling.
