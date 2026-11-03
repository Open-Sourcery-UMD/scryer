#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
state_dir="$project_root/.backend-artifacts/keycloak-auth-test"
image='quay.io/keycloak/keycloak:26.7.3@sha256:29be7252db0a106f1cd2ac17b9a56ff2668073da645638a38b9fc67deeb2d6c4'
name='scryer-keycloak-auth-test'
umask 077
mkdir -p "$state_dir"
chmod 700 "$state_dir"

if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo 'BLOCKED_TOOLING: pinned Keycloak image is not cached locally' >&2
  exit 2
fi
if docker container inspect "$name" >/dev/null 2>&1; then
  echo 'A Scryer Keycloak test container already exists; stop it explicitly first' >&2
  exit 2
fi

if [ ! -f "$state_dir/realm.json" ]; then
  python3 - "$state_dir" <<'PY'
import json
from pathlib import Path
import secrets
import sys

directory = Path(sys.argv[1])
admin_password = secrets.token_urlsafe(32)
users = {name: secrets.token_urlsafe(32) for name in ('student-one', 'student-two')}
(directory / 'admin.env').write_text(
    f'KC_BOOTSTRAP_ADMIN_USERNAME=scryer-local-admin\n'
    f'KC_BOOTSTRAP_ADMIN_PASSWORD={admin_password}\n')
(directory / 'users.json').write_text(json.dumps(users, separators=(',', ':')))
realm = {
    'realm': 'scryer-local-test', 'enabled': True, 'sslRequired': 'none',
    'registrationAllowed': False,
    'clients': [{
        'clientId': 'scryer-browser', 'name': 'Scryer local browser test',
        'enabled': True, 'publicClient': True, 'standardFlowEnabled': True,
        'directAccessGrantsEnabled': False, 'implicitFlowEnabled': False,
        'redirectUris': ['http://127.0.0.1:39000/callback'],
        'webOrigins': ['http://127.0.0.1:39000'],
        'attributes': {'pkce.code.challenge.method': 'S256'},
        'protocolMappers': [{
            'name': 'scryer-api-audience', 'protocol': 'openid-connect',
            'protocolMapper': 'oidc-audience-mapper', 'consentRequired': False,
            'config': {'included.custom.audience': 'scryer-api',
                       'access.token.claim': 'true', 'id.token.claim': 'false'},
        }],
    }],
    'users': [{
        'username': name, 'firstName': 'Synthetic',
        'lastName': name.split('-')[-1].title(), 'enabled': True,
        'emailVerified': True, 'email': f'{name}@example.invalid',
        'credentials': [{'type': 'password', 'value': password, 'temporary': False}],
    } for name, password in users.items()],
}
(directory / 'realm.json').write_text(json.dumps(realm, separators=(',', ':')))
print('Generated private synthetic realm and credentials')
PY
fi

for file in realm.json admin.env users.json; do
  if [ ! -f "$state_dir/$file" ]; then
    echo "Incomplete private OIDC test state: $file is missing" >&2
    exit 2
  fi
  chmod 600 "$state_dir/$file"
done

# Native Linux bind mounts preserve the host uid (the CI runner is not uid 1000).
# Keycloak must read this one mounted file; the host directory stays private at
# 0700, and unmounted admin.env/users.json stay 0600. Docker Desktop maps the uid
# and can hide this portability failure.
chmod 644 "$state_dir/realm.json"
if ! docker run --pull=never --rm --network none --entrypoint /bin/sh \
  --mount "type=bind,source=$state_dir/realm.json,target=/tmp/scryer-realm.json,readonly" \
  "$image" -c 'test -r /tmp/scryer-realm.json'; then
  echo 'The nonroot Keycloak image cannot read its synthetic realm mount' >&2
  exit 2
fi

docker run --pull=never --rm -d --name "$name" \
  --label org.opencontainers.image.title=scryer-local-oidc-test \
  --label "org.scryer.test-run-id=${SCRYER_TEST_RUN_ID:-manual}" \
  --publish 127.0.0.1:8081:8080 \
  --env-file "$state_dir/admin.env" \
  --mount "type=bind,source=$state_dir/realm.json,target=/opt/keycloak/data/import/realm.json,readonly" \
  "$image" start-dev --db=dev-mem --import-realm \
  --hostname=http://127.0.0.1:8081 --health-enabled=true >/dev/null

python3 - <<'PY'
import time
from urllib.request import urlopen

url = 'http://127.0.0.1:8081/realms/scryer-local-test/.well-known/openid-configuration'
for _ in range(60):
    try:
        with urlopen(url, timeout=2) as response:
            if response.status == 200:
                print('Local Keycloak test realm is ready on 127.0.0.1:8081')
                break
    except (OSError, TimeoutError):
        time.sleep(1)
else:
    raise SystemExit('Keycloak did not become ready; inspect only this test container')
PY
