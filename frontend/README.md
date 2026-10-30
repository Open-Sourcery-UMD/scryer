# Scryer frontend

This Next.js app provides a public introduction, an account-free **synthetic
evidence demo**, and a local `/workspace` bank-CSV preview. The sample shows
how a revised aid fact and a new school charge change a calculated
school-account surplus. Its figures and source references come from the native
C++ engine's versioned `demo` result.

The demo accepts no files and creates no account. The workspace uses the tested
browser import worker to preview a generic bank CSV in memory, with signed or
split amount columns, exact-cent candidate values, warnings, source positions,
and shortened raw-row inspection. It does not approve entries, calculate a
case, save a file, or contact the API. The worker's compiled ES modules are
staged into `public/headless/` by `predev` and `prebuild`; those generated files
are ignored by Git. A complete personal-case workspace, browser WebAssembly
validation, production authentication, and hosted sync UI remain separate
development milestones. **Use synthetic test files only in this build.**

## Local development

From the repository root:

```sh
npm --prefix client ci
npm --prefix frontend ci
npm --prefix frontend run dev
```

Open `http://localhost:3000` for the introduction, `/demo` for the sample, and
`/workspace` for the local CSV preview. `predev` and `prebuild` compile the
headless browser import modules from `client/`.
The development server requires permission to bind a local port. The release
build is static and does not need a running service:

```sh
npm --prefix frontend run lint
npm --prefix frontend run build
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

The repository root's `./setup.sh` builds this frontend as a local Compose
production image. The companion FastAPI container currently provides only
legacy health routes; the demo does not send financial facts to it.

## Keyboard and accessibility browser check

Install the existing `client/` development dependencies so `playwright-core`
is available, then point the test at an installed local Chrome binary:

```sh
npm --prefix client ci
SCRYER_BROWSER_BIN='/path/to/Chrome' npm --prefix frontend run test:demo:browser
SCRYER_BROWSER_BIN='/path/to/Chrome' npm --prefix frontend run test:workspace:browser
```

The gate builds production static pages and checks keyboard skip navigation,
evidence disclosures and links, accessibility-tree names, and 320-pixel
layout without opening a remote site. The workspace gate exercises the actual
Next.js route and import worker with synthetic CSV files, including exact
header mapping, split columns, bounded pagination, stale-request cancellation,
error diagnostics, keyboard feedback, and no-upload/no-storage checks. Both
require a Chrome executable and do not replace a human screen-reader test of
the full product.
