# Scryer

Scryer is an open-source project for explaining a student's financial-aid money trail from an offer through school-account postings, a refund notice, and an observed bank credit. The goal is to show what each record supports, why an expected amount changed, and what remains unknown. Scryer does not determine aid eligibility or whether a school owes money.

## Current status

**Pre-alpha, local synthetic development only.** The public frontend has an [account-free synthetic case](frontend/README.md) that explains a $1,500 to $900 school-account change using reviewed fictional records. The C++20 engine and independent Python reference model implement exact calculations and evidence receipts. The TypeScript client contains reviewed import, encrypted local storage, recovery, and ciphertext sync components under local tests. Browser WebAssembly validation, production authentication, full personal-case screens, validated real UMD formats, and public operation remain unfinished. Do not enter real financial records into this build.

The repository's three-container Compose stack is a **local development scaffold**. Its FastAPI entrypoint currently has health routes only; it is not the encrypted sync API. Its PostgreSQL instance is private to the Compose network. The frontend shows the synthetic demo and does not connect to the database.

## Start the local scaffold

Install Docker with Compose and `curl`. From the repository root, run:

```sh
./setup.sh
```

On first run, the script creates a private `.env` file with a random database password. It checks the Compose configuration, builds the images, starts the services, then requires a successful PostgreSQL `SELECT 1`, API health response, and frontend response. It prints the local frontend URL when those checks pass.

The frontend is at <http://127.0.0.1:3000> and the local API health route is at <http://127.0.0.1:8000/health>. Set `API_PORT` in `.env` before starting if port 8000 is occupied. The frontend image runs an optimized Next.js build and `next start`.

To stop and later restart the services while retaining the named PostgreSQL volume:

```sh
docker compose down
docker compose up -d
```

Do not use `docker compose down -v` if you want to retain the local database. For a direct local query, run `docker compose exec postgres psql -U scryer -d scryer -c 'SELECT 1'`.

## Work on the components

- Frontend: see [frontend/README.md](frontend/README.md) for the static demo, build, and browser checks.
- Native engine: `make -C engine cli` and `scripts/verify-native-coverage.sh`.
- Python reference: `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/reference -p 'test_*.py' -q`.
- Headless client: `npm --prefix client ci` then `npm --prefix client test`.
- Local stack contract: `python3 -m unittest discover -s tests/local_stack -p 'test_*.py' -v` (requires the Docker Compose CLI, not its daemon).

The active architecture, limitations, and observed verification are in [docs/backend/](docs/backend/). Contributions should use synthetic fixtures and preserve the rule that financial plaintext stays in the browser, never in the ciphertext sync service.
