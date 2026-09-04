#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

fail() {
  printf 'AUDIT_FAILED: %s\n' "$1" >&2
  exit 1
}

[[ "${AUDIT_EXPECTED_SCRIPT_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] \
  || fail 'expected script digest is invalid'
[[ "${#AUDIT_OPERATION_ID}" -ge 8 && "${#AUDIT_OPERATION_ID}" -le 64 ]] \
  && [[ "${AUDIT_OPERATION_ID}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] \
  || fail 'operation ID is invalid'
actual_script_sha256="$(sha256sum -- "$0" | awk '{print $1}')"
[[ "${actual_script_sha256}" == "${AUDIT_EXPECTED_SCRIPT_SHA256}" ]] \
  || fail 'script digest mismatch'

app_root="${HOME}/alimtalk-proxy"
runtime_env="${app_root}/.env"
lock_path="${app_root}/.tonghari-api-production.lock"
gis_registry_dir="${app_root}/.gis-mcp-secrets"
gis_registry_file="${gis_registry_dir}/clients.json"
gis_marker="${app_root}/.gis-mcp-file-registry-v1"
caddyfile="/opt/caddy/Caddyfile"
caddy_env="/opt/caddy/legal-mcp-proxy.env"

[[ -d "${app_root}" && ! -L "${app_root}" \
  && "$(realpath -e -- "${app_root}")" == "${app_root}" ]] \
  || fail 'application directory contract is invalid'
check_deploy_lock() {
  [[ -f "${lock_path}" && ! -L "${lock_path}" \
    && "$(stat -c '%u:%a' "${lock_path}")" == "$(id -u):600" ]] \
    || fail 'production lock contract is invalid'
}
check_deploy_lock
exec 9>>"${lock_path}"
flock -w 60 9 || fail 'production lock acquisition timed out'
check_deploy_lock
[[ "$(stat -Lc '%d:%i' "/proc/$$/fd/9")" == "$(stat -c '%d:%i' "${lock_path}")" ]] \
  || fail 'production lock changed while acquired'

[[ -f "${runtime_env}" && ! -L "${runtime_env}" \
  && "$(stat -c '%u:%a' "${runtime_env}")" == "$(id -u):600" ]] \
  || fail 'runtime env contract is invalid'

definition_count() {
  local key="$1"
  grep -Ec "^[[:space:]]*${key}[[:space:]]*=" "${runtime_env}" || true
}

nonempty_count() {
  local key="$1"
  grep -Ec "^[[:space:]]*${key}[[:space:]]*=.+$" "${runtime_env}" || true
}

single_nonempty_state() {
  local key="$1"
  local definitions nonempty
  definitions="$(definition_count "${key}")"
  nonempty="$(nonempty_count "${key}")"
  if [[ "${definitions}" == "1" && "${nonempty}" == "1" ]]; then
    printf 'present'
  elif [[ "${definitions}" == "0" ]]; then
    printf 'missing'
  else
    printf 'invalid'
  fi
}

vworld_key_state="$(single_nonempty_state VWORLD_API_KEY)"
vworld_domain_state="$(single_nonempty_state VWORLD_API_DOMAIN)"
data_portal_key_state="$(single_nonempty_state DATA_PORTAL_API_KEY)"

if [[ "${vworld_domain_state}" == "present" ]]; then
  vworld_domain="$(
    sed -n 's/^[[:space:]]*VWORLD_API_DOMAIN[[:space:]]*=//p' "${runtime_env}"
  )"
  if [[ "${vworld_domain}" == '*' || "${vworld_domain}" =~ [[:space:]/?#@] \
    || "${vworld_domain}" == *://* || "${vworld_domain}" == *:* \
    || ! "${vworld_domain}" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
    vworld_domain_state=invalid
  fi
  unset vworld_domain
fi

candidate_configuration_state=invalid
running_image=""
if docker container inspect alimtalk-proxy >/dev/null 2>&1 \
  && [[ "$(docker container inspect --format '{{.State.Running}}' alimtalk-proxy)" == true ]]; then
  running_image="$(docker container inspect --format '{{.Image}}' alimtalk-proxy)"
  if [[ "${running_image}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    candidate_configuration_state="$(
      docker run --rm \
        --network none --read-only --cap-drop ALL \
        --security-opt no-new-privileges \
        --env-file "${runtime_env}" \
        -e GIS_MCP_TOKEN_REGISTRY_FILE= \
        -e GIS_MCP_TOKEN_SHA256= \
        -e 'GIS_MCP_TOKEN_REGISTRY_JSON={"version":1,"clients":[{"clientId":"activation-audit","tokenSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}' \
        -e GIS_MCP_PROXY_TOKEN_SHA256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
        -e GIS_MCP_ALLOWED_HOSTS=api.tonghari.kr \
        "${running_image}" \
        node -e '
          const { getGisMcpConfigurationStateV1 } = require("./dist/services/public-data-mcp/mcp-config");
          const { normalizeDataPortalApiKey } = require("./dist/utils/data-portal-api-key");
          const strictInteger = (name, fallback) => {
            const raw = process.env[name];
            if (raw === undefined || raw.trim() === "") return fallback;
            const normalized = raw.trim();
            if (!/^-?\d+$/.test(normalized)) return Number.NaN;
            const parsed = Number(normalized);
            return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
          };
          const state = getGisMcpConfigurationStateV1({
            vworldApiKey: process.env.VWORLD_API_KEY || "",
            vworldApiDomain: process.env.VWORLD_API_DOMAIN || process.env.VWORLD_DOMAIN || "www.tonghari.kr",
            dataPortalApiKey: normalizeDataPortalApiKey(process.env.DATA_PORTAL_API_KEY),
            tokenSha256: process.env.GIS_MCP_TOKEN_SHA256 || "",
            tokenRegistryJson: process.env.GIS_MCP_TOKEN_REGISTRY_JSON || "",
            tokenRegistryFile: process.env.GIS_MCP_TOKEN_REGISTRY_FILE || "",
            proxyTokenSha256: process.env.GIS_MCP_PROXY_TOKEN_SHA256 || "",
            allowedHosts: process.env.GIS_MCP_ALLOWED_HOSTS || "",
            allowedOrigins: process.env.GIS_MCP_ALLOWED_ORIGINS || "",
            requestsPerMinute: strictInteger("GIS_MCP_REQUESTS_PER_MINUTE", 20),
            globalRequestsPerMinute: strictInteger("GIS_MCP_GLOBAL_REQUESTS_PER_MINUTE", 40),
            requestDeadlineMs: strictInteger("GIS_MCP_REQUEST_DEADLINE_MS", 45000),
            maxConcurrency: strictInteger("GIS_MCP_MAX_CONCURRENCY", 2),
            maxQueue: strictInteger("GIS_MCP_MAX_QUEUE", 4),
          });
          process.stdout.write(state.configured ? "valid" : "invalid");
        ' 2>/dev/null
    )"
  fi
fi

gis_file_definitions="$(definition_count GIS_MCP_TOKEN_REGISTRY_FILE)"
gis_json_definitions="$(definition_count GIS_MCP_TOKEN_REGISTRY_JSON)"
gis_legacy_definitions="$(definition_count GIS_MCP_TOKEN_SHA256)"
gis_proxy_definitions="$(definition_count GIS_MCP_PROXY_TOKEN_SHA256)"
gis_hosts_definitions="$(definition_count GIS_MCP_ALLOWED_HOSTS)"
if [[ "${gis_file_definitions}" == "0" && "${gis_json_definitions}" == "0" \
  && "${gis_legacy_definitions}" == "0" ]]; then
  gis_auth_state=disabled
else
  gis_auth_state=configured-or-partial
fi
if [[ "${gis_proxy_definitions}" == "0" ]]; then
  gis_proxy_state=missing
else
  gis_proxy_state=configured-or-partial
fi
if [[ "${gis_hosts_definitions}" == "0" ]]; then
  gis_hosts_state=missing
else
  gis_hosts_state=configured-or-partial
fi

gis_marker_state=absent
if [[ -e "${gis_marker}" || -L "${gis_marker}" ]]; then
  gis_marker_state=present-or-invalid
fi
gis_registry_state=absent
if [[ -e "${gis_registry_dir}" || -L "${gis_registry_dir}" \
  || -e "${gis_registry_file}" || -L "${gis_registry_file}" ]]; then
  gis_registry_state=present-or-invalid
fi

runtime_state=unavailable
api_port_binding_state=unavailable
if docker container inspect alimtalk-proxy >/dev/null 2>&1 \
  && [[ "$(docker container inspect --format '{{.State.Running}}' alimtalk-proxy)" == true ]]; then
  api_port_binding="$(
    docker container inspect --format \
      '{{with (index .HostConfig.PortBindings "3100/tcp")}}{{range .}}{{.HostIp}}|{{.HostPort}}{{println}}{{end}}{{end}}' \
      alimtalk-proxy
  )"
  if [[ "${api_port_binding}" == '127.0.0.1|3100' ]]; then
    api_port_binding_state=loopback-only
  else
    api_port_binding_state=unexpected
  fi
  if curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:3100/health \
    | docker exec -i alimtalk-proxy node -e '
      let body = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => { body += chunk; });
      process.stdin.on("end", () => {
        try {
          const health = JSON.parse(body);
          const f = health.features || {};
          const disabled = f.gisMcpConfigurationValid === false
            && f.gisMcpAuthMode === "disabled"
            && f.gisMcpAuthSource === "disabled"
            && f.gisMcpRegisteredClientCount === 0
            && f.gisMcpRegisteredTokenCount === 0
            && f.gisMcpProviderMode === "disabled";
          process.exit(disabled ? 0 : 1);
        } catch {
          process.exit(1);
        }
      });
    ' >/dev/null 2>&1; then
    runtime_state=disabled-zero
  else
    runtime_state=unexpected
  fi
fi

sudo_state=unavailable
caddyfile_state=unavailable
caddyfile_sha256=unavailable
caddy_env_state=unavailable
caddy_container_state=unavailable
legal_proxy_pair_state=unavailable
legal_proxy_route_state=unavailable
if sudo -n true >/dev/null 2>&1; then
  sudo_state=available
  if sudo -n test -f "${caddyfile}" \
    && ! sudo -n test -L "${caddyfile}" \
    && [[ "$(sudo -n stat -c '%U:%G:%a' "${caddyfile}")" =~ ^root:root:(600|640|644)$ ]] \
    && sudo -n test -d /opt/caddy \
    && ! sudo -n test -L /opt/caddy \
    && [[ "$(sudo -n stat -c '%U:%G:%a' /opt/caddy)" =~ ^root:root:(700|750|755)$ ]]; then
    caddyfile_sha256="$(sudo -n sha256sum -- "${caddyfile}" | awk '{print $1}')"
    normalized_caddyfile="$(
      sudo -n sed -E \
        -e '/^[[:space:]]*(#.*)?$/d' \
        -e 's/^[[:space:]]+//' \
        -e 's/[[:space:]]+$//' \
        "${caddyfile}"
    )"
    expected_legal_caddyfile="$(printf '%s\n' \
      'api.tonghari.kr {' \
      '@legal_mcp path /mcp' \
      'handle @legal_mcp {' \
      'reverse_proxy 127.0.0.1:3100 {' \
      'header_up X-Forwarded-Proto https' \
      'header_up X-Tonghari-MCP-Proxy-Token {$LEGAL_MCP_PROXY_TOKEN}' \
      '}' \
      '}' \
      'handle {' \
      'reverse_proxy 127.0.0.1:3100' \
      '}' \
      'encode gzip' \
      '}')"
    expected_gis_caddyfile="$(printf '%s\n' \
      'api.tonghari.kr {' \
      '@legal_mcp path /mcp' \
      'handle @legal_mcp {' \
      'reverse_proxy 127.0.0.1:3100 {' \
      'header_up X-Forwarded-Proto https' \
      'header_up X-Tonghari-MCP-Proxy-Token {$LEGAL_MCP_PROXY_TOKEN}' \
      '}' \
      '}' \
      '@gis_mcp path /gis-mcp' \
      'handle @gis_mcp {' \
      'reverse_proxy 127.0.0.1:3100 {' \
      'header_up X-Forwarded-Proto https' \
      'header_up X-Tonghari-GIS-MCP-Proxy-Token {$GIS_MCP_PROXY_TOKEN}' \
      '}' \
      '}' \
      'handle {' \
      'reverse_proxy 127.0.0.1:3100' \
      '}' \
      'encode gzip' \
      '}')"
    if [[ "${normalized_caddyfile}" == "${expected_legal_caddyfile}" ]]; then
      caddyfile_state=supported-legal-only
    elif [[ "${normalized_caddyfile}" == "${expected_gis_caddyfile}" ]]; then
      caddyfile_state=supported-with-gis
    else
      caddyfile_state=unsupported
    fi
    unset normalized_caddyfile expected_legal_caddyfile expected_gis_caddyfile
  fi

  if sudo -n test -f "${caddy_env}" \
    && ! sudo -n test -L "${caddy_env}" \
    && [[ "$(sudo -n stat -c '%U:%G:%a' "${caddy_env}")" == root:root:600 ]]; then
    legal_proxy_definitions="$(sudo -n grep -Ec '^LEGAL_MCP_PROXY_TOKEN=' "${caddy_env}" || true)"
    legal_proxy_nonempty="$(sudo -n grep -Ec '^LEGAL_MCP_PROXY_TOKEN=.+$' "${caddy_env}" || true)"
    gis_proxy_definitions="$(sudo -n grep -Ec '^GIS_MCP_PROXY_TOKEN=' "${caddy_env}" || true)"
    gis_proxy_nonempty="$(sudo -n grep -Ec '^GIS_MCP_PROXY_TOKEN=.+$' "${caddy_env}" || true)"
    all_definitions="$(sudo -n grep -Ec '^[A-Z0-9_]+=' "${caddy_env}" || true)"
    invalid_lines="$(sudo -n grep -Evc '^[[:space:]]*(#.*)?$|^[A-Z0-9_]+=.*$' "${caddy_env}" || true)"
    if [[ "${legal_proxy_definitions}" == "1" && "${legal_proxy_nonempty}" == "1" \
      && "${gis_proxy_definitions}" == "0" && "${gis_proxy_nonempty}" == "0" \
      && "${all_definitions}" == "1" && "${invalid_lines}" == "0" ]]; then
      caddy_env_state=supported-legal-only
    elif [[ "${legal_proxy_definitions}" == "1" && "${legal_proxy_nonempty}" == "1" \
      && "${gis_proxy_definitions}" == "1" && "${gis_proxy_nonempty}" == "1" \
      && "${all_definitions}" == "2" && "${invalid_lines}" == "0" ]]; then
      caddy_env_state=supported-with-gis
    else
      caddy_env_state=unsupported
    fi

    if [[ "$(definition_count LEGAL_MCP_PROXY_TOKEN_SHA256)" == "1" \
      && "$(nonempty_count LEGAL_MCP_PROXY_TOKEN_SHA256)" == "1" ]] \
      && sudo -n env RUNTIME_ENV="${runtime_env}" CADDY_ENV="${caddy_env}" bash -eu -c '
        expected="$(sed -n "s/^[[:space:]]*LEGAL_MCP_PROXY_TOKEN_SHA256[[:space:]]*=//p" "${RUNTIME_ENV}")"
        raw="$(sed -n "s/^LEGAL_MCP_PROXY_TOKEN=//p" "${CADDY_ENV}")"
        [[ "${expected}" =~ ^[0-9a-fA-F]{64}$ && -n "${raw}" ]]
        actual="$(printf %s "${raw}" | sha256sum | awk "{print \$1}")"
        [[ "${actual}" == "${expected,,}" ]]
      ' >/dev/null 2>&1; then
      legal_proxy_pair_state=matched
    else
      legal_proxy_pair_state=mismatched
    fi
  fi

  if docker container inspect caddy >/dev/null 2>&1; then
    caddy_running="$(docker container inspect --format '{{.State.Running}}' caddy)"
    caddy_network="$(docker container inspect --format '{{.HostConfig.NetworkMode}}' caddy)"
    caddy_restart="$(docker container inspect --format '{{.HostConfig.RestartPolicy.Name}}' caddy)"
    caddy_config_mount="$(
      docker container inspect --format \
        '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Type}}|{{.RW}}|{{.Source}}{{println}}{{end}}{{end}}' \
        caddy
    )"
    caddy_data_mount="$(
      docker container inspect --format \
        '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}}|{{.RW}}|{{.Name}}{{println}}{{end}}{{end}}' \
        caddy
    )"
    caddy_config_volume="$(
      docker container inspect --format \
        '{{range .Mounts}}{{if eq .Destination "/config"}}{{.Type}}|{{.RW}}|{{.Name}}{{println}}{{end}}{{end}}' \
        caddy
    )"
    caddy_image_id="$(docker container inspect --format '{{.Image}}' caddy)"
    if [[ "${caddy_running}" == true && "${caddy_network}" == host \
      && "${caddy_restart}" == unless-stopped \
      && "${caddy_image_id}" =~ ^sha256:[0-9a-f]{64}$ \
      && "${caddy_config_mount}" == "bind|false|${caddyfile}" \
      && "${caddy_data_mount}" == 'volume|true|caddy_data' \
      && "${caddy_config_volume}" == 'volume|true|caddy_config' ]]; then
      if sudo -n docker run --rm \
        --network none --read-only --cap-drop ALL \
        --security-opt no-new-privileges \
        -e LEGAL_MCP_PROXY_TOKEN=activation-audit-placeholder-legal \
        -e GIS_MCP_PROXY_TOKEN=activation-audit-placeholder-gis \
        -v "${caddyfile}:/etc/caddy/Caddyfile:ro" \
        "${caddy_image_id}" caddy validate \
          --config /etc/caddy/Caddyfile --adapter caddyfile \
          >/dev/null 2>&1; then
        caddy_container_state=supported
      else
        caddy_container_state=invalid-config
      fi
    else
      caddy_container_state=unsupported
    fi
  fi
fi

public_legal_status="$(
  curl -sS -o /dev/null --connect-timeout 3 --max-time 10 \
    -w '%{http_code}' -X POST https://api.tonghari.kr/mcp || true
)"
loopback_legal_status="$(
  curl -sS -o /dev/null --connect-timeout 2 --max-time 5 \
    -w '%{http_code}' -X POST -H 'Host: api.tonghari.kr' \
    http://127.0.0.1:3100/mcp || true
)"
if [[ "${public_legal_status}" == 401 && "${loopback_legal_status}" == 403 ]]; then
  legal_proxy_route_state=verified
else
  legal_proxy_route_state=unexpected
fi

stage_ready=false
if [[ "${vworld_key_state}" == present && "${vworld_domain_state}" == present \
  && "${data_portal_key_state}" == present && "${candidate_configuration_state}" == valid \
  && "${gis_auth_state}" == disabled \
  && "${gis_proxy_state}" == missing && "${gis_hosts_state}" == missing \
  && "${gis_marker_state}" == absent && "${gis_registry_state}" == absent \
  && "${runtime_state}" == disabled-zero && "${api_port_binding_state}" == loopback-only \
  && "${sudo_state}" == available \
  && "${caddyfile_state}" == supported-legal-only \
  && "${caddy_env_state}" == supported-legal-only \
  && "${caddy_container_state}" == supported \
  && "${legal_proxy_pair_state}" == matched \
  && "${legal_proxy_route_state}" == verified ]]; then
  stage_ready=true
fi

printf 'auditVersion=1\n'
printf 'operationId=%s\n' "${AUDIT_OPERATION_ID}"
printf 'vworldApiKey=%s\n' "${vworld_key_state}"
printf 'vworldApiDomain=%s\n' "${vworld_domain_state}"
printf 'dataPortalApiKey=%s\n' "${data_portal_key_state}"
printf 'candidateConfiguration=%s\n' "${candidate_configuration_state}"
printf 'gisAuth=%s\n' "${gis_auth_state}"
printf 'gisProxyDigest=%s\n' "${gis_proxy_state}"
printf 'gisAllowedHosts=%s\n' "${gis_hosts_state}"
printf 'gisMarker=%s\n' "${gis_marker_state}"
printf 'gisRegistry=%s\n' "${gis_registry_state}"
printf 'runtime=%s\n' "${runtime_state}"
printf 'apiPortBinding=%s\n' "${api_port_binding_state}"
printf 'sudo=%s\n' "${sudo_state}"
printf 'caddyfile=%s\n' "${caddyfile_state}"
printf 'caddyfileSha256=%s\n' "${caddyfile_sha256}"
printf 'caddyEnv=%s\n' "${caddy_env_state}"
printf 'caddyContainer=%s\n' "${caddy_container_state}"
printf 'legalProxyPair=%s\n' "${legal_proxy_pair_state}"
printf 'legalProxyRoute=%s\n' "${legal_proxy_route_state}"
printf 'stageReady=%s\n' "${stage_ready}"
[[ "${stage_ready}" == true ]] || exit 64
