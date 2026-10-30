# Scryer frontend

This Next.js app currently provides a public introduction and an account-free
**synthetic evidence demo**. The sample shows how a revised aid fact and a new
school charge change a calculated school-account surplus. Its figures and
source references come from the native C++ engine's versioned `demo` result.

The sample accepts no uploads and creates no account. The personal-case
workspace, WebAssembly engine, production authentication, and hosted sync UI
remain separate development milestones. Do not use this demo as evidence that
Scryer is ready for real financial records.

## Local development

From `frontend/`:

```sh
npm ci
npm run dev
```

Open `http://localhost:3000` for the introduction and `/demo` for the sample.
The development server requires permission to bind a local port. The release
build is static and does not need a running service:

```sh
npm run lint
npm run build
```

The build uses Next.js's Webpack mode because the default Turbopack build
tries to bind a helper port in the restricted local test environment.

## Reproduce the sample

The demo snapshot is generated from `engine/build/scryer-native`, with the
fictional source case defined in `tests/reference/fixtures/golden-case.json`.
From the repository root:

```sh
make -C engine cli
node scripts/generate-demo-snapshot.mjs --check
npm --prefix frontend run test:demo
```

To intentionally refresh the snapshot after a reviewed engine change, run
`node scripts/generate-demo-snapshot.mjs`, then inspect the resulting diff and
rerun `npm --prefix frontend run test:demo`. Exact money formatting uses
decimal minor-unit strings and `BigInt`; it never passes financial amounts
through JavaScript floating point.

The receipt demonstrates internal reproducibility. It does not authenticate
the fictional source files or establish that a school owes money.

## Keyboard and accessibility browser check

Install the existing `client/` development dependencies so `playwright-core`
is available, then point the test at an installed local Chrome binary:

```sh
npm --prefix client ci
SCRYER_BROWSER_BIN='/path/to/Chrome' npm --prefix frontend run test:demo:browser
```

The gate builds production static pages and checks keyboard skip navigation,
evidence disclosures and links, accessibility-tree names, and 320-pixel
layout without opening a remote site. It requires a Chrome executable and
does not replace a human screen-reader test of the full product.
