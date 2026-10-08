#!/bin/sh
set -eu
label=$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.title" }}' \
  scryer-keycloak-auth-test)
if [ "$label" != 'scryer-local-oidc-test' ]; then
  echo 'Refusing to stop a container without the Scryer test label' >&2
  exit 2
fi
docker stop scryer-keycloak-auth-test >/dev/null
echo 'Stopped the Scryer Keycloak test container'
