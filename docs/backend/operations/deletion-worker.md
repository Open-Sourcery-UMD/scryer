# One-shot identity deletion worker

`python -m sync.deletion_runner` attempts at most one due account-deletion job. Run it as a separate, single-threaded process under an external scheduler. It must never run inside the HTTP request path. Multiple instances may run concurrently because PostgreSQL claims rows with `FOR UPDATE SKIP LOCKED` and a lease; schedule frequency and backlog alarms remain an operations/release gate.

## Required configuration

Provide these values through a private runtime secret mechanism, not command arguments or a tracked file:

| Variable | Purpose |
| --- | --- |
| `SCRYER_WORKER_DATABASE_URL` | libpq connection string for a dedicated login that inherits `scryer_worker` only |
| `SCRYER_KEYCLOAK_ISSUER` | exact issuer, such as `https://id.example/realms/scryer` |
| `SCRYER_KEYCLOAK_CLIENT_ID` | confidential service-account client ID |
| `SCRYER_KEYCLOAK_CLIENT_SECRET` | that client's secret |

The database login must not be a superuser, schema owner, security owner, application role, or `BYPASSRLS` role. The runner verifies that its *login* inherits only `scryer_worker`, has no other role memberships (including settable non-inherited memberships), no effective ciphertext-table privileges, and no superuser, `BYPASSRLS`, role-creation, database-creation, or replication attributes. Provision the login and secret outside Git. The service account needs Keycloak's `realm-management` `manage-users` client role for its **configured realm only**. Do not grant a broad realm administrator role. The adapter accepts HTTPS issuers; literal loopback HTTP is permitted only for disposable local tests. It refuses redirects, proxies, wrong issuers, and noncanonical user IDs.

One attempt has a POSIX main-thread wall-clock limit of at most 23 seconds with the runner's five-second token and admin HTTP timeouts; this remains below the SQL job's 60-second lease. SQL connections use a five-second connect timeout and bounded statement/lock timeouts. The provider code refuses execution off the main thread or under an existing process alarm. It checks the target user before deletion and again after a successful DELETE. Completion requires a separate authorized count and one complete user-list snapshot that excludes its ID, including after a successful DELETE. The proof is capped at 5,000 users and 16 MiB; a larger, truncated, changing, or slow realm stays retryable for operator review. This bounded full-list confirmation is a known scale limit and needs a more selective verified provider query before public release beyond that realm size. A DELETE `404` while the user was just observed is retried. A process crash leaves the lease for retry. Confirmed failures back off exponentially and stop after 20; operator attention is then required. The runner prints only a bounded outcome code: `idle` or `complete` exits 0; `retry`, `failed`, or `lost-lease` exits 1; configuration, role, or database failures exit 2. Do not log the environment, connection string, provider responses, JWTs, or subject IDs.

## Disposable local verification

Start the existing local PostgreSQL and Keycloak test services described in `local-postgres-tests.md` and `local-oidc-test.md`. The following command uses only synthetic identities, creates and drops a temporary database, creates a disposable Keycloak service client and user, first observes a permission failure and queued retry, grants only `manage-users`, and then observes the provider delete and anonymous SQL tombstone:

```sh
SCRYER_LOCAL_OIDC=1 SCRYER_TEST_PG_SOCKET=/path/to/private/pg/socket \
  .venv/bin/python -m unittest discover -s tests/sync -p test_keycloak_local.py -v
```

The separate fake-provider protocol tests cover redirects, bad tokens, wrong issuer/subject, missing users, and a deliberately stalled token source. The worker-role test checks that an administrator connection is refused. No test here validates a real access token to the API, backup erasure, public operations, or physical deletion from an offline browser.
