# Scryer

**Understand a student-aid money trail from the records that support it.**

An aid offer, a school-account posting, a refund notice, and a bank deposit are different events. Scryer is an open-source project for putting those records in order, explaining why an amount changed, and showing what is still unknown. It is designed to help a student ask a precise question about their own records. It does not determine aid eligibility, establish that a school owes money, or authenticate an uploaded document.

> [!WARNING]
> **Pre-alpha: use synthetic test files only.** Scryer does not yet support public accounts or real financial records. The current browser workspace previews proposed bank CSV entries; it does not approve, calculate from, save, or sync a personal case.

## Try the current app locally

You need Node.js **20.9 or newer** and npm. From the repository root:

```sh
npm --prefix client ci
npm --prefix frontend ci
npm --prefix frontend run dev
```

Open [http://localhost:3000](http://localhost:3000). The site has two paths:

| Path | What it does today |
| --- | --- |
| `/demo` | Shows a complete fictional, source-linked explanation without an account or upload. |
| `/workspace` | Parses a **synthetic** generic bank CSV in a browser worker and shows unreviewed candidate entries, warnings, source positions, and original row fields. Nothing from this preview is approved or saved. |

The CSV preview accepts signed amounts or separate credit and debit columns. Enter header names exactly as they appear in the file, including spaces. Dates use `YYYY-MM-DD`; files are limited to 20 MiB. PDFs require manual handling and are not parsed by this screen. The preview is paginated and does not send the file to Scryer's API or write it to browser storage. Its Chrome test checks those properties with synthetic data.

### What the demo explains

The fictional case starts with $6,500 in reviewed school credits and $5,000 in reviewed charges: a $1,500 school-account surplus. A $300 grant correction and a separate $300 charge change that surplus to $900. Scryer attributes the exact $600 change to those two records. A school-issued refund and an observed bank credit appear as separate pieces of evidence; neither is silently inferred from the surplus.

The demo's numbers and receipt come from the versioned native C++ engine. The receipt makes Scryer's calculation reproducible from the approved fictional facts. It does not prove that the fictional documents are authentic or complete.

## What is implemented

| Area | Local state | Important limit |
| --- | --- | --- |
| Public frontend | Landing page, synthetic case, responsive CSV proposal preview | No complete personal-case flow |
| C++20 engine | Versioned native CLI, exact-cent projection, history, matching, coverage, explanations, and receipts | Browser WebAssembly build and parity are unfinished |
| Python reference | Independent semantics, receipt checker, and synthetic scenarios | It is an oracle, not the production browser engine |
| TypeScript client | Headless import/review commands, encrypted IndexedDB, recovery, archives, and ciphertext sync components | Most components are not connected to the visible frontend |
| Sync service | FastAPI/PostgreSQL components and synthetic tenant-isolation tests | No maintained production JWT verifier or public account service |
| Docker Compose | Local frontend, PostgreSQL, and legacy API health scaffold | The Compose API is **not** the encrypted sync service |

The older `CSVParser.py`, Prisma model, and `main.py` health routes remain in the repository. They are not the authority for Scryer's new exact-money calculations or encrypted sync protocol.

## How Scryer is designed to reason

```text
Local source file
    → bounded extraction proposal
    → explicit human review
    → immutable approved event history
    → deterministic C++ calculation and evidence receipt
    → encrypted local case
    → optional ciphertext-only account sync
```

The visible `/workspace` route currently stops at **extraction proposal**. The later stages have local headless or backend implementations and synthetic tests, but they do not form a released end-to-end product yet.

These rules shape both the implementation and its tests:

- **Exact money:** the v1 domain supports USD. Money crosses language boundaries as canonical decimal strings of signed 64-bit integer cents, with checked arithmetic rather than binary floating point.
- **Review before effect:** a parser's guess never changes a financial total. The user-approved interpretation and the original proposal remain distinct.
- **Distinct stages:** offered, pending, posted, refund issued, and bank deposit observed are never collapsed into one “paid” state.
- **Traceable changes:** corrections add immutable events. An explanation identifies the reviewed facts and exact contributions behind a changed amount.
- **Honest uncertainty:** a date or amount coincidence suggests a possible match; it does not confirm one. Missing or incomplete bank coverage cannot prove nonpayment.
- **Browser plaintext boundary:** the intended sync service handles account identity, opaque ciphertext, revisions, quotas, and deletion. It does not receive source documents or decrypted financial facts.

The [case v1 JSON schema](docs/backend/contracts/case-v1.schema.json) and fixed [synthetic corpus](tests/reference/corpus/manifest.json) remain machine-readable inputs to the implementation. The machine-readable [task inventory](docs/backend/tasks.yaml) and [requirement inventory](docs/backend/requirements.yaml) describe the historical backend work; references there to former Markdown documents refer to earlier Git history, not files in this checkout.

### Privacy and security limits

Local encryption reduces what a sync server can read. It does not protect an unlocked device or a compromised browser delivery path. Server-visible metadata can include account identity, ciphertext size, timing, and traffic volume. A new device without an independent local anchor cannot always detect a server rollback. Losing every unlocked device and the recovery secret can make encrypted cases unrecoverable. Login password reset is not an encryption-key reset.

Synthetic tests exercise tamper rejection, recovery, multi-device conflicts, tenant isolation, and deletion paths. They do **not** constitute an independent security assessment or permission to process real student records.

## Run the native example and checks

The native build needs a C++20 compiler. Python 3 runs the independent reference tests.

```sh
make -C engine cli
./engine/build/scryer-native demo
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/reference -p 'test_*.py' -q
npm --prefix client run typecheck
npm --prefix client test
npm --prefix frontend run lint
npm --prefix frontend run test:demo
```

Browser checks need an installed Chrome executable. Point `SCRYER_BROWSER_BIN` to its local path:

```sh
SCRYER_BROWSER_BIN='/path/to/Chrome' npm --prefix client run test:browser
SCRYER_BROWSER_BIN='/path/to/Chrome' npm --prefix frontend run test:demo:browser
SCRYER_BROWSER_BIN='/path/to/Chrome' npm --prefix frontend run test:workspace:browser
```

The frontend test commands build optimized Next.js pages before testing. `scripts/verify-native-coverage.sh` runs the native source coverage gate with the local clang toolchain. The last recorded macOS arm64 run before this documentation consolidation measured **93.11% of source lines** and **85.84% of branches** across nine engine modules, above its 90%/85% local thresholds. A separate generated native/Python projection tier compared 10,000 synthetic cases. Those are component measurements, not a release certification or a claim of browser WebAssembly parity.

To check the local Docker configuration without starting containers, install the Docker Compose CLI; its daemon is not required for these contract tests:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/local_stack -p 'test_*.py' -q
```

## Optional Docker scaffold

With Docker Compose, Python 3, and `curl` installed, start Docker and run:

```sh
./setup.sh
```

The script creates a private `.env` with a random local PostgreSQL password on first run, builds the images, and waits for database, API-health, and frontend readiness. The database is not published on a host port; the frontend and API bind to loopback. This scaffold has **legacy health-only API routes**. It is useful for local frontend and container checks, not for hosted accounts or encrypted sync.

To stop and restart while keeping the named database volume:

```sh
docker compose down
docker compose up -d
```

Keep `.env` with its database volume. If `.env` is lost, `setup.sh` refuses to invent a replacement password for the existing volume. Do not use `docker compose down -v` when you intend to retain local data. Container builds and restart persistence still need a real Docker-daemon rehearsal before release.

## What remains before a public release

1. Connect the reviewed import, correction, encrypted local storage, recovery, and C++ semantics to a complete personal-case interface. Add supported UMD aid, bill, and refund formats with reviewed manual fallbacks.
2. Build the C++ engine for browser WebAssembly and prove native/browser/Python parity on the release corpus.
3. Add a maintained JWT verifier and real-token end-to-end account tests; finish signup, session lifecycle, conflict review, quotas, and deletion in the deployed flow.
4. Establish a funded **$0 cash** hosting and independent-backup arrangement, then test deployment, restoration, observability, and rollback.
5. Complete accessibility testing with a human screen reader, a consenting real-record pilot under approved privacy procedures, performance and longer fuzzing gates, and independent security review.

Until those gates pass, the release decision is **no-go for real records and public accounts**. The current UI and tests use fictional data only.

## Repository map

| Path | Purpose |
| --- | --- |
| `frontend/` | Next.js public site, synthetic demo, and CSV preview |
| `engine/` | C++20 native computation core and CLI |
| `scryer_reference/` | Independent Python model and receipt checker |
| `client/` | Browser import, reviewed commands, crypto, local storage, and sync transport |
| `sync/` | Encrypted-case API, PostgreSQL access, identity boundary, and deletion workers |
| `docs/backend/contracts/*.json` | Machine-readable case schema |
| `tests/` | Synthetic unit, differential, Chrome, API, and local-stack tests |

## Contributing

Use synthetic fixtures; do not commit real financial records, credentials, recovery material, or generated local state. A change to money, evidence, encryption, or account behavior should include a test that fails before the fix and a clear statement of its privacy boundary. Keep unsupported formats and incomplete evidence visible to users. Before proposing a release claim, run the relevant checks and record what was actually observed.

The detailed contracts, design decisions, security notes, and verification log that preceded this single-README layout remain in Git history at commit `02252f6`. For example, `git show 02252f6:docs/backend/contracts/engine-v1.md` reads the earlier engine contract without changing the working tree.

## Third-party code and license

Scryer is licensed under [Apache License 2.0](LICENSE). Vendored code is read locally at build time; the build does not fetch it.

| Dependency | Pinned source | License and provenance |
| --- | --- | --- |
| `nlohmann/json` 3.12.0 | `engine/vendor/json.hpp` | MIT in `engine/vendor/LICENSE.MIT`; SHA-256 `aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63` |
| PicoSHA2 1.0.1 | `engine/vendor/picosha2.h` | MIT in `engine/vendor/LICENSE.PICOSHA2`; SHA-256 `b13c180161ffac8d0adc81e033e493c409457c4d1258ab9781ac80579ba3bdd8` |
| `d3-dsv` 3.0.1 | `client/vendor/d3-dsv/src/` | ISC in `client/vendor/d3-dsv/LICENSE`; the local object-converter patch avoids dynamic code generation |
