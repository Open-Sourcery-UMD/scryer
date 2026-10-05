# Local synthetic OIDC test

The pinned `quay.io/keycloak/keycloak:26.7.3` image must already be cached. These commands do not pull it or contact a Git remote:

```sh
scripts/start-local-keycloak-test.sh
SCRYER_LOCAL_OIDC=1 SCRYER_BROWSER_BIN=/path/to/local/Chrome node --test tests/sync/test_oidc_local.mjs
scripts/stop-local-keycloak-test.sh
```

The start script creates two deliberately invalid `@example.invalid` synthetic users and random passwords in ignored `.backend-artifacts/keycloak-auth-test/` with private file permissions. It binds Keycloak to `127.0.0.1:8081`, imports a browser client limited to the local callback, and requires authorization code with PKCE S256. The test uses real Chrome and Keycloak to obtain two distinct identities, confirms the access-token API audience and provider userinfo, and proves a wrong PKCE verifier is rejected. It never prints credentials or tokens. The test realm uses Keycloak's in-memory development database and is recreated on restart; it is not a deployable identity configuration or a data-retention test.

The test decodes JWT fields only to inspect the provider configuration. It does **not** cryptographically verify those fields as the Scryer API. The required maintained JWT verifier and real token-to-API integration remain blocked by the permission-controlled public dependency download rejected by automatic approval review. No API production entrypoint accepts these tokens yet.
