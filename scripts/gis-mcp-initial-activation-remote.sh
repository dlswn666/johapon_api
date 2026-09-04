#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

EX_TEMPFAIL=75

fail() {
  printf 'ACTIVATION_FAILED: %s\n' "$1" >&2
  exit 1
}

tempfail() {
  printf 'COMMIT_STATE_UNKNOWN: %s\n' "$1" >&2
  exit "${EX_TEMPFAIL}"
}

[[ "${ACTIVATION_OPERATION:-}" =~ ^(prepare|status|publish|rollback|recover)$ ]] \
  || fail 'operation is invalid'
[[ "${#ACTIVATION_ID}" -ge 8 && "${#ACTIVATION_ID}" -le 64 \
  && "${ACTIVATION_ID}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] \
  || fail 'activation ID is invalid'
[[ "${#ACTIVATION_CLIENT_ID}" -le 64 \
  && "${ACTIVATION_CLIENT_ID}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] \
  || fail 'client ID is invalid'
[[ "${ACTIVATION_TOKEN_COMMITMENT:-}" =~ ^[0-9a-f]{64}$ ]] \
  || fail 'token commitment is invalid'
[[ "${ACTIVATION_EXPECTED_CADDYFILE_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] \
  || fail 'expected Caddyfile digest is invalid'
[[ "${ACTIVATION_EXPECTED_SCRIPT_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] \
  || fail 'expected script digest is invalid'
[[ "${ACTIVATION_GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]] \
  || fail 'GitHub revision is invalid'

actual_script_sha256="$(sha256sum -- "$0" | awk '{print $1}')"
[[ "${actual_script_sha256}" == "${ACTIVATION_EXPECTED_SCRIPT_SHA256}" ]] \
  || fail 'script digest mismatch'

app_root="${HOME}/alimtalk-proxy"
runtime_env="${app_root}/.env"
lock_path="${app_root}/.tonghari-api-production.lock"
prepared_path="${app_root}/.gis-mcp-initial-activation-prepared-v1"
deployment_receipts_dir="${app_root}/.gis-mcp-initial-activation-receipts"
deployment_receipt="${deployment_receipts_dir}/${ACTIVATION_ID}"
state_path="${app_root}/.gis-mcp-initial-activation-state-v1"
unknown_path="${app_root}/.gis-mcp-initial-activation-commit-unknown"
operator_receipts_dir="${app_root}/.gis-mcp-initial-activation-operation-receipts"
prepare_receipt="${operator_receipts_dir}/${ACTIVATION_ID}.prepare"
publish_receipt="${operator_receipts_dir}/${ACTIVATION_ID}.publish"
rollback_receipt="${operator_receipts_dir}/${ACTIVATION_ID}.rollback"
recover_receipt="${operator_receipts_dir}/${ACTIVATION_ID}.recover"
env_backup="${app_root}/.env.gis-mcp-activation-backup.${ACTIVATION_ID}"
gis_registry_dir="${app_root}/.gis-mcp-secrets"
gis_registry_file="${gis_registry_dir}/clients.json"
gis_registry_container_file="/run/secrets/tonghari-gis-mcp/clients.json"
gis_marker="${app_root}/.gis-mcp-file-registry-v1"
caddy_root="/opt/caddy"
caddyfile="${caddy_root}/Caddyfile"
caddy_env="${caddy_root}/legal-mcp-proxy.env"
caddy_stage_parent="${caddy_root}/.gis-mcp-initial-activation"
caddy_stage="${caddy_stage_parent}/${ACTIVATION_ID}"

[[ -d "${app_root}" && ! -L "${app_root}" \
  && "$(realpath -e -- "${app_root}")" == "${app_root}" ]] \
  || fail 'application directory contract is invalid'

check_user_file() {
  local path="$1"
  [[ -f "${path}" && ! -L "${path}" \
    && "$(stat -c '%u:%a' "${path}")" == "$(id -u):600" ]]
}

check_user_dir() {
  local path="$1"
  [[ -d "${path}" && ! -L "${path}" \
    && "$(stat -c '%u:%a' "${path}")" == "$(id -u):700" ]]
}

ensure_user_dir() {
  local path="$1"
  if [[ ! -e "${path}" && ! -L "${path}" ]]; then
    mkdir -m 700 -- "${path}"
  fi
  check_user_dir "${path}" || fail "directory contract is invalid: ${path##*/}"
}

activation_temp_files() {
  local -a paths=()
  shopt -s nullglob
  paths=(
    "${app_root}"/.env.gis-mcp-backup.next.*
    "${app_root}"/.env.gis-mcp-activation.next.*
    "${app_root}"/.env.restore.*
  )
  shopt -u nullglob
  if [[ "${#paths[@]}" -gt 0 ]]; then
    printf '%s\n' "${paths[@]}"
  fi
}

activation_temp_files_absent() {
  [[ -z "$(activation_temp_files)" ]]
}

cleanup_activation_temp_files() {
  local path name
  local -a paths=()
  mapfile -t paths < <(activation_temp_files)
  for path in "${paths[@]}"; do
    name="${path##*/}"
    [[ "${name}" =~ ^\.env\.(gis-mcp-(backup|activation)\.next|restore)\.[A-Za-z0-9]{6}$ \
      && -f "${path}" && ! -L "${path}" \
      && "$(stat -c '%u:%a' "${path}")" == "$(id -u):600" ]] \
      || return 1
  done
  if [[ "${#paths[@]}" -gt 0 ]]; then
    rm -f -- "${paths[@]}" || return 1
    sync -f "${app_root}" || return 1
  fi
}

atomic_write_lines() {
  local path="$1"
  shift
  local parent temp
  parent="$(dirname -- "${path}")"
  temp="$(mktemp "${parent}/.$(basename -- "${path}").next.XXXXXX")"
  chmod 600 "${temp}"
  printf '%s\n' "$@" > "${temp}"
  sync -f "${temp}"
  mv -f -- "${temp}" "${path}"
  sync -f "${parent}"
}

validate_binding_file() {
  local path="$1"
  local expected_runtime_sha="${2:-}"
  local expected_git_sha="${3:-}"
  local -a lines=()
  check_user_file "${path}" || return 1
  mapfile -t lines < "${path}"
  [[ "${#lines[@]}" -eq 6 \
    && "${lines[0]}" == 'version=1' \
    && "${lines[1]}" == "activationId=${ACTIVATION_ID}" \
    && "${lines[2]}" == "clientId=${ACTIVATION_CLIENT_ID}" \
    && "${lines[3]}" =~ ^gitSha=[0-9a-f]{40}$ \
    && "${lines[4]}" =~ ^runtimeEnvSha256=[0-9a-f]{64}$ \
    && "${lines[5]}" == "tokenCommitment=${ACTIVATION_TOKEN_COMMITMENT}" ]] \
    || return 1
  binding_runtime_sha="${lines[4]#runtimeEnvSha256=}"
  binding_git_sha="${lines[3]#gitSha=}"
  [[ ( -z "${expected_runtime_sha}" || "${binding_runtime_sha}" == "${expected_runtime_sha}" ) \
    && ( -z "${expected_git_sha}" || "${binding_git_sha}" == "${expected_git_sha}" ) ]]
}

validate_deployment_receipt() {
  local expected_runtime_sha="${1:-}"
  local expected_git_sha="${2:-}"
  check_user_dir "${deployment_receipts_dir}" \
    && validate_binding_file "${deployment_receipt}" \
      "${expected_runtime_sha}" "${expected_git_sha}"
}

write_binding_file() {
  local path="$1"
  local runtime_sha="$2"
  [[ "${runtime_sha}" =~ ^[0-9a-f]{64}$ ]] || fail 'binding runtime env digest is invalid'
  atomic_write_lines "${path}" \
    'version=1' \
    "activationId=${ACTIVATION_ID}" \
    "clientId=${ACTIVATION_CLIENT_ID}" \
    "gitSha=${ACTIVATION_GITHUB_SHA}" \
    "runtimeEnvSha256=${runtime_sha}" \
    "tokenCommitment=${ACTIVATION_TOKEN_COMMITMENT}"
  validate_binding_file "${path}" "${runtime_sha}" "${ACTIVATION_GITHUB_SHA}" \
    || fail 'binding file publication could not be verified'
}

write_unknown() {
  local operation="$1"
  local phase="$2"
  local git_sha="${3:-${state_git_sha:-${ACTIVATION_GITHUB_SHA}}}"
  [[ "${git_sha}" =~ ^[0-9a-f]{40}$ ]] || fail 'unknown marker Git revision is invalid'
  atomic_write_lines "${unknown_path}" \
    'version=1' \
    "activationId=${ACTIVATION_ID}" \
    "clientId=${ACTIVATION_CLIENT_ID}" \
    "tokenCommitment=${ACTIVATION_TOKEN_COMMITMENT}" \
    "githubSha=${git_sha}" \
    "expectedCaddyfileSha256=${ACTIVATION_EXPECTED_CADDYFILE_SHA256}" \
    "operation=${operation}" \
    "phase=${phase}"
}

load_unknown() {
  local -a lines=()
  check_user_file "${unknown_path}" || return 1
  mapfile -t lines < "${unknown_path}"
  [[ "${#lines[@]}" -eq 8 \
    && "${lines[0]}" == 'version=1' \
    && "${lines[1]}" == "activationId=${ACTIVATION_ID}" \
    && "${lines[2]}" == "clientId=${ACTIVATION_CLIENT_ID}" \
    && "${lines[3]}" == "tokenCommitment=${ACTIVATION_TOKEN_COMMITMENT}" \
    && "${lines[4]}" =~ ^githubSha=[0-9a-f]{40}$ \
    && "${lines[5]}" == "expectedCaddyfileSha256=${ACTIVATION_EXPECTED_CADDYFILE_SHA256}" \
    && "${lines[6]}" =~ ^operation=(prepare|publish|rollback)$ \
    && "${lines[7]}" =~ ^phase=[a-z-]+$ ]] || return 1
  unknown_git_sha="${lines[4]#githubSha=}"
  unknown_operation="${lines[6]#operation=}"
  unknown_phase="${lines[7]#phase=}"
}

write_state() {
  local phase="$1"
  local proxy_digest="$2"
  local backup_sha="$3"
  local prepared_sha="$4"
  local git_sha="${5:-${state_git_sha:-${ACTIVATION_GITHUB_SHA}}}"
  [[ "${git_sha}" =~ ^[0-9a-f]{40}$ ]] || fail 'state Git revision is invalid'
  atomic_write_lines "${state_path}" \
    'version=1' \
    "activationId=${ACTIVATION_ID}" \
    "clientId=${ACTIVATION_CLIENT_ID}" \
    "tokenCommitment=${ACTIVATION_TOKEN_COMMITMENT}" \
    "expectedCaddyfileSha256=${ACTIVATION_EXPECTED_CADDYFILE_SHA256}" \
    "githubSha=${git_sha}" \
    "scriptSha256=${actual_script_sha256}" \
    "proxyDigestSha256=${proxy_digest}" \
    "runtimeEnvBackupSha256=${backup_sha}" \
    "runtimeEnvPreparedSha256=${prepared_sha}" \
    "phase=${phase}"
}

load_state() {
  local expected_phase="${1:-}"
  local -a lines=()
  check_user_file "${state_path}" || return 1
  mapfile -t lines < "${state_path}"
  [[ "${#lines[@]}" -eq 11 \
    && "${lines[0]}" == 'version=1' \
    && "${lines[1]}" == "activationId=${ACTIVATION_ID}" \
    && "${lines[2]}" == "clientId=${ACTIVATION_CLIENT_ID}" \
    && "${lines[3]}" == "tokenCommitment=${ACTIVATION_TOKEN_COMMITMENT}" \
    && "${lines[4]}" == "expectedCaddyfileSha256=${ACTIVATION_EXPECTED_CADDYFILE_SHA256}" \
    && "${lines[5]}" =~ ^githubSha=[0-9a-f]{40}$ \
    && "${lines[6]}" =~ ^scriptSha256=[0-9a-f]{64}$ \
    && "${lines[7]}" =~ ^proxyDigestSha256=[0-9a-f]{64}$ \
    && "${lines[8]}" =~ ^runtimeEnvBackupSha256=[0-9a-f]{64}$ \
    && "${lines[9]}" =~ ^runtimeEnvPreparedSha256=[0-9a-f]{64}$ \
    && "${lines[10]}" =~ ^phase=(prepared|deployed|published)$ ]] || return 1
  state_script_sha256="${lines[6]#scriptSha256=}"
  state_git_sha="${lines[5]#githubSha=}"
  state_proxy_digest="${lines[7]#proxyDigestSha256=}"
  state_backup_sha="${lines[8]#runtimeEnvBackupSha256=}"
  state_prepared_sha="${lines[9]#runtimeEnvPreparedSha256=}"
  state_phase="${lines[10]#phase=}"
  [[ -z "${expected_phase}" || "${state_phase}" == "${expected_phase}" ]]
}

write_operator_receipt() {
  local path="$1"
  local operation="$2"
  local phase="$3"
  ensure_user_dir "${operator_receipts_dir}"
  atomic_write_lines "${path}" \
    'version=1' \
    "activationId=${ACTIVATION_ID}" \
    "clientId=${ACTIVATION_CLIENT_ID}" \
    "tokenCommitment=${ACTIVATION_TOKEN_COMMITMENT}" \
    "operation=${operation}" \
    "phase=${phase}" \
    "scriptSha256=${actual_script_sha256}"
}

validate_operator_receipt() {
  local path="$1"
  local operation="$2"
  local phase="$3"
  local -a lines=()
  check_user_dir "${operator_receipts_dir}" || return 1
  check_user_file "${path}" || return 1
  mapfile -t lines < "${path}"
  [[ "${#lines[@]}" -eq 7 \
    && "${lines[0]}" == 'version=1' \
    && "${lines[1]}" == "activationId=${ACTIVATION_ID}" \
    && "${lines[2]}" == "clientId=${ACTIVATION_CLIENT_ID}" \
    && "${lines[3]}" == "tokenCommitment=${ACTIVATION_TOKEN_COMMITMENT}" \
    && "${lines[4]}" == "operation=${operation}" \
    && "${lines[5]}" == "phase=${phase}" \
    && "${lines[6]}" =~ ^scriptSha256=[0-9a-f]{64}$ ]]
}

definition_count() {
  local key="$1"
  grep -Ec "^[[:space:]]*${key}[[:space:]]*=" "${runtime_env}" || true
}

nonempty_count() {
  local key="$1"
  grep -Ec "^[[:space:]]*${key}[[:space:]]*=.+$" "${runtime_env}" || true
}

runtime_value() {
  local key="$1"
  sed -n "s/^[[:space:]]*${key}[[:space:]]*=//p" "${runtime_env}"
}

check_runtime_env() {
  check_user_file "${runtime_env}" || fail 'runtime env contract is invalid'
}

health_disabled() {
  local expected_git_sha="${1-${ACTIVATION_GITHUB_SHA}}"
  curl -fsS --connect-timeout 2 --max-time 8 http://127.0.0.1:3100/health \
    | docker exec -i \
      -e EXPECTED_GIT_SHA="${expected_git_sha}" \
      alimtalk-proxy node -e '
        let body = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", chunk => { body += chunk; });
        process.stdin.on("end", () => {
          try {
            const health = JSON.parse(body);
            const f = health.features || {};
            const valid = health.status === "ok"
              && (/^[0-9a-f]{40}$/.test(process.env.EXPECTED_GIT_SHA || "")
                ? health.gitSha === process.env.EXPECTED_GIT_SHA
                : /^[0-9a-f]{40}$/.test(health.gitSha || ""))
              && f.legalMcpConfigurationValid === true
              && f.legalMcpAuthMode === "client_registry"
              && f.legalMcpAuthSource === "file_registry"
              && f.legalMcpRegisteredClientCount === 1
              && f.legalMcpRegisteredTokenCount === 1
              && f.gisMcpConfigurationValid === false
              && f.gisMcpAuthMode === "disabled"
              && f.gisMcpAuthSource === "disabled"
              && f.gisMcpRegisteredClientCount === 0
              && f.gisMcpRegisteredTokenCount === 0
              && f.gisMcpProviderMode === "disabled";
            process.exit(valid ? 0 : 1);
          } catch { process.exit(1); }
        });
      ' >/dev/null 2>&1
}

health_active() {
  local expected_git_sha="${1:-}"
  curl -fsS --connect-timeout 2 --max-time 8 http://127.0.0.1:3100/health \
    | docker exec -i \
      -e EXPECTED_GIT_SHA="${expected_git_sha}" \
      alimtalk-proxy node -e '
        let body = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", chunk => { body += chunk; });
        process.stdin.on("end", () => {
          try {
            const health = JSON.parse(body);
            const f = health.features || {};
            const valid = health.status === "ok"
              && (/^[0-9a-f]{40}$/.test(process.env.EXPECTED_GIT_SHA || "")
                ? health.gitSha === process.env.EXPECTED_GIT_SHA
                : /^[0-9a-f]{40}$/.test(health.gitSha || ""))
              && f.legalMcpConfigurationValid === true
              && f.legalMcpAuthMode === "client_registry"
              && f.legalMcpAuthSource === "file_registry"
              && f.legalMcpRegisteredClientCount === 1
              && f.legalMcpRegisteredTokenCount === 1
              && f.gisMcpConfigurationValid === true
              && f.gisMcpAuthMode === "client_registry"
              && f.gisMcpAuthSource === "file_registry"
              && f.gisMcpRegisteredClientCount === 1
              && f.gisMcpRegisteredTokenCount === 1
              && f.gisMcpProviderMode === "vworld_and_data_portal";
            process.exit(valid ? 0 : 1);
          } catch { process.exit(1); }
        });
      ' >/dev/null 2>&1
}

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

normalized_caddyfile() {
  sudo -n sed -E \
    -e '/^[[:space:]]*(#.*)?$/d' \
    -e 's/^[[:space:]]+//' \
    -e 's/[[:space:]]+$//' \
    "${caddyfile}"
}

caddy_mode() {
  local normalized
  normalized="$(normalized_caddyfile)" || return 1
  if [[ "${normalized}" == "${expected_legal_caddyfile}" ]]; then
    printf 'legal-only'
  elif [[ "${normalized}" == "${expected_gis_caddyfile}" ]]; then
    printf 'gis-active'
  else
    printf 'unsupported'
  fi
}

check_caddy_container_contract() {
  docker container inspect caddy >/dev/null 2>&1 || return 1
  [[ "$(docker container inspect --format '{{.State.Running}}' caddy)" == true \
    && "$(docker container inspect --format '{{.HostConfig.NetworkMode}}' caddy)" == host \
    && "$(docker container inspect --format '{{.HostConfig.RestartPolicy.Name}}' caddy)" == unless-stopped \
    && "$(docker container inspect --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Type}}|{{.RW}}|{{.Source}}{{end}}{{end}}' caddy)" == "bind|false|${caddyfile}" \
    && "$(docker container inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}}|{{.RW}}|{{.Name}}{{end}}{{end}}' caddy)" == 'volume|true|caddy_data' \
    && "$(docker container inspect --format '{{range .Mounts}}{{if eq .Destination "/config"}}{{.Type}}|{{.RW}}|{{.Name}}{{end}}{{end}}' caddy)" == 'volume|true|caddy_config' ]]
}

check_legal_caddy_baseline() {
  sudo -n true >/dev/null 2>&1 || return 1
  [[ "$(caddy_mode)" == legal-only \
    && "$(sudo -n sha256sum -- "${caddyfile}" | awk '{print $1}')" == "${ACTIVATION_EXPECTED_CADDYFILE_SHA256}" ]] \
    || return 1
  sudo -n test -f "${caddy_env}" && ! sudo -n test -L "${caddy_env}" \
    && [[ "$(sudo -n stat -c '%U:%G:%a' "${caddy_env}")" == root:root:600 ]] \
    || return 1
  [[ "$(sudo -n grep -Ec '^LEGAL_MCP_PROXY_TOKEN=.+$' "${caddy_env}" || true)" == 1 \
    && "$(sudo -n grep -Ec '^GIS_MCP_PROXY_TOKEN=' "${caddy_env}" || true)" == 0 \
    && "$(sudo -n grep -Ec '^[A-Z0-9_]+=' "${caddy_env}" || true)" == 1 ]] \
    || return 1
  check_caddy_container_contract
}

check_legal_proxy_pair() {
  [[ "$(definition_count LEGAL_MCP_PROXY_TOKEN_SHA256)" == 1 \
    && "$(nonempty_count LEGAL_MCP_PROXY_TOKEN_SHA256)" == 1 ]] || return 1
  sudo -n env RUNTIME_ENV="${runtime_env}" CADDY_ENV="${caddy_env}" bash -eu -c '
    expected="$(sed -n "s/^[[:space:]]*LEGAL_MCP_PROXY_TOKEN_SHA256[[:space:]]*=//p" "${RUNTIME_ENV}")"
    raw="$(sed -n "s/^LEGAL_MCP_PROXY_TOKEN=//p" "${CADDY_ENV}")"
    [[ "${expected}" =~ ^[0-9a-fA-F]{64}$ && -n "${raw}" ]]
    actual="$(printf %s "${raw}" | sha256sum | awk "{print \$1}")"
    [[ "${actual}" == "${expected,,}" ]]
  ' >/dev/null 2>&1
}

verify_public_legal_only() {
  local public_legal loopback_legal
  public_legal="$(curl -sS -o /dev/null --connect-timeout 3 --max-time 10 \
    -w '%{http_code}' -X POST https://api.tonghari.kr/mcp || true)"
  loopback_legal="$(curl -sS -o /dev/null --connect-timeout 2 --max-time 5 \
    -w '%{http_code}' -X POST -H 'Host: api.tonghari.kr' \
    http://127.0.0.1:3100/mcp || true)"
  [[ "${public_legal}" == 401 && "${loopback_legal}" == 403 ]]
}

verify_public_active() {
  local gis_no_auth gis_invalid loopback_gis public_legal loopback_legal
  gis_no_auth="$(curl -sS -o /dev/null --connect-timeout 3 --max-time 10 \
    -w '%{http_code}' -X POST https://api.tonghari.kr/gis-mcp || true)"
  gis_invalid="$(curl -sS -o /dev/null --connect-timeout 3 --max-time 10 \
    -w '%{http_code}' -X POST \
    -H 'Authorization: Bearer invalid-activation-probe' \
    https://api.tonghari.kr/gis-mcp || true)"
  loopback_gis="$(curl -sS -o /dev/null --connect-timeout 2 --max-time 5 \
    -w '%{http_code}' -X POST -H 'Host: api.tonghari.kr' \
    http://127.0.0.1:3100/gis-mcp || true)"
  public_legal="$(curl -sS -o /dev/null --connect-timeout 3 --max-time 10 \
    -w '%{http_code}' -X POST https://api.tonghari.kr/mcp || true)"
  loopback_legal="$(curl -sS -o /dev/null --connect-timeout 2 --max-time 5 \
    -w '%{http_code}' -X POST -H 'Host: api.tonghari.kr' \
    http://127.0.0.1:3100/mcp || true)"
  [[ "${gis_no_auth}" == 401 && "${gis_invalid}" == 401 \
    && "${loopback_gis}" == 403 \
    && "${public_legal}" == 401 && "${loopback_legal}" == 403 ]]
}

check_lock() {
  check_user_file "${lock_path}" || fail 'production lock contract is invalid'
}
check_lock
exec 9>>"${lock_path}"
flock -w 120 9 || fail 'production lock acquisition timed out'
check_lock
[[ "$(stat -Lc '%d:%i' "/proc/$$/fd/9")" == "$(stat -c '%d:%i' "${lock_path}")" ]] \
  || fail 'production lock changed while acquired'

mutation_intent=0
finish() {
  local status=$?
  trap - EXIT
  if [[ "${status}" -ne 0 && "${mutation_intent}" == 1 ]]; then
    printf 'COMMIT_STATE_UNKNOWN: inspect durable state with status and recover; do not retry the mutation\n' >&2
    exit "${EX_TEMPFAIL}"
  fi
  exit "${status}"
}
trap finish EXIT

root_stage_prepare() {
  sudo -n env \
    ACTIVATION_ID="${ACTIVATION_ID}" \
    EXPECTED_CADDYFILE_SHA256="${ACTIVATION_EXPECTED_CADDYFILE_SHA256}" \
    CADDY_STAGE_PARENT="${caddy_stage_parent}" \
    CADDY_STAGE="${caddy_stage}" \
    CADDYFILE="${caddyfile}" \
    CADDY_ENV="${caddy_env}" \
    bash -s <<'ROOT_STAGE_PREPARE'
  set -Eeuo pipefail
  umask 077

  die() {
    printf 'CADDY_STAGE_FAILED: %s\n' "$1" >&2
    return 1
  }

  [[ "${ACTIVATION_ID}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || die 'invalid activation ID'
  [[ "${EXPECTED_CADDYFILE_SHA256}" =~ ^[0-9a-f]{64}$ ]] || die 'invalid expected digest'
  [[ -d /opt/caddy && ! -L /opt/caddy \
    && "$(stat -c '%U:%G:%a' /opt/caddy)" =~ ^root:root:(700|750|755)$ ]] \
    || die 'Caddy root contract is invalid'
  [[ -f "${CADDYFILE}" && ! -L "${CADDYFILE}" ]] || die 'Caddyfile contract is invalid'
  [[ -f "${CADDY_ENV}" && ! -L "${CADDY_ENV}" \
    && "$(stat -c '%U:%G:%a' "${CADDY_ENV}")" == root:root:600 ]] \
    || die 'Caddy env contract is invalid'
  [[ "$(sha256sum -- "${CADDYFILE}" | awk '{print $1}')" == "${EXPECTED_CADDYFILE_SHA256}" ]] \
    || die 'Caddyfile changed after approval'
  [[ "$(grep -Ec '^LEGAL_MCP_PROXY_TOKEN=.+$' "${CADDY_ENV}" || true)" == 1 \
    && "$(grep -Ec '^GIS_MCP_PROXY_TOKEN=' "${CADDY_ENV}" || true)" == 0 \
    && "$(grep -Ec '^[A-Z0-9_]+=' "${CADDY_ENV}" || true)" == 1 ]] \
    || die 'Caddy env is not the legal-only baseline'
  [[ ! -e "${CADDY_STAGE}" && ! -L "${CADDY_STAGE}" ]] \
    || die 'Caddy activation stage already exists'

  if [[ ! -e "${CADDY_STAGE_PARENT}" && ! -L "${CADDY_STAGE_PARENT}" ]]; then
    install -d -o root -g root -m 700 "${CADDY_STAGE_PARENT}"
  fi
  [[ -d "${CADDY_STAGE_PARENT}" && ! -L "${CADDY_STAGE_PARENT}" \
    && "$(stat -c '%U:%G:%a' "${CADDY_STAGE_PARENT}")" == root:root:700 ]] \
    || die 'Caddy stage parent contract is invalid'
  install -d -o root -g root -m 700 "${CADDY_STAGE}"

  cleanup_stage=1
  cleanup() {
    status=$?
    trap - EXIT
    if [[ "${status}" -ne 0 && "${cleanup_stage}" == 1 ]]; then
      find "${CADDY_STAGE}" -mindepth 1 -maxdepth 1 -type f -delete >/dev/null 2>&1 || true
      rmdir "${CADDY_STAGE}" >/dev/null 2>&1 || true
      rmdir --ignore-fail-on-non-empty "${CADDY_STAGE_PARENT}" >/dev/null 2>&1 || true
    fi
    exit "${status}"
  }
  trap cleanup EXIT

  install -o root -g root -m 600 "${CADDYFILE}" "${CADDY_STAGE}/Caddyfile.backup"
  install -o root -g root -m 600 "${CADDY_ENV}" "${CADDY_STAGE}/proxy.env.backup"

  proxy_raw="$(openssl rand -base64 48 | tr -d '\n')"
  [[ "${proxy_raw}" =~ ^[A-Za-z0-9+/=]{64}$ ]] || die 'proxy secret generation failed'
  proxy_digest="$(printf '%s' "${proxy_raw}" | sha256sum | awk '{print $1}')"
  [[ "${proxy_digest}" =~ ^[0-9a-f]{64}$ ]] || die 'proxy digest generation failed'

  IFS= read -r legal_line < "${CADDY_ENV}"
  [[ "${legal_line}" == LEGAL_MCP_PROXY_TOKEN=* && -n "${legal_line#LEGAL_MCP_PROXY_TOKEN=}" ]] \
    || die 'legal proxy line is invalid'
  printf '%s\n' \
    "${legal_line}" \
    "GIS_MCP_PROXY_TOKEN=${proxy_raw}" \
    > "${CADDY_STAGE}/proxy.env.candidate"
  chmod 600 "${CADDY_STAGE}/proxy.env.candidate"
  unset proxy_raw legal_line

  cat > "${CADDY_STAGE}/Caddyfile.candidate" <<'CADDYFILE'
api.tonghari.kr {
    @legal_mcp path /mcp
    handle @legal_mcp {
        reverse_proxy 127.0.0.1:3100 {
            header_up X-Forwarded-Proto https
            header_up X-Tonghari-MCP-Proxy-Token {$LEGAL_MCP_PROXY_TOKEN}
        }
    }

    @gis_mcp path /gis-mcp
    handle @gis_mcp {
        reverse_proxy 127.0.0.1:3100 {
            header_up X-Forwarded-Proto https
            header_up X-Tonghari-GIS-MCP-Proxy-Token {$GIS_MCP_PROXY_TOKEN}
        }
    }

    handle {
        reverse_proxy 127.0.0.1:3100
    }

    encode gzip
}
CADDYFILE
  chmod 600 "${CADDY_STAGE}/Caddyfile.candidate"

  caddy_image_id="$(docker container inspect --format '{{.Image}}' caddy)"
  [[ "${caddy_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Caddy image ID is invalid'
  docker run --rm \
    --network none --read-only --cap-drop ALL --cap-add NET_BIND_SERVICE \
    --security-opt no-new-privileges \
    --tmpfs /config:rw,nosuid,nodev,noexec,size=4194304 \
    --tmpfs /data:rw,nosuid,nodev,noexec,size=4194304 \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=1048576 \
    --env-file "${CADDY_STAGE}/proxy.env.candidate" \
    -v "${CADDY_STAGE}/Caddyfile.candidate:/etc/caddy/Caddyfile:ro" \
    "${caddy_image_id}" caddy validate \
      --config /etc/caddy/Caddyfile --adapter caddyfile \
      >/dev/null 2>&1 \
    || die 'candidate Caddy configuration is invalid'

  original_env_sha="$(sha256sum -- "${CADDY_STAGE}/proxy.env.backup" | awk '{print $1}')"
  candidate_caddy_sha="$(sha256sum -- "${CADDY_STAGE}/Caddyfile.candidate" | awk '{print $1}')"
  candidate_env_sha="$(sha256sum -- "${CADDY_STAGE}/proxy.env.candidate" | awk '{print $1}')"
  printf '%s\n' \
    'version=1' \
    "activationId=${ACTIVATION_ID}" \
    "expectedCaddyfileSha256=${EXPECTED_CADDYFILE_SHA256}" \
    "originalCaddyEnvSha256=${original_env_sha}" \
    "candidateCaddyfileSha256=${candidate_caddy_sha}" \
    "candidateCaddyEnvSha256=${candidate_env_sha}" \
    "caddyImageId=${caddy_image_id}" \
    "proxyDigestSha256=${proxy_digest}" \
    > "${CADDY_STAGE}/metadata"
  chmod 600 "${CADDY_STAGE}/metadata"
  sync -f "${CADDY_STAGE}/Caddyfile.backup"
  sync -f "${CADDY_STAGE}/proxy.env.backup"
  sync -f "${CADDY_STAGE}/Caddyfile.candidate"
  sync -f "${CADDY_STAGE}/proxy.env.candidate"
  sync -f "${CADDY_STAGE}/metadata"
  sync -f "${CADDY_STAGE}"
  cleanup_stage=0
  printf 'proxyDigestSha256=%s\n' "${proxy_digest}"
ROOT_STAGE_PREPARE
}

validate_root_stage() {
  sudo -n env \
    ACTIVATION_ID="${ACTIVATION_ID}" \
    EXPECTED_CADDYFILE_SHA256="${ACTIVATION_EXPECTED_CADDYFILE_SHA256}" \
    EXPECTED_PROXY_DIGEST="${state_proxy_digest}" \
    CADDY_STAGE_PARENT="${caddy_stage_parent}" \
    CADDY_STAGE="${caddy_stage}" \
    bash -s <<'ROOT_VALIDATE_STAGE'
  set -euo pipefail
  [[ "${ACTIVATION_ID}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]
  [[ "${EXPECTED_CADDYFILE_SHA256}" =~ ^[0-9a-f]{64}$ ]]
  [[ "${EXPECTED_PROXY_DIGEST}" =~ ^[0-9a-f]{64}$ ]]
  [[ -d "${CADDY_STAGE_PARENT}" && ! -L "${CADDY_STAGE_PARENT}" \
    && "$(stat -c '%U:%G:%a' "${CADDY_STAGE_PARENT}")" == root:root:700 ]]
  [[ -d "${CADDY_STAGE}" && ! -L "${CADDY_STAGE}" \
    && "$(stat -c '%U:%G:%a' "${CADDY_STAGE}")" == root:root:700 ]]
  for name in Caddyfile.backup proxy.env.backup Caddyfile.candidate proxy.env.candidate metadata; do
    path="${CADDY_STAGE}/${name}"
    [[ -f "${path}" && ! -L "${path}" \
      && "$(stat -c '%U:%G:%a' "${path}")" == root:root:600 ]]
  done
  mapfile -t lines < "${CADDY_STAGE}/metadata"
  [[ "${#lines[@]}" -eq 8 \
    && "${lines[0]}" == version=1 \
    && "${lines[1]}" == "activationId=${ACTIVATION_ID}" \
    && "${lines[2]}" == "expectedCaddyfileSha256=${EXPECTED_CADDYFILE_SHA256}" \
    && "${lines[3]}" =~ ^originalCaddyEnvSha256=[0-9a-f]{64}$ \
    && "${lines[4]}" =~ ^candidateCaddyfileSha256=[0-9a-f]{64}$ \
    && "${lines[5]}" =~ ^candidateCaddyEnvSha256=[0-9a-f]{64}$ \
    && "${lines[6]}" =~ ^caddyImageId=sha256:[0-9a-f]{64}$ \
    && "${lines[7]}" == "proxyDigestSha256=${EXPECTED_PROXY_DIGEST}" ]]
  [[ "$(sha256sum -- "${CADDY_STAGE}/Caddyfile.backup" | awk '{print $1}')" \
    == "${EXPECTED_CADDYFILE_SHA256}" ]]
  [[ "$(sha256sum -- "${CADDY_STAGE}/proxy.env.backup" | awk '{print $1}')" \
    == "${lines[3]#originalCaddyEnvSha256=}" ]]
  [[ "$(sha256sum -- "${CADDY_STAGE}/Caddyfile.candidate" | awk '{print $1}')" \
    == "${lines[4]#candidateCaddyfileSha256=}" ]]
  [[ "$(sha256sum -- "${CADDY_STAGE}/proxy.env.candidate" | awk '{print $1}')" \
    == "${lines[5]#candidateCaddyEnvSha256=}" ]]
  raw="$(sed -n 's/^GIS_MCP_PROXY_TOKEN=//p' "${CADDY_STAGE}/proxy.env.candidate")"
  [[ -n "${raw}" \
    && "$(printf '%s' "${raw}" | sha256sum | awk '{print $1}')" == "${EXPECTED_PROXY_DIGEST}" ]]
  unset raw
ROOT_VALIDATE_STAGE
}

remove_root_stage() {
  sudo -n env \
    ACTIVATION_ID="${ACTIVATION_ID}" \
    CADDY_STAGE_PARENT="${caddy_stage_parent}" \
    CADDY_STAGE="${caddy_stage}" \
    bash -s <<'ROOT_REMOVE_STAGE'
  set -euo pipefail
  [[ "${ACTIVATION_ID}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]
  [[ "${CADDY_STAGE}" == "${CADDY_STAGE_PARENT}/${ACTIVATION_ID}" ]]
  if [[ -e "${CADDY_STAGE}" || -L "${CADDY_STAGE}" ]]; then
    [[ -d "${CADDY_STAGE}" && ! -L "${CADDY_STAGE}" \
      && "$(stat -c '%U:%G:%a' "${CADDY_STAGE}")" == root:root:700 ]]
    find "${CADDY_STAGE}" -mindepth 1 -maxdepth 1 -type f -delete
    rmdir -- "${CADDY_STAGE}"
  fi
  if [[ -d "${CADDY_STAGE_PARENT}" && ! -L "${CADDY_STAGE_PARENT}" ]]; then
    rmdir --ignore-fail-on-non-empty "${CADDY_STAGE_PARENT}"
  fi
ROOT_REMOVE_STAGE
}

validate_prepared_env() {
  local expected_sha="$1"
  check_runtime_env
  [[ "$(sha256sum -- "${runtime_env}" | awk '{print $1}')" == "${expected_sha}" ]] \
    || return 1
  [[ "$(definition_count GIS_MCP_TOKEN_REGISTRY_FILE)" == 0 \
    && "$(definition_count GIS_MCP_TOKEN_REGISTRY_JSON)" == 1 \
    && "$(nonempty_count GIS_MCP_TOKEN_REGISTRY_JSON)" == 1 \
    && "$(definition_count GIS_MCP_TOKEN_SHA256)" == 0 \
    && "$(definition_count GIS_MCP_PROXY_TOKEN_SHA256)" == 1 \
    && "$(runtime_value GIS_MCP_PROXY_TOKEN_SHA256)" == "${state_proxy_digest}" \
    && "$(definition_count GIS_MCP_ALLOWED_HOSTS)" == 1 \
    && "$(runtime_value GIS_MCP_ALLOWED_HOSTS)" == api.tonghari.kr \
    && "$(definition_count VWORLD_DOMAIN)" == 0 \
    && "$(definition_count VWORLD_API_DOMAIN)" == 1 \
    && "$(runtime_value VWORLD_API_DOMAIN)" == www.tonghari.kr ]] \
    || return 1
  current_image="$(docker container inspect --format '{{.Image}}' alimtalk-proxy)"
  [[ "${current_image}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  attestation="$(
    docker run --rm --network none --read-only --cap-drop ALL \
      --security-opt no-new-privileges \
      --env-file "${runtime_env}" \
      -e EXPECTED_CLIENT_ID="${ACTIVATION_CLIENT_ID}" \
      -e EXPECTED_OPERATION_ID="${ACTIVATION_ID}" \
      "${current_image}" node -e '
        const crypto = require("node:crypto");
        let registry;
        try { registry = JSON.parse(process.env.GIS_MCP_TOKEN_REGISTRY_JSON || ""); }
        catch { process.exit(1); }
        if (registry?.version !== 1 || !Array.isArray(registry.clients) || registry.clients.length !== 1) process.exit(1);
        const entry = registry.clients[0];
        if (entry?.clientId !== process.env.EXPECTED_CLIENT_ID || !/^[0-9a-f]{64}$/.test(entry?.tokenSha256 || "")) process.exit(1);
        const canonical = JSON.stringify({
          version: 1,
          operationId: process.env.EXPECTED_OPERATION_ID,
          action: "add",
          clientId: entry.clientId,
          tokenSha256: entry.tokenSha256,
        });
        process.stdout.write(crypto.createHash("sha256").update(canonical, "utf8").digest("hex"));
      ' 2>/dev/null
  )" || return 1
  [[ "${attestation}" == "${ACTIVATION_TOKEN_COMMITMENT}" ]]
}

root_caddy_temp_files() {
  local mode="$1"
  sudo -n env CADDY_TEMP_MODE="${mode}" bash -s <<'ROOT_CADDY_TEMP_FILES'
  set -euo pipefail
  umask 077
  [[ "${CADDY_TEMP_MODE}" =~ ^(check|cleanup)$ ]]
  [[ -d /opt/caddy && ! -L /opt/caddy \
    && "$(stat -c '%U:%G:%a' /opt/caddy)" =~ ^root:root:(700|750|755)$ ]]
  shopt -s nullglob
  paths=(
    /opt/caddy/.Caddyfile.next.*
    /opt/caddy/.proxy.env.next.*
    /opt/caddy/.Caddyfile.restore.*
    /opt/caddy/.proxy.env.restore.*
  )
  shopt -u nullglob
  for path in "${paths[@]}"; do
    name="${path##*/}"
    [[ "${name}" =~ ^\.(Caddyfile\.(next|restore)|proxy\.env\.(next|restore))\.[A-Za-z0-9]{6}$ \
      && -f "${path}" && ! -L "${path}" \
      && "$(stat -c '%U:%G:%a:%h' "${path}")" == root:root:600:1 ]]
  done
  if [[ "${CADDY_TEMP_MODE}" == check ]]; then
    [[ "${#paths[@]}" -eq 0 ]]
    exit
  fi
  for path in "${paths[@]}"; do
    rm -f -- "${path}"
  done
  if [[ "${#paths[@]}" -gt 0 ]]; then
    sync -f /opt/caddy
  fi
ROOT_CADDY_TEMP_FILES
}

root_publish_caddy() {
  sudo -n env \
    ACTIVATION_ID="${ACTIVATION_ID}" \
    EXPECTED_CADDYFILE_SHA256="${ACTIVATION_EXPECTED_CADDYFILE_SHA256}" \
    EXPECTED_PROXY_DIGEST="${state_proxy_digest}" \
    CADDY_STAGE="${caddy_stage}" \
    CADDYFILE="${caddyfile}" \
    CADDY_ENV="${caddy_env}" \
    bash -s <<'ROOT_PUBLISH_CADDY'
  set -Eeuo pipefail
  umask 077
  EX_TEMPFAIL=75
  swap_started=0

  die() {
    printf 'CADDY_PUBLISH_FAILED: %s\n' "$1" >&2
    return 1
  }

  mapfile -t lines < "${CADDY_STAGE}/metadata"
  [[ "${#lines[@]}" -eq 8 \
    && "${lines[0]}" == version=1 \
    && "${lines[1]}" == "activationId=${ACTIVATION_ID}" \
    && "${lines[2]}" == "expectedCaddyfileSha256=${EXPECTED_CADDYFILE_SHA256}" \
    && "${lines[3]}" =~ ^originalCaddyEnvSha256=[0-9a-f]{64}$ \
    && "${lines[4]}" =~ ^candidateCaddyfileSha256=[0-9a-f]{64}$ \
    && "${lines[5]}" =~ ^candidateCaddyEnvSha256=[0-9a-f]{64}$ \
    && "${lines[6]}" =~ ^caddyImageId=sha256:[0-9a-f]{64}$ \
    && "${lines[7]}" == "proxyDigestSha256=${EXPECTED_PROXY_DIGEST}" ]] \
    || die 'stage metadata is invalid'
  original_env_sha="${lines[3]#originalCaddyEnvSha256=}"
  candidate_caddy_sha="${lines[4]#candidateCaddyfileSha256=}"
  candidate_env_sha="${lines[5]#candidateCaddyEnvSha256=}"
  caddy_image_id="${lines[6]#caddyImageId=}"

  [[ "$(sha256sum -- "${CADDY_STAGE}/Caddyfile.backup" | awk '{print $1}')" \
      == "${EXPECTED_CADDYFILE_SHA256}" \
    && "$(sha256sum -- "${CADDY_STAGE}/proxy.env.backup" | awk '{print $1}')" \
      == "${original_env_sha}" \
    && "$(sha256sum -- "${CADDY_STAGE}/Caddyfile.candidate" | awk '{print $1}')" \
      == "${candidate_caddy_sha}" \
    && "$(sha256sum -- "${CADDY_STAGE}/proxy.env.candidate" | awk '{print $1}')" \
      == "${candidate_env_sha}" ]] \
    || die 'staged Caddy artifacts changed'
  [[ "$(sha256sum -- "${CADDYFILE}" | awk '{print $1}')" == "${EXPECTED_CADDYFILE_SHA256}" \
    && "$(sha256sum -- "${CADDY_ENV}" | awk '{print $1}')" == "${original_env_sha}" ]] \
    || die 'active Caddy files changed after prepare'
  [[ "$(docker container inspect --format '{{.Image}}' caddy)" == "${caddy_image_id}" ]] \
    || die 'active Caddy image changed after prepare'

  docker run --rm \
    --network none --read-only --cap-drop ALL --cap-add NET_BIND_SERVICE \
    --security-opt no-new-privileges \
    --tmpfs /config:rw,nosuid,nodev,noexec,size=4194304 \
    --tmpfs /data:rw,nosuid,nodev,noexec,size=4194304 \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=1048576 \
    --env-file "${CADDY_STAGE}/proxy.env.candidate" \
    -v "${CADDY_STAGE}/Caddyfile.candidate:/etc/caddy/Caddyfile:ro" \
    "${caddy_image_id}" caddy validate \
      --config /etc/caddy/Caddyfile --adapter caddyfile \
      >/dev/null 2>&1 \
    || die 'candidate Caddy configuration no longer validates'

  restore_original() {
    local restore_caddy_next restore_env_next
    set +e
    restore_caddy_next="$(mktemp /opt/caddy/.Caddyfile.restore.XXXXXX)" || return 1
    restore_env_next="$(mktemp /opt/caddy/.proxy.env.restore.XXXXXX)" || return 1
    install -o root -g root -m 600 "${CADDY_STAGE}/Caddyfile.backup" "${restore_caddy_next}" || return 1
    install -o root -g root -m 600 "${CADDY_STAGE}/proxy.env.backup" "${restore_env_next}" || return 1
    mv -f -- "${restore_caddy_next}" "${CADDYFILE}" || return 1
    mv -f -- "${restore_env_next}" "${CADDY_ENV}" || return 1
    sync -f /opt/caddy || return 1
    docker rm -f caddy >/dev/null 2>&1 || true
    docker run -d \
      --name caddy \
      --restart unless-stopped \
      --network host \
      --env-file "${CADDY_ENV}" \
      -v "${CADDYFILE}:/etc/caddy/Caddyfile:ro" \
      -v caddy_data:/data \
      -v caddy_config:/config \
      "${caddy_image_id}" >/dev/null 2>&1 || return 1
    [[ "$(sha256sum -- "${CADDYFILE}" | awk '{print $1}')" == "${EXPECTED_CADDYFILE_SHA256}" \
      && "$(sha256sum -- "${CADDY_ENV}" | awk '{print $1}')" == "${original_env_sha}" \
      && "$(docker container inspect --format '{{.State.Running}}' caddy)" == true ]] \
      || return 1
    return 0
  }

  on_error() {
    status=$?
    trap - ERR
    if [[ "${swap_started}" == 1 ]]; then
      restore_original || exit "${EX_TEMPFAIL}"
    fi
    exit "${status}"
  }
  trap on_error ERR

  caddy_next="$(mktemp /opt/caddy/.Caddyfile.next.XXXXXX)"
  env_next="$(mktemp /opt/caddy/.proxy.env.next.XXXXXX)"
  install -o root -g root -m 600 "${CADDY_STAGE}/Caddyfile.candidate" "${caddy_next}"
  install -o root -g root -m 600 "${CADDY_STAGE}/proxy.env.candidate" "${env_next}"
  sync -f "${caddy_next}"
  sync -f "${env_next}"
  swap_started=1
  mv -f -- "${caddy_next}" "${CADDYFILE}"
  mv -f -- "${env_next}" "${CADDY_ENV}"
  sync -f /opt/caddy

  docker rm -f caddy >/dev/null
  docker run -d \
    --name caddy \
    --restart unless-stopped \
    --network host \
    --env-file "${CADDY_ENV}" \
    -v "${CADDYFILE}:/etc/caddy/Caddyfile:ro" \
    -v caddy_data:/data \
    -v caddy_config:/config \
    "${caddy_image_id}" >/dev/null
  [[ "$(docker container inspect --format '{{.State.Running}}' caddy)" == true \
    && "$(docker container inspect --format '{{.Image}}' caddy)" == "${caddy_image_id}" \
    && "$(sha256sum -- "${CADDYFILE}" | awk '{print $1}')" == "${candidate_caddy_sha}" \
    && "$(sha256sum -- "${CADDY_ENV}" | awk '{print $1}')" == "${candidate_env_sha}" ]] \
    || die 'published Caddy state is invalid'
  trap - ERR
ROOT_PUBLISH_CADDY
}

root_restore_original_caddy() {
  sudo -n env \
    ACTIVATION_ID="${ACTIVATION_ID}" \
    EXPECTED_CADDYFILE_SHA256="${ACTIVATION_EXPECTED_CADDYFILE_SHA256}" \
    CADDY_STAGE="${caddy_stage}" \
    CADDYFILE="${caddyfile}" \
    CADDY_ENV="${caddy_env}" \
    bash -s <<'ROOT_RESTORE_CADDY'
  set -Eeuo pipefail
  umask 077
  mapfile -t lines < "${CADDY_STAGE}/metadata"
  [[ "${#lines[@]}" -eq 8 \
    && "${lines[0]}" == version=1 \
    && "${lines[1]}" == "activationId=${ACTIVATION_ID}" \
    && "${lines[2]}" == "expectedCaddyfileSha256=${EXPECTED_CADDYFILE_SHA256}" \
    && "${lines[3]}" =~ ^originalCaddyEnvSha256=[0-9a-f]{64}$ \
    && "${lines[6]}" =~ ^caddyImageId=sha256:[0-9a-f]{64}$ ]]
  original_env_sha="${lines[3]#originalCaddyEnvSha256=}"
  caddy_image_id="${lines[6]#caddyImageId=}"
  [[ "$(sha256sum -- "${CADDY_STAGE}/Caddyfile.backup" | awk '{print $1}')" \
      == "${EXPECTED_CADDYFILE_SHA256}" \
    && "$(sha256sum -- "${CADDY_STAGE}/proxy.env.backup" | awk '{print $1}')" \
      == "${original_env_sha}" ]]
  caddy_next="$(mktemp /opt/caddy/.Caddyfile.restore.XXXXXX)"
  env_next="$(mktemp /opt/caddy/.proxy.env.restore.XXXXXX)"
  install -o root -g root -m 600 "${CADDY_STAGE}/Caddyfile.backup" "${caddy_next}"
  install -o root -g root -m 600 "${CADDY_STAGE}/proxy.env.backup" "${env_next}"
  mv -f -- "${caddy_next}" "${CADDYFILE}"
  mv -f -- "${env_next}" "${CADDY_ENV}"
  sync -f /opt/caddy
  docker rm -f caddy >/dev/null 2>&1 || true
  docker run -d \
    --name caddy \
    --restart unless-stopped \
    --network host \
    --env-file "${CADDY_ENV}" \
    -v "${CADDYFILE}:/etc/caddy/Caddyfile:ro" \
    -v caddy_data:/data \
    -v caddy_config:/config \
    "${caddy_image_id}" >/dev/null
  [[ "$(docker container inspect --format '{{.State.Running}}' caddy)" == true \
    && "$(sha256sum -- "${CADDYFILE}" | awk '{print $1}')" == "${EXPECTED_CADDYFILE_SHA256}" \
    && "$(sha256sum -- "${CADDY_ENV}" | awk '{print $1}')" == "${original_env_sha}" ]]
ROOT_RESTORE_CADDY
}

verify_active_file_mode() {
  local expected_git_sha="${1:-}"
  check_runtime_env || return 1
  [[ "$(definition_count GIS_MCP_TOKEN_REGISTRY_FILE)" == 1 \
    && "$(grep -Fxc "GIS_MCP_TOKEN_REGISTRY_FILE=${gis_registry_container_file}" "${runtime_env}" || true)" == 1 \
    && "$(definition_count GIS_MCP_TOKEN_REGISTRY_JSON)" == 0 \
    && "$(definition_count GIS_MCP_TOKEN_SHA256)" == 0 \
    && "$(definition_count GIS_MCP_PROXY_TOKEN_SHA256)" == 1 \
    && "$(runtime_value GIS_MCP_PROXY_TOKEN_SHA256)" == "${state_proxy_digest}" \
    && "$(definition_count GIS_MCP_ALLOWED_HOSTS)" == 1 \
    && "$(runtime_value GIS_MCP_ALLOWED_HOSTS)" == api.tonghari.kr \
    && "$(definition_count VWORLD_DOMAIN)" == 0 \
    && "$(definition_count VWORLD_API_DOMAIN)" == 1 \
    && "$(runtime_value VWORLD_API_DOMAIN)" == www.tonghari.kr ]] \
    || return 1
  check_user_file "${gis_marker}" && [[ "$(<"${gis_marker}")" == version=1 ]] \
    || return 1
  [[ -d "${gis_registry_dir}" && ! -L "${gis_registry_dir}" \
    && "$(stat -c '%u:%g:%a' "${gis_registry_dir}")" == 1001:1001:700 \
    && -f "${gis_registry_file}" && ! -L "${gis_registry_file}" \
    && "$(stat -c '%u:%g:%a' "${gis_registry_file}")" == 1001:1001:600 ]] \
    || return 1
  attestation="$(
    docker exec alimtalk-proxy \
      node dist/cli/gis-mcp-registry.js attest-client \
      --path "${gis_registry_container_file}" \
      --client-id "${ACTIVATION_CLIENT_ID}" \
      --operation-id "${ACTIVATION_ID}" 2>/dev/null
  )" || return 1
  [[ "${attestation}" \
    == "action=attest-client clientId=${ACTIVATION_CLIENT_ID} clientCount=1 tokenCommitment=${ACTIVATION_TOKEN_COMMITMENT}" ]] \
    || return 1
  health_active "${expected_git_sha}"
}

verify_gis_proxy_pair() {
  [[ "$(definition_count GIS_MCP_PROXY_TOKEN_SHA256)" == 1 \
    && "$(runtime_value GIS_MCP_PROXY_TOKEN_SHA256)" == "${state_proxy_digest}" ]] \
    || return 1
  sudo -n env RUNTIME_ENV="${runtime_env}" CADDY_ENV="${caddy_env}" bash -eu -c '
    expected="$(sed -n "s/^[[:space:]]*GIS_MCP_PROXY_TOKEN_SHA256[[:space:]]*=//p" "${RUNTIME_ENV}")"
    raw="$(sed -n "s/^GIS_MCP_PROXY_TOKEN=//p" "${CADDY_ENV}")"
    [[ "${expected}" =~ ^[0-9a-f]{64}$ && -n "${raw}" ]]
    actual="$(printf %s "${raw}" | sha256sum | awk "{print \$1}")"
    [[ "${actual}" == "${expected}" ]]
  ' >/dev/null 2>&1
}

verify_public_active_retry() {
  local expected_git_sha="${1:-}"
  local attempt
  for attempt in $(seq 1 15); do
    if check_caddy_container_contract \
      && health_active "${expected_git_sha}" \
      && verify_public_active; then
      return 0
    fi
    sleep 2
  done
  return 1
}

restore_runtime_backup() {
  local expected_sha="$1"
  local next
  check_user_file "${env_backup}" || return 1
  [[ "$(sha256sum -- "${env_backup}" | awk '{print $1}')" == "${expected_sha}" ]] \
    || return 1
  next="$(mktemp "${app_root}/.env.restore.XXXXXX")" || return 1
  install -m 600 "${env_backup}" "${next}" || return 1
  sync -f "${next}" || return 1
  mv -f -- "${next}" "${runtime_env}" || return 1
  sync -f "${app_root}" || return 1
  check_runtime_env \
    && [[ "$(sha256sum -- "${runtime_env}" | awk '{print $1}')" == "${expected_sha}" ]]
}

validate_prepare_preconditions() {
  check_runtime_env
  [[ "$(definition_count VWORLD_API_KEY)" == 1 \
    && "$(nonempty_count VWORLD_API_KEY)" == 1 \
    && "$(definition_count DATA_PORTAL_API_KEY)" == 1 \
    && "$(nonempty_count DATA_PORTAL_API_KEY)" == 1 \
    && "$(definition_count VWORLD_DOMAIN)" == 0 ]] \
    || fail 'provider key or legacy VWorld domain precondition failed'
  vworld_domain_count="$(definition_count VWORLD_API_DOMAIN)"
  [[ "${vworld_domain_count}" == 0 \
    || ( "${vworld_domain_count}" == 1 \
      && "$(runtime_value VWORLD_API_DOMAIN)" == www.tonghari.kr ) ]] \
    || fail 'VWorld domain does not match the approved service URL'
  for key in \
    GIS_MCP_TOKEN_REGISTRY_FILE \
    GIS_MCP_TOKEN_REGISTRY_JSON \
    GIS_MCP_TOKEN_SHA256 \
    GIS_MCP_PROXY_TOKEN_SHA256 \
    GIS_MCP_ALLOWED_HOSTS
  do
    [[ "$(definition_count "${key}")" == 0 ]] \
      || fail 'GIS MCP runtime env is not disabled and empty'
  done
  [[ ! -e "${gis_marker}" && ! -L "${gis_marker}" \
    && ! -e "${gis_registry_dir}" && ! -L "${gis_registry_dir}" \
    && ! -e "${prepared_path}" && ! -L "${prepared_path}" \
    && ! -e "${deployment_receipt}" && ! -L "${deployment_receipt}" \
    && ! -e "${state_path}" && ! -L "${state_path}" \
    && ! -e "${env_backup}" && ! -L "${env_backup}" ]] \
    || fail 'an activation or GIS file-registry artifact already exists'
  activation_temp_files_absent \
    || fail 'an orphan activation env temp file requires recovery review'
  root_caddy_temp_files check \
    || fail 'an orphan Caddy activation temp file requires recovery review'
  if sudo -n test -e "${caddy_stage_parent}" \
    || sudo -n test -L "${caddy_stage_parent}"; then
    sudo -n test -d "${caddy_stage_parent}" \
      && ! sudo -n test -L "${caddy_stage_parent}" \
      && [[ "$(sudo -n find "${caddy_stage_parent}" -mindepth 1 -maxdepth 1 -print -quit)" == '' ]] \
      || fail 'a Caddy activation stage already exists'
  fi
  health_disabled || fail 'current API is not the exact disabled GIS revision'
  [[ "$(docker container inspect --format \
      '{{with (index .HostConfig.PortBindings "3100/tcp")}}{{range .}}{{.HostIp}}|{{.HostPort}}{{println}}{{end}}{{end}}' \
      alimtalk-proxy)" == '127.0.0.1|3100' ]] \
    || fail 'API port is not loopback-only'
  check_legal_caddy_baseline || fail 'Caddy is not the approved legal-only baseline'
  check_legal_proxy_pair || fail 'legal MCP proxy pair does not match'
  verify_public_legal_only || fail 'legal MCP route baseline verification failed'
}

validate_candidate_env() {
  local path="$1"
  local image="$2"
  local configuration commitment
  configuration="$(
    docker run --rm --network none --read-only --cap-drop ALL \
      --security-opt no-new-privileges \
      --env-file "${path}" \
      "${image}" node -e '
        const { getGisMcpConfigurationStateV1 } = require("./dist/services/public-data-mcp/mcp-config");
        const { normalizeDataPortalApiKey } = require("./dist/utils/data-portal-api-key");
        const strictInteger = (name, fallback) => {
          const raw = process.env[name];
          if (raw === undefined || raw.trim() === "") return fallback;
          if (!/^-?\d+$/.test(raw.trim())) return Number.NaN;
          const value = Number(raw.trim());
          return Number.isSafeInteger(value) ? value : Number.NaN;
        };
        const state = getGisMcpConfigurationStateV1({
          vworldApiKey: process.env.VWORLD_API_KEY || "",
          vworldApiDomain: process.env.VWORLD_API_DOMAIN || "",
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
        process.stdout.write(state.configured
          && state.authMode === "client_registry"
          && state.providerMode === "vworld_and_data_portal"
          && state.registeredClientCount === 1
          && state.registeredTokenCount === 1 ? "valid" : "invalid");
      ' 2>/dev/null
  )" || return 1
  [[ "${configuration}" == valid ]] || return 1
  commitment="$(
    docker run --rm --network none --read-only --cap-drop ALL \
      --security-opt no-new-privileges \
      --env-file "${path}" \
      -e EXPECTED_CLIENT_ID="${ACTIVATION_CLIENT_ID}" \
      -e EXPECTED_OPERATION_ID="${ACTIVATION_ID}" \
      "${image}" node -e '
        const crypto = require("node:crypto");
        let registry;
        try { registry = JSON.parse(process.env.GIS_MCP_TOKEN_REGISTRY_JSON || ""); }
        catch { process.exit(1); }
        if (registry?.version !== 1 || !Array.isArray(registry.clients) || registry.clients.length !== 1) process.exit(1);
        const entry = registry.clients[0];
        if (entry?.clientId !== process.env.EXPECTED_CLIENT_ID || !/^[0-9a-f]{64}$/.test(entry?.tokenSha256 || "")) process.exit(1);
        const canonical = JSON.stringify({
          version: 1,
          operationId: process.env.EXPECTED_OPERATION_ID,
          action: "add",
          clientId: entry.clientId,
          tokenSha256: entry.tokenSha256,
        });
        process.stdout.write(crypto.createHash("sha256").update(canonical, "utf8").digest("hex"));
      ' 2>/dev/null
  )" || return 1
  [[ "${commitment}" == "${ACTIVATION_TOKEN_COMMITMENT}" ]]
}

prepare_operation() {
  local token_digest extra actual_commitment backup_next backup_sha
  local stage_result proxy_digest current_image env_next prepared_sha

  IFS= read -r token_digest || fail 'prepare requires one digest line on stdin'
  if IFS= read -r extra; then
    unset token_digest extra
    fail 'prepare accepts exactly one digest line on stdin'
  fi
  [[ "${token_digest}" =~ ^[0-9a-f]{64}$ ]] \
    || { unset token_digest; fail 'pending digest is invalid'; }
  actual_commitment="$(
    printf '%s' \
      "{\"version\":1,\"operationId\":\"${ACTIVATION_ID}\",\"action\":\"add\",\"clientId\":\"${ACTIVATION_CLIENT_ID}\",\"tokenSha256\":\"${token_digest}\"}" \
      | sha256sum | awk '{print $1}'
  )"
  [[ "${actual_commitment}" == "${ACTIVATION_TOKEN_COMMITMENT}" ]] \
    || { unset token_digest actual_commitment; fail 'pending digest commitment mismatch'; }
  unset actual_commitment

  if [[ -e "${unknown_path}" || -L "${unknown_path}" ]]; then
    unset token_digest
    tempfail 'an unresolved activation operation exists'
  fi
  if validate_operator_receipt "${prepare_receipt}" prepare prepared; then
    load_state prepared \
      && validate_binding_file "${prepared_path}" "${state_prepared_sha}" "${state_git_sha}" \
      && validate_prepared_env "${state_prepared_sha}" && validate_root_stage \
      && health_disabled "${state_git_sha}" \
      && check_legal_caddy_baseline \
      && check_legal_proxy_pair && verify_public_legal_only \
      || tempfail 'prepare receipt exists but current state does not match it'
    unset token_digest
    printf 'activationStatus=prepared\nidempotent=true\n'
    return 0
  fi
  [[ ! -e "${prepare_receipt}" && ! -L "${prepare_receipt}" ]] \
    || fail 'prepare receipt is invalid'

  validate_prepare_preconditions
  write_unknown prepare intent
  mutation_intent=1

  backup_next="$(mktemp "${app_root}/.env.gis-mcp-backup.next.XXXXXX")"
  install -m 600 "${runtime_env}" "${backup_next}"
  sync -f "${backup_next}"
  mv -f -- "${backup_next}" "${env_backup}"
  sync -f "${app_root}"
  check_user_file "${env_backup}" || tempfail 'runtime env backup publication failed'
  backup_sha="$(sha256sum -- "${env_backup}" | awk '{print $1}')"

  stage_result="$(root_stage_prepare)" \
    || tempfail 'Caddy candidate staging did not complete'
  [[ "${stage_result}" =~ ^proxyDigestSha256=[0-9a-f]{64}$ ]] \
    || tempfail 'Caddy stage returned an invalid attestation'
  proxy_digest="${stage_result#proxyDigestSha256=}"
  unset stage_result

  current_image="$(docker container inspect --format '{{.Image}}' alimtalk-proxy)"
  [[ "${current_image}" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || tempfail 'current API image ID is invalid'
  env_next="$(mktemp "${app_root}/.env.gis-mcp-activation.next.XXXXXX")"
  chmod 600 "${env_next}"
  awk '
    /^[[:space:]]*GIS_MCP_TOKEN_REGISTRY_FILE[[:space:]]*=/ { next }
    /^[[:space:]]*GIS_MCP_TOKEN_REGISTRY_JSON[[:space:]]*=/ { next }
    /^[[:space:]]*GIS_MCP_TOKEN_SHA256[[:space:]]*=/ { next }
    /^[[:space:]]*GIS_MCP_PROXY_TOKEN_SHA256[[:space:]]*=/ { next }
    /^[[:space:]]*GIS_MCP_ALLOWED_HOSTS[[:space:]]*=/ { next }
    { print }
  ' "${runtime_env}" > "${env_next}"
  if [[ "${vworld_domain_count}" == 0 ]]; then
    printf 'VWORLD_API_DOMAIN=www.tonghari.kr\n' >> "${env_next}"
  fi
  printf 'GIS_MCP_TOKEN_REGISTRY_JSON={"version":1,"clients":[{"clientId":"%s","tokenSha256":"%s"}]}\n' \
    "${ACTIVATION_CLIENT_ID}" "${token_digest}" >> "${env_next}"
  printf 'GIS_MCP_PROXY_TOKEN_SHA256=%s\n' "${proxy_digest}" >> "${env_next}"
  printf 'GIS_MCP_ALLOWED_HOSTS=api.tonghari.kr\n' >> "${env_next}"
  unset token_digest

  validate_candidate_env "${env_next}" "${current_image}" \
    || tempfail 'candidate API environment is invalid or not commitment-bound'
  sync -f "${env_next}"
  mv -f -- "${env_next}" "${runtime_env}"
  sync -f "${app_root}"
  check_runtime_env || tempfail 'prepared runtime env publication failed'
  prepared_sha="$(sha256sum -- "${runtime_env}" | awk '{print $1}')"
  [[ "${prepared_sha}" =~ ^[0-9a-f]{64}$ ]] \
    || tempfail 'prepared runtime env digest is invalid'

  write_state prepared "${proxy_digest}" "${backup_sha}" "${prepared_sha}"
  load_state prepared || tempfail 'prepared activation state could not be verified'
  validate_prepared_env "${prepared_sha}" \
    || tempfail 'prepared runtime env could not be independently attested'
  validate_root_stage || tempfail 'staged Caddy artifacts could not be verified'
  write_binding_file "${prepared_path}" "${prepared_sha}"
  write_operator_receipt "${prepare_receipt}" prepare prepared
  validate_operator_receipt "${prepare_receipt}" prepare prepared \
    || tempfail 'prepare receipt could not be verified'
  rm -f -- "${unknown_path}"
  sync -f "${app_root}"
  mutation_intent=0
  printf 'activationStatus=prepared\n'
  printf 'clientId=%s\n' "${ACTIVATION_CLIENT_ID}"
  printf 'gitSha=%s\n' "${ACTIVATION_GITHUB_SHA}"
}

status_operation() {
  local cleanup_required=0

  if [[ -e "${unknown_path}" || -L "${unknown_path}" ]]; then
    load_unknown || tempfail 'activation unknown marker is invalid'
    printf 'activationStatus=ambiguous\n'
    printf 'operation=%s\n' "${unknown_operation}"
    printf 'phase=%s\n' "${unknown_phase}"
    return "${EX_TEMPFAIL}"
  fi

  if validate_operator_receipt "${publish_receipt}" publish published; then
    load_state published \
      && validate_deployment_receipt "${state_prepared_sha}" "${state_git_sha}" \
      && verify_active_file_mode \
      && [[ "$(caddy_mode)" == gis-active ]] \
      && check_caddy_container_contract \
      && verify_gis_proxy_pair \
      && check_legal_proxy_pair \
      && verify_public_active \
      || tempfail 'published receipt does not match the live service'
    if [[ -e "${env_backup}" || -L "${env_backup}" ]]; then
      check_user_file "${env_backup}" \
        && [[ "$(sha256sum -- "${env_backup}" | awk '{print $1}')" == "${state_backup_sha}" ]] \
        || tempfail 'published runtime backup cleanup artifact is invalid'
      cleanup_required=1
    fi
    if sudo -n test -e "${caddy_stage}" || sudo -n test -L "${caddy_stage}"; then
      validate_root_stage \
        || tempfail 'published Caddy cleanup artifact is invalid'
      cleanup_required=1
    fi
    printf 'activationStatus=published\n'
    if [[ "${cleanup_required}" == 1 ]]; then
      printf 'cleanupRequired=true\n'
      return 71
    fi
    return 0
  fi
  if [[ -e "${publish_receipt}" || -L "${publish_receipt}" ]]; then
    tempfail 'publish receipt is invalid'
  fi

  if [[ -e "${deployment_receipt}" || -L "${deployment_receipt}" ]]; then
    load_state \
      && [[ "${state_phase}" =~ ^(prepared|deployed)$ ]] \
      && validate_deployment_receipt "${state_prepared_sha}" "${state_git_sha}" \
      && [[ ! -e "${prepared_path}" && ! -L "${prepared_path}" ]] \
      && verify_active_file_mode "${state_git_sha}" \
      && validate_root_stage \
      && check_legal_caddy_baseline \
      && check_legal_proxy_pair \
      && verify_public_legal_only \
      || tempfail 'deployment receipt does not match the staged service'
    printf 'activationStatus=deployed\n'
    return 0
  fi

  if [[ -e "${prepared_path}" || -L "${prepared_path}" ]]; then
    load_state prepared \
      && validate_binding_file "${prepared_path}" "${state_prepared_sha}" "${state_git_sha}" \
      && validate_prepared_env "${state_prepared_sha}" \
      && validate_root_stage \
      && check_legal_caddy_baseline \
      && check_legal_proxy_pair \
      && health_disabled "${state_git_sha}" \
      && verify_public_legal_only \
      || tempfail 'prepared binding does not match the staged service'
    printf 'activationStatus=prepared\n'
    return 0
  fi

  if validate_operator_receipt "${rollback_receipt}" rollback rolled-back \
    || validate_operator_receipt "${recover_receipt}" recover rolled-back; then
    [[ ! -e "${state_path}" && ! -L "${state_path}" \
      && ! -e "${env_backup}" && ! -L "${env_backup}" \
      && ! -e "${gis_marker}" && ! -L "${gis_marker}" \
      && ! -e "${gis_registry_dir}" && ! -L "${gis_registry_dir}" ]] \
      && check_legal_caddy_baseline \
      && check_legal_proxy_pair \
      && health_disabled '' \
      && verify_public_legal_only \
      || tempfail 'rollback receipt does not match current state'
    printf 'activationStatus=rolled-back\n'
    return 0
  fi

  if [[ -e "${state_path}" || -L "${state_path}" \
    || -e "${env_backup}" || -L "${env_backup}" \
    || -e "${prepare_receipt}" || -L "${prepare_receipt}" \
    || -e "${rollback_receipt}" || -L "${rollback_receipt}" \
    || -e "${recover_receipt}" || -L "${recover_receipt}" ]]; then
    tempfail 'orphan activation artifacts require recovery review'
  fi
  printf 'activationStatus=not-prepared\n'
}

publish_operation() {
  local backup_sha prepared_sha

  if [[ -e "${unknown_path}" || -L "${unknown_path}" ]]; then
    tempfail 'an unresolved activation operation exists'
  fi
  if validate_operator_receipt "${publish_receipt}" publish published; then
    status_operation
    printf 'idempotent=true\n'
    return 0
  fi
  [[ ! -e "${publish_receipt}" && ! -L "${publish_receipt}" ]] \
    || fail 'publish receipt is invalid'

  load_state || fail 'prepared activation state is missing or invalid'
  [[ "${state_phase}" =~ ^(prepared|deployed)$ ]] \
    || fail 'activation is not awaiting Caddy publication'
  backup_sha="${state_backup_sha}"
  prepared_sha="${state_prepared_sha}"
  validate_deployment_receipt "${prepared_sha}" "${state_git_sha}" \
    || fail 'matching deployment consumption receipt is required'
  [[ ! -e "${prepared_path}" && ! -L "${prepared_path}" ]] \
    || fail 'deployment has not atomically consumed the prepared handoff'
  check_user_file "${env_backup}" \
    && [[ "$(sha256sum -- "${env_backup}" | awk '{print $1}')" == "${backup_sha}" ]] \
    || fail 'pre-activation runtime env backup is invalid'
  validate_root_stage || fail 'Caddy candidate stage is invalid'
  verify_active_file_mode "${state_git_sha}" \
    || fail 'file-mode GIS API health or registry attestation failed'
  check_legal_caddy_baseline || fail 'Caddy changed before publication'
  check_legal_proxy_pair || fail 'legal MCP proxy pair no longer matches'
  verify_public_legal_only || fail 'legal MCP route baseline verification failed'

  write_state deployed "${state_proxy_digest}" "${backup_sha}" "${prepared_sha}"
  write_unknown publish swapping-caddy
  mutation_intent=1
  if ! root_publish_caddy; then
    root_caddy_temp_files cleanup \
      || tempfail 'Caddy publication failed and temp cleanup could not be proven'
    tempfail 'Caddy publication did not reach a known state'
  fi
  root_caddy_temp_files check \
    || tempfail 'Caddy publication left an activation temp file'

  if [[ "$(caddy_mode)" != gis-active ]] \
    || ! check_caddy_container_contract \
    || ! verify_gis_proxy_pair \
    || ! check_legal_proxy_pair \
    || ! verify_public_active_retry "${state_git_sha}"; then
    if root_restore_original_caddy \
      && root_caddy_temp_files cleanup \
      && check_legal_caddy_baseline \
      && verify_public_legal_only; then
      write_state deployed "${state_proxy_digest}" "${backup_sha}" "${prepared_sha}"
      rm -f -- "${unknown_path}"
      sync -f "${app_root}"
      mutation_intent=0
      fail 'public GIS route verification failed; Caddy was restored and publish may be retried'
    fi
    tempfail 'public verification failed and Caddy rollback could not be proven'
  fi

  write_state published "${state_proxy_digest}" "${backup_sha}" "${prepared_sha}"
  write_operator_receipt "${publish_receipt}" publish published
  validate_operator_receipt "${publish_receipt}" publish published \
    || tempfail 'publish receipt could not be verified'
  rm -f -- "${unknown_path}"
  sync -f "${app_root}"
  mutation_intent=0

  cleanup_failed=0
  if ! rm -f -- "${env_backup}" \
    || [[ -e "${env_backup}" || -L "${env_backup}" ]]; then
    cleanup_failed=1
  fi
  if ! remove_root_stage; then
    cleanup_failed=1
  fi
  if [[ "${cleanup_failed}" == 1 ]]; then
    printf 'CLEANUP_FAILED: published service remains active; root-only staged copies require review\n' >&2
    exit 71
  fi
  printf 'activationStatus=published\n'
  printf 'clientId=%s\n' "${ACTIVATION_CLIENT_ID}"
  printf 'gitSha=%s\n' "${state_git_sha}"
}

rollback_operation() {
  local backup_sha prepared_sha

  if [[ -e "${unknown_path}" || -L "${unknown_path}" ]]; then
    tempfail 'an unresolved activation operation exists'
  fi
  if validate_operator_receipt "${rollback_receipt}" rollback rolled-back; then
    status_operation
    printf 'idempotent=true\n'
    return 0
  fi
  [[ ! -e "${rollback_receipt}" && ! -L "${rollback_receipt}" ]] \
    || fail 'rollback receipt is invalid'

  load_state prepared || fail 'prepared activation state is missing or invalid'
  backup_sha="${state_backup_sha}"
  prepared_sha="${state_prepared_sha}"
  validate_binding_file "${prepared_path}" "${prepared_sha}" "${state_git_sha}" \
    || fail 'prepared handoff is missing or invalid'
  [[ ! -e "${deployment_receipt}" && ! -L "${deployment_receipt}" \
    && ! -e "${gis_marker}" && ! -L "${gis_marker}" \
    && ! -e "${gis_registry_dir}" && ! -L "${gis_registry_dir}" ]] \
    || fail 'rollback is prohibited after migration has started or committed'
  validate_prepared_env "${prepared_sha}" \
    || fail 'prepared runtime env no longer matches its commitment'
  validate_root_stage || fail 'Caddy candidate stage is invalid'
  check_legal_caddy_baseline || fail 'Caddy is no longer in the pre-publication state'
  health_disabled "${state_git_sha}" \
    || fail 'running API is not the expected disabled revision'

  write_unknown rollback restoring-runtime-env
  mutation_intent=1
  restore_runtime_backup "${backup_sha}" \
    || tempfail 'runtime env restoration could not be proven'
  [[ "$(definition_count GIS_MCP_TOKEN_REGISTRY_FILE)" == 0 \
    && "$(definition_count GIS_MCP_TOKEN_REGISTRY_JSON)" == 0 \
    && "$(definition_count GIS_MCP_TOKEN_SHA256)" == 0 \
    && "$(definition_count GIS_MCP_PROXY_TOKEN_SHA256)" == 0 \
    && "$(definition_count GIS_MCP_ALLOWED_HOSTS)" == 0 ]] \
    || tempfail 'restored runtime env still contains GIS activation keys'
  rm -f -- "${prepared_path}" "${state_path}"
  remove_root_stage || tempfail 'Caddy stage cleanup failed'
  rm -f -- "${env_backup}"
  [[ ! -e "${prepared_path}" && ! -L "${prepared_path}" \
    && ! -e "${state_path}" && ! -L "${state_path}" \
    && ! -e "${env_backup}" && ! -L "${env_backup}" ]] \
    || tempfail 'rollback cleanup could not be verified'
  write_operator_receipt "${rollback_receipt}" rollback rolled-back
  validate_operator_receipt "${rollback_receipt}" rollback rolled-back \
    || tempfail 'rollback receipt could not be verified'
  rm -f -- "${unknown_path}"
  sync -f "${app_root}"
  mutation_intent=0
  health_disabled "${state_git_sha}" \
    && check_legal_caddy_baseline && verify_public_legal_only \
    || fail 'rollback completed on disk but live baseline verification failed'
  printf 'activationStatus=rolled-back\n'
}

recover_operation() {
  local backup_sha prepared_sha mode cleanup_required cleanup_failed state_present

  if [[ ! -e "${unknown_path}" && ! -L "${unknown_path}" ]]; then
    root_caddy_temp_files cleanup \
      || tempfail 'Caddy temp cleanup could not be proven safe'
    cleanup_required=0
    if validate_operator_receipt "${publish_receipt}" publish published \
      && load_state published; then
      if [[ -e "${env_backup}" || -L "${env_backup}" ]]; then
        check_user_file "${env_backup}" \
          && [[ "$(sha256sum -- "${env_backup}" | awk '{print $1}')" == "${state_backup_sha}" ]] \
          || tempfail 'published runtime backup cleanup artifact is invalid'
        cleanup_required=1
      fi
      if sudo -n test -e "${caddy_stage}" || sudo -n test -L "${caddy_stage}"; then
        validate_root_stage \
          || tempfail 'published Caddy cleanup artifact is invalid'
        cleanup_required=1
      fi
      if [[ "${cleanup_required}" == 1 ]]; then
        validate_deployment_receipt "${state_prepared_sha}" "${state_git_sha}" \
          && verify_active_file_mode "${state_git_sha}" \
          && [[ "$(caddy_mode)" == gis-active ]] \
          && check_caddy_container_contract \
          && verify_gis_proxy_pair \
          && check_legal_proxy_pair \
          && verify_public_active \
          || tempfail 'published service cannot be proven before cleanup recovery'
        cleanup_failed=0
        rm -f -- "${env_backup}" || cleanup_failed=1
        remove_root_stage || cleanup_failed=1
        if [[ "${cleanup_failed}" == 1 ]]; then
          printf 'CLEANUP_FAILED: published service remains active; cleanup may be retried\n' >&2
          exit 71
        fi
        sync -f "${app_root}" \
          || tempfail 'published cleanup durability could not be proven'
        status_operation
        printf 'recovery=finalized-published-cleanup\n'
        return 0
      fi
    fi
    status_operation
    printf 'recovery=no-op\n'
    return 0
  fi
  load_unknown || tempfail 'activation unknown marker is invalid or belongs to another binding'
  mutation_intent=1
  root_caddy_temp_files cleanup \
    || tempfail 'Caddy temp cleanup could not be proven safe'
  cleanup_activation_temp_files \
    || tempfail 'activation env temp cleanup could not be proven safe'

  if [[ "${unknown_operation}" == prepare ]]; then
    if load_state prepared \
      && [[ "${state_git_sha}" == "${unknown_git_sha}" ]] \
      && validate_binding_file "${prepared_path}" "${state_prepared_sha}" "${state_git_sha}" \
      && validate_prepared_env "${state_prepared_sha}" \
      && validate_root_stage \
      && check_legal_caddy_baseline \
      && check_legal_proxy_pair \
      && health_disabled "${state_git_sha}" \
      && verify_public_legal_only; then
      write_operator_receipt "${prepare_receipt}" prepare prepared
      rm -f -- "${unknown_path}"
      sync -f "${app_root}"
      mutation_intent=0
      printf 'activationStatus=prepared\nrecovery=finalized-prepare\n'
      return 0
    fi

    [[ ! -e "${prepared_path}" && ! -L "${prepared_path}" \
      && ! -e "${deployment_receipt}" && ! -L "${deployment_receipt}" \
      && ! -e "${gis_marker}" && ! -L "${gis_marker}" \
      && ! -e "${gis_registry_dir}" && ! -L "${gis_registry_dir}" ]] \
      || tempfail 'ambiguous prepare cannot be safely rolled back'
    if [[ ! -e "${env_backup}" && ! -L "${env_backup}" ]]; then
      [[ ! -e "${state_path}" && ! -L "${state_path}" \
        && ! -e "${prepare_receipt}" && ! -L "${prepare_receipt}" ]] \
        || tempfail 'ambiguous prepare without a backup has unexpected artifacts'
      if sudo -n test -e "${caddy_stage}" || sudo -n test -L "${caddy_stage}"; then
        tempfail 'ambiguous prepare without a backup has a Caddy stage'
      fi
      check_runtime_env
      [[ "$(definition_count GIS_MCP_TOKEN_REGISTRY_FILE)" == 0 \
        && "$(definition_count GIS_MCP_TOKEN_REGISTRY_JSON)" == 0 \
        && "$(definition_count GIS_MCP_TOKEN_SHA256)" == 0 \
        && "$(definition_count GIS_MCP_PROXY_TOKEN_SHA256)" == 0 \
        && "$(definition_count GIS_MCP_ALLOWED_HOSTS)" == 0 ]] \
        || tempfail 'ambiguous prepare changed runtime env before creating its backup'
      check_legal_caddy_baseline \
        && check_legal_proxy_pair \
        && health_disabled "${unknown_git_sha}" \
        && verify_public_legal_only \
        || tempfail 'ambiguous prepare cannot prove the untouched baseline'
      write_operator_receipt "${recover_receipt}" recover rolled-back
      rm -f -- "${unknown_path}"
      sync -f "${app_root}"
      mutation_intent=0
      printf 'activationStatus=rolled-back\nrecovery=cleared-prepare-intent\n'
      return 0
    fi
    check_user_file "${env_backup}" \
      || tempfail 'ambiguous prepare has no trustworthy runtime env backup'
    backup_sha="$(sha256sum -- "${env_backup}" | awk '{print $1}')"
    [[ "${backup_sha}" =~ ^[0-9a-f]{64}$ ]] \
      || tempfail 'runtime env backup digest is invalid'
    if [[ -e "${state_path}" || -L "${state_path}" ]]; then
      load_state prepared \
        || tempfail 'ambiguous prepare state file is invalid'
      [[ "${state_git_sha}" == "${unknown_git_sha}" \
        && "${state_backup_sha}" == "${backup_sha}" ]] \
        || tempfail 'ambiguous prepare state does not match its recovery evidence'
    fi
    check_legal_caddy_baseline \
      || tempfail 'Caddy changed during ambiguous prepare'
    restore_runtime_backup "${backup_sha}" \
      || tempfail 'ambiguous prepare runtime env restoration failed'
    [[ "$(definition_count GIS_MCP_TOKEN_REGISTRY_FILE)" == 0 \
      && "$(definition_count GIS_MCP_TOKEN_REGISTRY_JSON)" == 0 \
      && "$(definition_count GIS_MCP_TOKEN_SHA256)" == 0 \
      && "$(definition_count GIS_MCP_PROXY_TOKEN_SHA256)" == 0 \
      && "$(definition_count GIS_MCP_ALLOWED_HOSTS)" == 0 ]] \
      || tempfail 'restored runtime env still contains GIS activation keys'
    if [[ -e "${state_path}" || -L "${state_path}" ]]; then
      rm -f -- "${state_path}"
    fi
    remove_root_stage || tempfail 'ambiguous prepare Caddy stage cleanup failed'
    rm -f -- "${env_backup}"
    write_operator_receipt "${recover_receipt}" recover rolled-back
    rm -f -- "${unknown_path}"
    sync -f "${app_root}"
    mutation_intent=0
    health_disabled "${unknown_git_sha}" && verify_public_legal_only \
      || fail 'prepare recovery restored disk state but live baseline failed'
    printf 'activationStatus=rolled-back\nrecovery=rolled-back-prepare\n'
    return 0
  fi

  if [[ "${unknown_operation}" == publish ]]; then
    load_state || tempfail 'publish recovery state is invalid'
    [[ "${state_phase}" =~ ^(prepared|deployed|published)$ ]] \
      || tempfail 'publish recovery phase is invalid'
    [[ "${state_git_sha}" == "${unknown_git_sha}" ]] \
      || tempfail 'publish recovery state does not match its intent revision'
    backup_sha="${state_backup_sha}"
    prepared_sha="${state_prepared_sha}"
    validate_deployment_receipt "${prepared_sha}" "${state_git_sha}" \
      || tempfail 'publish recovery requires the deployment consumption receipt'
    [[ ! -e "${prepared_path}" && ! -L "${prepared_path}" ]] \
      || tempfail 'publish recovery found an unconsumed prepared handoff'
    validate_root_stage || tempfail 'publish recovery Caddy stage is invalid'
    verify_active_file_mode "${state_git_sha}" \
      || tempfail 'publish recovery API is not the committed file-mode service'
    mode="$(caddy_mode)"
    if [[ "${mode}" == gis-active ]] \
      && check_caddy_container_contract \
      && verify_gis_proxy_pair \
      && check_legal_proxy_pair \
      && verify_public_active_retry "${state_git_sha}"; then
      write_state published "${state_proxy_digest}" "${backup_sha}" "${prepared_sha}"
      write_operator_receipt "${publish_receipt}" publish published
      write_operator_receipt "${recover_receipt}" recover published
      rm -f -- "${unknown_path}"
      sync -f "${app_root}"
      mutation_intent=0
      cleanup_failed=0
      rm -f -- "${env_backup}" || cleanup_failed=1
      remove_root_stage || cleanup_failed=1
      if [[ "${cleanup_failed}" == 1 ]]; then
        printf 'CLEANUP_FAILED: recovered published service is active; staged copies require review\n' >&2
        exit 71
      fi
      printf 'activationStatus=published\nrecovery=finalized-publish\n'
      return 0
    fi
    if [[ "${mode}" == legal-only ]] \
      && check_legal_caddy_baseline \
      && check_legal_proxy_pair \
      && verify_public_legal_only; then
      write_state deployed "${state_proxy_digest}" "${backup_sha}" "${prepared_sha}"
      write_operator_receipt "${recover_receipt}" recover deployed
      rm -f -- "${unknown_path}"
      sync -f "${app_root}"
      mutation_intent=0
      printf 'activationStatus=deployed\nrecovery=publish-not-exposed\n'
      return 0
    fi
    if root_restore_original_caddy \
      && root_caddy_temp_files cleanup \
      && check_legal_caddy_baseline \
      && check_legal_proxy_pair \
      && verify_public_legal_only; then
      write_state deployed "${state_proxy_digest}" "${backup_sha}" "${prepared_sha}"
      write_operator_receipt "${recover_receipt}" recover deployed
      rm -f -- "${unknown_path}"
      sync -f "${app_root}"
      mutation_intent=0
      printf 'activationStatus=deployed\nrecovery=restored-legal-only\n'
      return 0
    fi
    tempfail 'publish recovery cannot prove either the published or restored endpoint'
  fi

  if [[ "${unknown_operation}" == rollback ]]; then
    [[ ! -e "${deployment_receipt}" && ! -L "${deployment_receipt}" \
      && ! -e "${gis_marker}" && ! -L "${gis_marker}" \
      && ! -e "${gis_registry_dir}" && ! -L "${gis_registry_dir}" ]] \
      || tempfail 'rollback recovery is prohibited after migration'
    state_present=0
    if [[ -e "${state_path}" || -L "${state_path}" ]]; then
      load_state prepared || tempfail 'rollback recovery state file is invalid'
      [[ "${state_git_sha}" == "${unknown_git_sha}" ]] \
        || tempfail 'rollback recovery state does not match its intent revision'
      state_present=1
    fi
    if [[ -e "${env_backup}" || -L "${env_backup}" ]]; then
      check_user_file "${env_backup}" \
        || tempfail 'rollback recovery runtime env backup is invalid'
      backup_sha="$(sha256sum -- "${env_backup}" | awk '{print $1}')"
      [[ "${state_present}" == 0 || "${backup_sha}" == "${state_backup_sha}" ]] \
        || tempfail 'rollback recovery backup does not match activation state'
      restore_runtime_backup "${backup_sha}" \
        || tempfail 'rollback recovery could not restore runtime env'
    fi
    [[ "$(definition_count GIS_MCP_TOKEN_REGISTRY_FILE)" == 0 \
      && "$(definition_count GIS_MCP_TOKEN_REGISTRY_JSON)" == 0 \
      && "$(definition_count GIS_MCP_TOKEN_SHA256)" == 0 \
      && "$(definition_count GIS_MCP_PROXY_TOKEN_SHA256)" == 0 \
      && "$(definition_count GIS_MCP_ALLOWED_HOSTS)" == 0 ]] \
      || tempfail 'rollback recovery runtime env remains activated'
    if [[ -e "${prepared_path}" || -L "${prepared_path}" ]]; then
      prepared_sha=''
      if [[ "${state_present}" == 1 ]]; then
        prepared_sha="${state_prepared_sha}"
      fi
      validate_binding_file "${prepared_path}" "${prepared_sha}" "${unknown_git_sha}" \
        || tempfail 'rollback recovery handoff is invalid'
      rm -f -- "${prepared_path}"
    fi
    if [[ -e "${state_path}" || -L "${state_path}" ]]; then
      rm -f -- "${state_path}"
    fi
    remove_root_stage || tempfail 'rollback recovery Caddy stage cleanup failed'
    rm -f -- "${env_backup}"
    write_operator_receipt "${rollback_receipt}" rollback rolled-back
    write_operator_receipt "${recover_receipt}" recover rolled-back
    rm -f -- "${unknown_path}"
    sync -f "${app_root}"
    mutation_intent=0
    health_disabled "${unknown_git_sha}" \
      && check_legal_caddy_baseline && verify_public_legal_only \
      || fail 'rollback recovery completed on disk but live baseline failed'
    printf 'activationStatus=rolled-back\nrecovery=finalized-rollback\n'
    return 0
  fi

  tempfail 'unknown operation is not recoverable by this operator'
}

case "${ACTIVATION_OPERATION}" in
  prepare)
    prepare_operation
    ;;
  status)
    status_operation
    ;;
  publish)
    publish_operation
    ;;
  rollback)
    rollback_operation
    ;;
  recover)
    recover_operation
    ;;
esac
