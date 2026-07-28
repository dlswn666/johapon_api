#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

run_key_pattern='^[0-9]+-[0-9]+$'
sha_pattern='^[0-9a-f]{40}$'
recipient_pattern='^age1[0-9a-z]{58}$'

if [[ "${INGRESS_JANITOR_MODE:-0}" == "1" ]]; then
  if [[
    ! "${RUN_KEY:-}" =~ ${run_key_pattern}
    || -n "${JANITOR_MODE:-}"
    || -n "${EXPECTED_GIT_SHA:-}"
    || -n "${EXPECTED_IMAGE_TAG:-}"
    || -n "${MODE:-}"
    || -n "${OWNER_AGE_RECIPIENT:-}"
    || -n "${OWNER_AGE_RECIPIENT_SHA256:-}"
    || -n "${DEV_SUPABASE_URL:-}"
    || -n "${DEV_SUPABASE_SERVICE_ROLE_KEY:-}"
  ]]; then
    exit 64
  fi

  ingress_root="/dev/shm/.development-api-authoritative-ldareg-backfill-${RUN_KEY}"
  ingress_marker="${ingress_root}/ingress-janitor-started"
  ingress_handoff="${ingress_root}/janitor-started"
  ingress_cleanup_ttl_seconds=300
  ingress_handed_off=0

  ingress_root_is_private() {
    [[
      -d "${ingress_root}"
      && ! -L "${ingress_root}"
      && "$(stat -f -c '%T' "${ingress_root}")" = "tmpfs"
      && "$(stat -c '%u' "${ingress_root}")" = "$(id -u)"
      && "$(stat -c '%a' "${ingress_root}")" = "700"
    ]]
  }

  ingress_handoff_is_valid() {
    local handoff_identity=""
    local handoff_pid=""
    local expected_start_ticks=""
    local expected_session_id=""
    local expected_process_group_id=""
    local handoff_uid=""
    local actual_start_ticks=""
    local handoff_session_id=""
    local handoff_process_group_id=""
    if [[
      ! -f "${ingress_handoff}"
      || -L "${ingress_handoff}"
      || "$(stat -c '%u' "${ingress_handoff}")" != "$(id -u)"
      || "$(stat -c '%a' "${ingress_handoff}")" != "600"
      || "$(stat -c '%s' "${ingress_handoff}")" -lt 8
      || "$(stat -c '%s' "${ingress_handoff}")" -gt 128
    ]]; then
      return 1
    fi
    handoff_identity="$(< "${ingress_handoff}")"
    if [[ ! "${handoff_identity}" =~ ^([1-9][0-9]*):([1-9][0-9]*):([1-9][0-9]*):([1-9][0-9]*)$ ]]; then
      return 1
    fi
    handoff_pid="${BASH_REMATCH[1]}"
    expected_start_ticks="${BASH_REMATCH[2]}"
    expected_session_id="${BASH_REMATCH[3]}"
    expected_process_group_id="${BASH_REMATCH[4]}"
    if [[
      ! -r "/proc/${handoff_pid}/status"
      || ! -r "/proc/${handoff_pid}/stat"
    ]]; then
      return 1
    fi
    handoff_uid="$(awk '/^Uid:/ {print $2; exit}' "/proc/${handoff_pid}/status")"
    actual_start_ticks="$(awk '{print $22}' "/proc/${handoff_pid}/stat")"
    handoff_session_id="$(ps -o sid= -p "${handoff_pid}" | tr -d '[:space:]')"
    handoff_process_group_id="$(
      ps -o pgid= -p "${handoff_pid}" | tr -d '[:space:]'
    )"
    [[
      "${handoff_uid}" = "$(id -u)"
      && "${actual_start_ticks}" = "${expected_start_ticks}"
      && "${handoff_session_id}" = "${expected_session_id}"
      && "${handoff_process_group_id}" = "${expected_process_group_id}"
      && "${expected_session_id}" = "${handoff_pid}"
      && "${expected_process_group_id}" = "${handoff_pid}"
    ]]
  }

  cleanup_ingress_run() {
    local cleanup_paths=(
      "${ingress_root}/target.json"
      "${ingress_root}/target.json.tmp-${RUN_KEY}"
      "${ingress_root}/development.env"
      "${ingress_root}/development.env.incoming-${RUN_KEY}"
      "${ingress_root}/development.env.tmp-${RUN_KEY}"
      "${ingress_root}/artifact.json"
      "${ingress_root}/artifact.json.tmp-${RUN_KEY}"
      "${ingress_root}/approval-request.age"
      "${ingress_root}/approval-request.age.tmp-${RUN_KEY}"
      "${ingress_root}/status"
      "${ingress_root}/status.tmp-${RUN_KEY}"
      "${ingress_root}/safe-category"
      "${ingress_root}/safe-category.tmp-${RUN_KEY}"
      "${ingress_root}/validated"
      "${ingress_root}/validated.tmp-${RUN_KEY}"
      "${ingress_root}/approval-ciphertext-validated"
      "${ingress_root}/approval-ciphertext-validated.tmp-${RUN_KEY}"
      "${ingress_root}/guardian-started"
      "${ingress_root}/guardian-started.tmp-${RUN_KEY}"
      "${ingress_root}/ingress-janitor-started"
      "${ingress_root}/ingress-janitor-started.tmp-${RUN_KEY}"
      "${ingress_root}/janitor-started"
      "${ingress_root}/janitor-started.tmp-${RUN_KEY}"
      "${ingress_root}/container-id"
      "${ingress_root}/container-id.tmp-${RUN_KEY}"
      "${ingress_root}/workflow-ack"
      "${ingress_root}/workflow-ack.tmp-${RUN_KEY}"
      "${ingress_root}/guardian.sh"
      "${ingress_root}/guardian.log"
    )
    local status=1
    local candidate=""
    local _attempt=""
    for _attempt in $(seq 1 30); do
      if [[ ! -e "${ingress_root}" && ! -L "${ingress_root}" ]]; then
        return 0
      fi
      if ingress_handoff_is_valid; then
        ingress_handed_off=1
        return 0
      fi
      if ! ingress_root_is_private; then
        return 1
      fi
      status=0
      rm -f -- "${cleanup_paths[@]}" || status=1
      for candidate in "${cleanup_paths[@]}"; do
        if [[ -e "${candidate}" || -L "${candidate}" ]]; then
          status=1
        fi
      done
      if [[ "${status}" -eq 0 ]] && rmdir -- "${ingress_root}"; then
        return 0
      fi
      status=1
      sleep 1
    done
    return "${status}"
  }

  finish_ingress_janitor() {
    local prior_status="$?"
    trap - EXIT
    trap - HUP INT TERM
    set +e
    if [[ "${ingress_handed_off}" -ne 1 ]]; then
      cleanup_ingress_run
      if [[ "$?" -ne 0 && "${prior_status}" -eq 0 ]]; then
        prior_status=1
      fi
    fi
    set -e
    exit "${prior_status}"
  }

  trap 'exit 0' HUP INT TERM
  trap finish_ingress_janitor EXIT
  ingress_root_is_private
  test -f "${ingress_root}/guardian.sh"
  test ! -L "${ingress_root}/guardian.sh"
  test "$(stat -c '%u' "${ingress_root}/guardian.sh")" = "$(id -u)"
  test "$(stat -c '%a' "${ingress_root}/guardian.sh")" = "600"
  test ! -e "${ingress_marker}"
  test ! -L "${ingress_marker}"
  ingress_pid="$$"
  ingress_start_ticks="$(awk '{print $22}' "/proc/${ingress_pid}/stat")"
  ingress_session_id="$(ps -o sid= -p "${ingress_pid}" | tr -d '[:space:]')"
  ingress_process_group_id="$(
    ps -o pgid= -p "${ingress_pid}" | tr -d '[:space:]'
  )"
  test "${ingress_start_ticks}" -ge 1
  test "${ingress_session_id}" = "${ingress_pid}"
  test "${ingress_process_group_id}" = "${ingress_pid}"
  ingress_marker_temporary="${ingress_marker}.tmp-${RUN_KEY}"
  install -m 600 /dev/null "${ingress_marker_temporary}"
  printf '%s:%s:%s:%s\n' \
    "${ingress_pid}" \
    "${ingress_start_ticks}" \
    "${ingress_session_id}" \
    "${ingress_process_group_id}" \
    > "${ingress_marker_temporary}"
  mv -- "${ingress_marker_temporary}" "${ingress_marker}"
  chmod 600 "${ingress_marker}"

  for _attempt in $(seq 1 "${ingress_cleanup_ttl_seconds}"); do
    if [[ ! -e "${ingress_root}" && ! -L "${ingress_root}" ]]; then
      ingress_handed_off=1
      exit 0
    fi
    if ingress_handoff_is_valid; then
      ingress_handed_off=1
      exit 0
    fi
    sleep 1
  done
  exit 0
fi

if [[
  "${INGRESS_JANITOR_MODE:-0}" != "0"
  ||
  ! "${RUN_KEY:-}" =~ ${run_key_pattern}
  || ! "${EXPECTED_GIT_SHA:-}" =~ ${sha_pattern}
  || "${EXPECTED_IMAGE_TAG:-}" != "ghcr.io/dlswn666/alimtalk-proxy:${EXPECTED_GIT_SHA}"
  || ( "${MODE:-}" != "prepare" && "${MODE:-}" != "apply" )
  || ( "${JANITOR_MODE:-0}" != "0" && "${JANITOR_MODE:-0}" != "1" )
  || ! "${OWNER_AGE_RECIPIENT:-}" =~ ${recipient_pattern}
  || ! "${OWNER_AGE_RECIPIENT_SHA256:-}" =~ ^[0-9a-f]{64}$
 ]]; then
  exit 64
fi
if [[ "${JANITOR_MODE:-0}" == "1" ]]; then
  if [[
    ! "${GUARDIAN_PID:-}" =~ ^[1-9][0-9]*$
    || ! "${GUARDIAN_START_TICKS:-}" =~ ^[1-9][0-9]*$
    || ! "${GUARDIAN_SESSION_ID:-}" =~ ^[1-9][0-9]*$
  ]]; then
    exit 64
  fi
elif [[
  -n "${GUARDIAN_PID:-}"
  || -n "${GUARDIAN_START_TICKS:-}"
  || -n "${GUARDIAN_SESSION_ID:-}"
 ]]; then
  exit 64
fi
actual_recipient_sha256="$(
  printf '%s' "${OWNER_AGE_RECIPIENT}" | sha256sum | awk '{print $1}'
)"
if [[ "${actual_recipient_sha256}" != "${OWNER_AGE_RECIPIENT_SHA256}" ]]; then
  exit 64
fi

container_name="alimtalk-proxy"
application_root="${HOME}/alimtalk-proxy"
expected_development_url="https://yxypndgipnxrdfyctmvh.supabase.co"
host_root="/dev/shm/.development-api-authoritative-ldareg-backfill-${RUN_KEY}"
host_target="${host_root}/target.json"
host_credentials="${host_root}/development.env"
host_credentials_staged="${host_credentials}.incoming-${RUN_KEY}"
host_artifact="${host_root}/artifact.json"
host_approval_ciphertext="${host_root}/approval-request.age"
host_status="${host_root}/status"
host_safe_category="${host_root}/safe-category"
host_validated="${host_root}/validated"
host_approval_ciphertext_validated="${host_root}/approval-ciphertext-validated"
host_ingress_janitor_started="${host_root}/ingress-janitor-started"
host_started="${host_root}/guardian-started"
host_janitor_started="${host_root}/janitor-started"
host_container_id="${host_root}/container-id"
host_ack="${host_root}/workflow-ack"
operation_lock_path="${application_root}/.land-area-sync-operation.lock"
container_workdir="/dev/shm"
container_root="${container_workdir}/.development-api-authoritative-ldareg-backfill"
container_target="${container_root}/target-${RUN_KEY}.json"
container_credentials="${container_root}/development.env"
container_artifact="${container_root}/artifact-${RUN_KEY}.json"
container_approval_request="${container_root}/approval-request-${RUN_KEY}.json"
container_approval_ciphertext="${container_root}/approval-request-${RUN_KEY}.age"
validation_sentinel="DEVELOPMENT_API_AUTHORITATIVE_LDAREG_BACKFILL_ARTIFACT_VALIDATED"
approval_validation_sentinel="DEVELOPMENT_API_AUTHORITATIVE_LDAREG_APPROVAL_REQUEST_VALIDATED"
approval_ciphertext_sentinel="DEVELOPMENT_API_AUTHORITATIVE_LDAREG_OWNER_CIPHERTEXT_VALIDATED"
ack_value="ACK:${RUN_KEY}:${EXPECTED_GIT_SHA}:${MODE}"
# GitHub job timeout은 65분이다. 이 값은 환경변수로 늘릴 수 없는 절대 상한이다.
absolute_cleanup_ttl_seconds=4500
export_cleanup_ttl_seconds=300
runner_timeout_seconds=3000
runner_client_timeout_seconds=3030
max_runner_start_elapsed_seconds=950
post_runner_cleanup_budget_seconds=500
docker_command_timeout_seconds=30
if ((
  max_runner_start_elapsed_seconds
  + runner_client_timeout_seconds
  + post_runner_cleanup_budget_seconds
  > absolute_cleanup_ttl_seconds
)); then
  exit 64
fi
target_container=""
lock_acquired=0
final_status=90
janitor_started_at_seconds=0

run_docker_bounded() {
  timeout -k 5 "${docker_command_timeout_seconds}" docker "$@"
}

write_private_line() {
  local target="$1"
  local value="$2"
  local temporary="${target}.tmp-${RUN_KEY}"
  install -m 600 /dev/null "${temporary}"
  printf '%s\n' "${value}" > "${temporary}"
  mv -f -- "${temporary}" "${target}"
  chmod 600 "${target}"
}

verify_absent() {
  local candidate
  for candidate in "$@"; do
    if [[ -e "${candidate}" || -L "${candidate}" ]]; then
      return 1
    fi
  done
}

credentials_are_valid() {
  local credential_lines=()
  local development_service_role_key=""
  local expected_size=0
  if [[
    ! -f "${host_credentials}"
    || -L "${host_credentials}"
    || "$(stat -c '%u' "${host_credentials}")" != "$(id -u)"
    || "$(stat -c '%a' "${host_credentials}")" != "600"
    || "$(stat -f -c '%T' "${host_credentials}")" != "tmpfs"
    || "$(wc -l < "${host_credentials}")" != "2"
  ]]; then
    return 1
  fi
  mapfile -t credential_lines < "${host_credentials}"
  if [[
    ${#credential_lines[@]} -ne 2
    || "${credential_lines[0]}" != "DEV_SUPABASE_URL=${expected_development_url}"
    || "${credential_lines[1]}" != DEV_SUPABASE_SERVICE_ROLE_KEY=*
  ]]; then
    return 1
  fi
  development_service_role_key="${credential_lines[1]#DEV_SUPABASE_SERVICE_ROLE_KEY=}"
  if [[
    ${#development_service_role_key} -lt 32
    || ${#development_service_role_key} -gt 4096
    || "${development_service_role_key}" =~ [[:space:]]
    || ! "${development_service_role_key}" =~ ^[A-Za-z0-9._-]+$
  ]]; then
    return 1
  fi
  expected_size=$((
    ${#credential_lines[0]} + 1
    + ${#credential_lines[1]} + 1
  ))
  [[ "$(stat -c '%s' "${host_credentials}")" = "${expected_size}" ]]
}

safe_category_for_status() {
  case "$1" in
    0)
      printf '%s\n' "PASS"
      ;;
    1)
      printf '%s\n' "GATE_REJECTED"
      ;;
    2)
      printf '%s\n' "CLI_BOUNDARY_REJECTED"
      ;;
    69)
      printf '%s\n' "RUNNER_START_DEADLINE_EXCEEDED"
      ;;
    90)
      printf '%s\n' "GUARDIAN_OR_CLEANUP_FAILED"
      ;;
    92)
      printf '%s\n' "ARTIFACT_VALIDATION_REJECTED"
      ;;
    93)
      printf '%s\n' "CONTAINER_ID_CHANGED"
      ;;
    94)
      printf '%s\n' "APPROVAL_REQUEST_VALIDATION_REJECTED"
      ;;
    95)
      printf '%s\n' "MODE_OUTPUT_REJECTED"
      ;;
    96)
      printf '%s\n' "APPROVAL_ENCRYPTION_FAILED"
      ;;
    124)
      printf '%s\n' "RUNNER_TIMEOUT"
      ;;
    137)
      printf '%s\n' "RUNNER_TERMINATED"
      ;;
    *)
      return 1
      ;;
  esac
}

ingress_janitor_is_active() {
  local ingress_identity=""
  local ingress_pid=""
  local expected_start_ticks=""
  local expected_session_id=""
  local expected_process_group_id=""
  local ingress_uid=""
  local actual_start_ticks=""
  local ingress_session_id=""
  local ingress_process_group_id=""
  if [[
    ! -f "${host_ingress_janitor_started}"
    || -L "${host_ingress_janitor_started}"
    || "$(stat -c '%u' "${host_ingress_janitor_started}")" != "$(id -u)"
    || "$(stat -c '%a' "${host_ingress_janitor_started}")" != "600"
    || "$(stat -c '%s' "${host_ingress_janitor_started}")" -lt 8
    || "$(stat -c '%s' "${host_ingress_janitor_started}")" -gt 128
  ]]; then
    return 1
  fi
  ingress_identity="$(< "${host_ingress_janitor_started}")"
  if [[ ! "${ingress_identity}" =~ ^([1-9][0-9]*):([1-9][0-9]*):([1-9][0-9]*):([1-9][0-9]*)$ ]]; then
    return 1
  fi
  ingress_pid="${BASH_REMATCH[1]}"
  expected_start_ticks="${BASH_REMATCH[2]}"
  expected_session_id="${BASH_REMATCH[3]}"
  expected_process_group_id="${BASH_REMATCH[4]}"
  if [[
    ! -r "/proc/${ingress_pid}/status"
    || ! -r "/proc/${ingress_pid}/stat"
  ]]; then
    return 1
  fi
  ingress_uid="$(awk '/^Uid:/ {print $2; exit}' "/proc/${ingress_pid}/status")"
  actual_start_ticks="$(awk '{print $22}' "/proc/${ingress_pid}/stat")"
  ingress_session_id="$(ps -o sid= -p "${ingress_pid}" | tr -d '[:space:]')"
  ingress_process_group_id="$(
    ps -o pgid= -p "${ingress_pid}" | tr -d '[:space:]'
  )"
  [[
    "${ingress_uid}" = "$(id -u)"
    && "${actual_start_ticks}" = "${expected_start_ticks}"
    && "${ingress_session_id}" = "${expected_session_id}"
    && "${ingress_process_group_id}" = "${expected_process_group_id}"
    && "${expected_session_id}" = "${ingress_pid}"
    && "${expected_process_group_id}" = "${ingress_pid}"
  ]]
}

host_root_is_private() {
  [[
    -d "${host_root}"
    && ! -L "${host_root}"
    && "$(stat -f -c '%T' "${host_root}")" = "tmpfs"
    && "$(stat -c '%u' "${host_root}")" = "$(id -u)"
    && "$(stat -c '%a' "${host_root}")" = "700"
  ]]
}

ack_is_valid() {
  local expected_size=$(( ${#ack_value} + 1 ))
  [[
    -f "${host_ack}"
    && ! -L "${host_ack}"
    && "$(stat -c '%u' "${host_ack}")" = "$(id -u)"
    && "$(stat -c '%a' "${host_ack}")" = "600"
    && "$(stat -c '%s' "${host_ack}")" = "${expected_size}"
    && "$(< "${host_ack}")" = "${ack_value}"
  ]]
}

load_target_container_marker() {
  if [[ -e "${host_container_id}" || -L "${host_container_id}" ]]; then
    local marker_container
    if [[
      ! -f "${host_container_id}"
      || -L "${host_container_id}"
      || "$(stat -c '%u' "${host_container_id}")" != "$(id -u)"
      || "$(stat -c '%a' "${host_container_id}")" != "600"
      || "$(stat -c '%s' "${host_container_id}")" != "65"
    ]]; then
      return 1
    fi
    marker_container="$(< "${host_container_id}")"
    if [[
      ! "${marker_container}" =~ ^[0-9a-f]{64}$
      || ( -n "${target_container}" && "${target_container}" != "${marker_container}" )
    ]]; then
      return 1
    fi
    target_container="${marker_container}"
  fi
}

cleanup_container_files() {
  local status=0
  load_target_container_marker || return 1
  if [[ -z "${target_container}" ]]; then
    return 0
  fi
  if ! run_docker_bounded exec "${target_container}" rm -f -- \
      "${container_target}" \
      "${container_credentials}" \
      "${container_artifact}" \
      "${container_approval_request}" \
      "${container_approval_ciphertext}"
  then
    status=1
  fi
  if ! run_docker_bounded exec "${target_container}" test ! -e "${container_target}"; then
    status=1
  fi
  if ! run_docker_bounded exec "${target_container}" test ! -e "${container_credentials}"; then
    status=1
  fi
  if ! run_docker_bounded exec "${target_container}" test ! -e "${container_artifact}"; then
    status=1
  fi
  if ! run_docker_bounded exec "${target_container}" test ! -e "${container_approval_request}"; then
    status=1
  fi
  if ! run_docker_bounded exec "${target_container}" test ! -e "${container_approval_ciphertext}"; then
    status=1
  fi
  return "${status}"
}

cleanup_host_input() {
  local status=0
  if ! rm -f -- \
      "${host_target}" \
      "${host_credentials}" \
      "${host_credentials_staged}"
  then
    status=1
  fi
  if ! verify_absent \
      "${host_target}" \
      "${host_credentials}" \
      "${host_credentials_staged}"
  then
    status=1
  fi
  return "${status}"
}

cleanup_host_credentials() {
  local status=0
  if ! rm -f -- "${host_credentials}" "${host_credentials_staged}"; then
    status=1
  fi
  if ! verify_absent "${host_credentials}" "${host_credentials_staged}"; then
    status=1
  fi
  return "${status}"
}

cleanup_host_run() {
  if [[ ! -e "${host_root}" && ! -L "${host_root}" ]]; then
    return 0
  fi
  if ! host_root_is_private; then
    return 1
  fi

  local status=0
  if ! rm -f -- \
      "${host_target}" \
      "${host_target}.tmp-${RUN_KEY}" \
      "${host_credentials}" \
      "${host_credentials_staged}" \
      "${host_credentials}.tmp-${RUN_KEY}" \
      "${host_artifact}" \
      "${host_artifact}.tmp-${RUN_KEY}" \
      "${host_approval_ciphertext}" \
      "${host_approval_ciphertext}.tmp-${RUN_KEY}" \
      "${host_status}" \
      "${host_status}.tmp-${RUN_KEY}" \
      "${host_safe_category}" \
      "${host_safe_category}.tmp-${RUN_KEY}" \
      "${host_validated}" \
      "${host_validated}.tmp-${RUN_KEY}" \
      "${host_approval_ciphertext_validated}" \
      "${host_approval_ciphertext_validated}.tmp-${RUN_KEY}" \
      "${host_ingress_janitor_started}" \
      "${host_ingress_janitor_started}.tmp-${RUN_KEY}" \
      "${host_started}" \
      "${host_started}.tmp-${RUN_KEY}" \
      "${host_janitor_started}" \
      "${host_janitor_started}.tmp-${RUN_KEY}" \
      "${host_container_id}" \
      "${host_container_id}.tmp-${RUN_KEY}" \
      "${host_ack}" \
      "${host_ack}.tmp-${RUN_KEY}" \
      "${host_root}/guardian.sh" \
      "${host_root}/guardian.log"
  then
    status=1
  fi
  if ! verify_absent \
      "${host_target}" \
      "${host_credentials}" \
      "${host_credentials_staged}" \
      "${host_artifact}" \
      "${host_approval_ciphertext}" \
      "${host_status}" \
      "${host_safe_category}" \
      "${host_validated}" \
      "${host_approval_ciphertext_validated}" \
      "${host_ingress_janitor_started}" \
      "${host_started}" \
      "${host_janitor_started}" \
      "${host_container_id}" \
      "${host_ack}" \
      "${host_root}/guardian.sh" \
      "${host_root}/guardian.log"
  then
    status=1
  fi
  if [[ "${status}" -eq 0 ]] && ! rmdir -- "${host_root}"; then
    status=1
  fi
  return "${status}"
}

guardian_identity_is_active() {
  local guardian_pid="${GUARDIAN_PID:-}"
  local expected_ticks="${GUARDIAN_START_TICKS:-}"
  local expected_session_id="${GUARDIAN_SESSION_ID:-}"
  if [[
    ! "${guardian_pid}" =~ ^[1-9][0-9]*$
    || ! "${expected_ticks}" =~ ^[1-9][0-9]*$
    || ! "${expected_session_id}" =~ ^[1-9][0-9]*$
    || ! -r "/proc/${guardian_pid}/stat"
    || ! -r "/proc/${guardian_pid}/status"
  ]]; then
    return 1
  fi
  local actual_ticks actual_uid actual_sid actual_process_group_id
  actual_ticks="$(awk '{print $22}' "/proc/${guardian_pid}/stat")"
  actual_uid="$(awk '/^Uid:/ {print $2; exit}' "/proc/${guardian_pid}/status")"
  actual_sid="$(ps -o sid= -p "${guardian_pid}" | tr -d '[:space:]')"
  actual_process_group_id="$(
    ps -o pgid= -p "${guardian_pid}" | tr -d '[:space:]'
  )"
  [[
    "${actual_ticks}" = "${expected_ticks}"
    && "${actual_uid}" = "$(id -u)"
    && "${actual_sid}" = "${expected_session_id}"
    && "${actual_process_group_id}" = "${expected_session_id}"
  ]]
}

cleanup_exact_with_retries() {
  local status=1
  local _attempt
  for _attempt in $(seq 1 30); do
    status=0
    load_target_container_marker >/dev/null 2>&1 || status=1
    cleanup_host_run >/dev/null 2>&1 || status=1
    cleanup_container_files >/dev/null 2>&1 || status=1
    if [[ "${status}" -eq 0 ]]; then
      return 0
    fi
    sleep 1
  done
  return "${status}"
}

terminate_guardian_at_absolute_deadline() {
  if ! guardian_identity_is_active; then
    return 0
  fi
  local guardian_session_id="${GUARDIAN_SESSION_ID}"
  kill -TERM -- "-${guardian_session_id}" 2>/dev/null || return 1
  local _attempt
  for _attempt in $(seq 1 5); do
    if ! guardian_identity_is_active; then
      return 0
    fi
    sleep 1
  done
  if guardian_identity_is_active; then
    kill -KILL -- "-${guardian_session_id}" 2>/dev/null || return 1
  fi
}

run_cleanup_janitor() {
  local deadline=$(( SECONDS + absolute_cleanup_ttl_seconds ))
  local acknowledged=0
  local cleanup_status=0

  while (( SECONDS < deadline )); do
    if ack_is_valid; then
      acknowledged=1
    fi
    if ! guardian_identity_is_active; then
      cleanup_exact_with_retries
      return "$?"
    fi
    if [[ ! -e "${host_root}" && ! -L "${host_root}" ]]; then
      # workflow가 guardian-started 전 오류를 정리한 경우도 감시를 계속한다.
      acknowledged=1
    fi
    if [[ "${acknowledged}" -eq 1 ]]; then
      cleanup_status=0
      load_target_container_marker >/dev/null 2>&1 || cleanup_status=1
      cleanup_host_run >/dev/null 2>&1 || cleanup_status=1
      cleanup_container_files >/dev/null 2>&1 || cleanup_status=1
    fi
    sleep 1
  done

  # 정확한 PID, 시작 tick, UID, session ID가 모두 일치할 때만 이 run을 종료한다.
  terminate_guardian_at_absolute_deadline || cleanup_status=1
  cleanup_exact_with_retries || cleanup_status=1
  return "${cleanup_status}"
}

start_cleanup_janitor() {
  local guardian_start_ticks guardian_session_id guardian_process_group_id
  guardian_start_ticks="$(awk '{print $22}' "/proc/$$/stat")"
  guardian_session_id="$(ps -o sid= -p "$$" | tr -d '[:space:]')"
  guardian_process_group_id="$(
    ps -o pgid= -p "$$" | tr -d '[:space:]'
  )"
  if [[
    ! "${guardian_start_ticks}" =~ ^[1-9][0-9]*$
    || ! "${guardian_session_id}" =~ ^[1-9][0-9]*$
    || "${guardian_process_group_id}" != "${guardian_session_id}"
  ]]; then
    return 1
  fi
  nohup setsid env -i \
    HOME="${HOME}" \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    JANITOR_MODE=1 \
    RUN_KEY="${RUN_KEY}" \
    EXPECTED_GIT_SHA="${EXPECTED_GIT_SHA}" \
    EXPECTED_IMAGE_TAG="${EXPECTED_IMAGE_TAG}" \
    MODE="${MODE}" \
    OWNER_AGE_RECIPIENT="${OWNER_AGE_RECIPIENT}" \
    OWNER_AGE_RECIPIENT_SHA256="${OWNER_AGE_RECIPIENT_SHA256}" \
    GUARDIAN_PID="$$" \
    GUARDIAN_START_TICKS="${guardian_start_ticks}" \
    GUARDIAN_SESSION_ID="${guardian_session_id}" \
    bash "${host_root}/guardian.sh" \
    >/dev/null 2>&1 < /dev/null &
  local janitor_pid="$!"
  local janitor_start_ticks janitor_uid janitor_session_id
  local janitor_process_group_id
  local janitor_identity_ready=0
  if [[ ! "${janitor_pid}" =~ ^[1-9][0-9]*$ ]]; then
    return 1
  fi
  for _attempt in $(seq 1 50); do
    if [[
      -r "/proc/${janitor_pid}/stat"
      && -r "/proc/${janitor_pid}/status"
    ]]; then
      janitor_start_ticks="$(awk '{print $22}' "/proc/${janitor_pid}/stat")"
      janitor_uid="$(awk '/^Uid:/ {print $2; exit}' "/proc/${janitor_pid}/status")"
      janitor_session_id="$(
        ps -o sid= -p "${janitor_pid}" | tr -d '[:space:]'
      )"
      janitor_process_group_id="$(
        ps -o pgid= -p "${janitor_pid}" | tr -d '[:space:]'
      )"
      if [[
        "${janitor_start_ticks}" =~ ^[1-9][0-9]*$
        && "${janitor_uid}" = "$(id -u)"
        && "${janitor_session_id}" = "${janitor_pid}"
        && "${janitor_process_group_id}" = "${janitor_pid}"
      ]]; then
        janitor_identity_ready=1
        break
      fi
    fi
    sleep 0.1
  done
  if [[ "${janitor_identity_ready}" -ne 1 ]]; then
    return 1
  fi
  write_private_line \
    "${host_janitor_started}" \
    "${janitor_pid}:${janitor_start_ticks}:${janitor_session_id}:${janitor_process_group_id}"
  kill -0 "${janitor_pid}"
}

wait_for_workflow_ack() {
  local _attempt
  for _attempt in $(seq 1 "${export_cleanup_ttl_seconds}"); do
    if [[ ! -e "${host_root}" && ! -L "${host_root}" ]]; then
      return 0
    fi
    if ack_is_valid; then
      return 0
    fi
    sleep 1
  done
  return 0
}

finish_guardian() {
  local prior_status="$?"
  trap - EXIT
  set +e
  local cleanup_status=0
  cleanup_container_files || cleanup_status=1
  cleanup_host_input || cleanup_status=1
  if [[ "${lock_acquired}" -eq 1 ]]; then
    flock -u 8 || cleanup_status=1
    exec 8>&-
    lock_acquired=0
  fi
  if [[ "${prior_status}" -ne 0 || "${cleanup_status}" -ne 0 ]]; then
    final_status=90
  fi
  local status_write=0
  local safe_category=""
  if ! safe_category="$(safe_category_for_status "${final_status}")"; then
    final_status=90
    safe_category="$(safe_category_for_status "${final_status}")"
  fi
  if host_root_is_private; then
    write_private_line "${host_safe_category}" "${safe_category}" || status_write=1
    write_private_line "${host_status}" "${final_status}" || status_write=1
  else
    status_write=1
  fi
  if [[
    "${status_write}" -eq 0
    && -f "${host_janitor_started}"
    && ! -L "${host_janitor_started}"
  ]]; then
    wait_for_workflow_ack
  fi
  cleanup_host_run || cleanup_status=1
  set -e
  if [[ "${status_write}" -ne 0 || "${cleanup_status}" -ne 0 ]]; then
    exit 91
  fi
  exit 0
}

if [[ "${JANITOR_MODE:-0}" == "1" ]]; then
  run_cleanup_janitor
  exit "$?"
fi

# SSH 연결이나 workflow 취소와 분리해 동일 syncJobId replay 및 cleanup까지 마친다.
trap ':' HUP INT TERM
trap finish_guardian EXIT

test -d "${host_root}"
test ! -L "${host_root}"
test "$(stat -f -c '%T' "${host_root}")" = "tmpfs"
test "$(stat -c '%u' "${host_root}")" = "$(id -u)"
test "$(stat -c '%a' "${host_root}")" = "700"
test -f "${host_target}"
test ! -L "${host_target}"
test "$(stat -c '%u' "${host_target}")" = "$(id -u)"
test "$(stat -c '%a' "${host_target}")" = "600"
target_size="$(stat -c '%s' "${host_target}")"
test "${target_size}" -ge 2
test "${target_size}" -le 262144
credentials_are_valid
ingress_janitor_is_active
verify_absent \
  "${host_credentials_staged}" \
  "${host_artifact}" \
  "${host_approval_ciphertext}" \
  "${host_status}" \
  "${host_safe_category}" \
  "${host_validated}" \
  "${host_approval_ciphertext_validated}" \
  "${host_started}" \
  "${host_janitor_started}" \
  "${host_container_id}" \
  "${host_ack}"
command -v docker >/dev/null
command -v timeout >/dev/null
janitor_started_at_seconds="${SECONDS}"
start_cleanup_janitor
write_private_line "${host_started}" "$$"

if [[ ! -e "${operation_lock_path}" && ! -L "${operation_lock_path}" ]]; then
  if ! (
    umask 077
    set -o noclobber
    : > "${operation_lock_path}"
  ) 2>/dev/null; then
    test -f "${operation_lock_path}"
    test ! -L "${operation_lock_path}"
  fi
fi
if [[
  ! -f "${operation_lock_path}"
  || -L "${operation_lock_path}"
  || "$(stat -c '%u' "${operation_lock_path}")" != "$(id -u)"
 ]]; then
  exit 65
fi
chmod 600 "${operation_lock_path}"
exec 8>>"${operation_lock_path}"
if ! flock -w 900 8; then
  exit 66
fi
lock_acquired=1

# lock 대기 중 취소/변조 뒤 실행하지 않도록 private target을 다시 검사한다.
test -d "${host_root}"
test ! -L "${host_root}"
test "$(stat -f -c '%T' "${host_root}")" = "tmpfs"
test "$(stat -c '%u' "${host_root}")" = "$(id -u)"
test "$(stat -c '%a' "${host_root}")" = "700"
test -f "${host_target}"
test ! -L "${host_target}"
test "$(stat -c '%u' "${host_target}")" = "$(id -u)"
test "$(stat -c '%a' "${host_target}")" = "600"
target_size="$(stat -c '%s' "${host_target}")"
test "${target_size}" -ge 2
test "${target_size}" -le 262144
credentials_are_valid
verify_absent \
  "${host_credentials_staged}" \
  "${host_artifact}" \
  "${host_approval_ciphertext}" \
  "${host_status}" \
  "${host_safe_category}" \
  "${host_validated}" \
  "${host_approval_ciphertext_validated}" \
  "${host_container_id}" \
  "${host_ack}"

target_container="$(run_docker_bounded inspect --format '{{.Id}}' "${container_name}")"
target_image_id="$(run_docker_bounded inspect --format '{{.Image}}' "${container_name}")"
target_revision="$(
  run_docker_bounded image inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "${target_image_id}"
)"
target_age_version="$(run_docker_bounded exec "${target_container}" age --version)"
if [[
  ! "${target_container}" =~ ^[0-9a-f]{64}$
  || ! "${target_image_id}" =~ ^sha256:[0-9a-f]{64}$
  || "${target_revision}" != "${EXPECTED_GIT_SHA}"
  || "${target_age_version}" != "v1.3.1"
 ]]; then
  exit 67
fi
write_private_line "${host_container_id}" "${target_container}"

verify_health() {
  run_docker_bounded exec \
    -e "EXPECTED_GIT_SHA=${EXPECTED_GIT_SHA}" \
    -e "EXPECTED_IMAGE_TAG=${EXPECTED_IMAGE_TAG}" \
    "${target_container}" \
    node -e '
      const http = require("node:http");
      const reject = () => process.exit(1);
      const request = http.get(
        "http://127.0.0.1:3100/health",
        { timeout: 5000 },
        (response) => {
          if (response.statusCode !== 200) return reject();
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
            if (body.length > 65536) request.destroy();
          });
          response.on("end", () => {
            try {
              const health = JSON.parse(body);
              if (
                health?.status !== "ok"
                || health?.gitSha !== process.env.EXPECTED_GIT_SHA
                || health?.imageTag !== process.env.EXPECTED_IMAGE_TAG
                || health?.features?.landAreaSyncEnabled !== false
                || health?.features?.landAreaSyncAllowedTargetCount !== 0
                || health?.features?.landAreaSyncAllowedTargetsDigest !== ""
              ) return reject();
              process.exit(0);
            } catch {
              reject();
            }
          });
        }
      );
      request.on("timeout", () => request.destroy());
      request.on("error", reject);
    '
}

verify_development_credentials_absent_from_container() {
  run_docker_bounded exec "${target_container}" sh -eu -c '
    test -z "${DEV_SUPABASE_URL+x}"
    test -z "${DEV_SUPABASE_SERVICE_ROLE_KEY+x}"
  ' >/dev/null 2>&1
}

stream_target() {
  run_docker_bounded exec -i \
    -e "PRIVATE_INPUT_PATH=${container_target}" \
    "${target_container}" \
    node -e '
      const fs = require("node:fs");
      const target = process.env.PRIVATE_INPUT_PATH ?? "";
      if (!/^\/dev\/shm\/\.development-api-authoritative-ldareg-backfill\/target-[0-9]+-[0-9]+\.json$/.test(target)) {
        process.exit(1);
      }
      const chunks = [];
      let size = 0;
      process.stdin.on("data", (chunk) => {
        size += chunk.length;
        if (size > 262144) process.exit(1);
        chunks.push(chunk);
      });
      process.stdin.on("end", () => {
        if (size < 2) process.exit(1);
        fs.writeFileSync(target, Buffer.concat(chunks), {
          flag: "wx",
          mode: 0o600,
        });
      });
      process.stdin.on("error", () => process.exit(1));
    ' < "${host_target}"
}

verify_health
verify_development_credentials_absent_from_container
run_docker_bounded exec \
  -e "PRIVATE_ROOT=${container_root}" \
  "${target_container}" \
  sh -eu -c '
    test "$(stat -f -c "%T" /dev/shm)" = "tmpfs"
    install -d -m 700 "${PRIVATE_ROOT}"
    test ! -L "${PRIVATE_ROOT}"
    test "$(stat -c "%a" "${PRIVATE_ROOT}")" = "700"
  '
stream_target
run_docker_bounded exec "${target_container}" test ! -e "${container_credentials}"

runner_start_elapsed_seconds=$(( SECONDS - janitor_started_at_seconds ))
if ((
  runner_start_elapsed_seconds < 0
  || runner_start_elapsed_seconds >= max_runner_start_elapsed_seconds
)); then
  final_status=69
  exit 0
fi

set +e
timeout -k 15 "${runner_client_timeout_seconds}" \
docker exec \
  --env-file "${host_credentials}" \
  -w "${container_workdir}" \
  "${target_container}" \
  timeout -k 10 "${runner_timeout_seconds}" \
  node /app/dist/cli/development-api-authoritative-ldareg-backfill.js \
  --mode "${MODE}" \
  --target ".development-api-authoritative-ldareg-backfill/target-${RUN_KEY}.json" \
  --source-release-sha "${EXPECTED_GIT_SHA}" \
  --out ".development-api-authoritative-ldareg-backfill/artifact-${RUN_KEY}.json" \
  --approval-request-out ".development-api-authoritative-ldareg-backfill/approval-request-${RUN_KEY}.json" \
  >/dev/null 2>&1
runner_status="$?"
set -e
case "${runner_status}" in
  0|1|2|124|137)
    final_status="${runner_status}"
    ;;
  *)
    final_status=90
    ;;
esac
credential_cleanup_status=0
cleanup_host_credentials || credential_cleanup_status=1
verify_development_credentials_absent_from_container || credential_cleanup_status=1
if [[ "${credential_cleanup_status}" -ne 0 ]]; then
  final_status=90
fi

if [[
  "${credential_cleanup_status}" -eq 0
  && ( "${runner_status}" -eq 0 || "${runner_status}" -eq 1 )
 ]]; then
  validation_output="$(
    run_docker_bounded exec -w "${container_workdir}" "${target_container}" \
      node /app/dist/cli/development-api-authoritative-ldareg-backfill-validate.js \
      --target ".development-api-authoritative-ldareg-backfill/target-${RUN_KEY}.json" \
      --artifact ".development-api-authoritative-ldareg-backfill/artifact-${RUN_KEY}.json" \
      --source-release-sha "${EXPECTED_GIT_SHA}"
  )"
  if [[ "${validation_output}" != "${validation_sentinel}" ]]; then
    final_status=92
  else
    verify_health
    container_after="$(run_docker_bounded inspect --format '{{.Id}}' "${container_name}")"
    if [[ "${container_after}" != "${target_container}" ]]; then
      final_status=93
    else
      mode_output_valid=1
      if [[ "${MODE}" == "prepare" && "${runner_status}" -eq 0 ]]; then
        approval_validation_output="$(
          run_docker_bounded exec -w "${container_workdir}" "${target_container}" \
            node /app/dist/cli/development-api-authoritative-ldareg-backfill-approval-request-validate.js \
            --target ".development-api-authoritative-ldareg-backfill/target-${RUN_KEY}.json" \
            --artifact ".development-api-authoritative-ldareg-backfill/artifact-${RUN_KEY}.json" \
            --request ".development-api-authoritative-ldareg-backfill/approval-request-${RUN_KEY}.json" \
            --source-release-sha "${EXPECTED_GIT_SHA}"
        )"
        if [[ "${approval_validation_output}" != "${approval_validation_sentinel}" ]]; then
          mode_output_valid=0
          final_status=94
        else
          if ! run_docker_bounded exec \
              -e "OWNER_AGE_RECIPIENT=${OWNER_AGE_RECIPIENT}" \
              -e "PRIVATE_REQUEST=${container_approval_request}" \
              -e "PRIVATE_CIPHERTEXT=${container_approval_ciphertext}" \
              "${target_container}" \
              sh -eu -c '
                umask 077
                test -f "${PRIVATE_REQUEST}"
                test ! -L "${PRIVATE_REQUEST}"
                test "$(stat -c "%a" "${PRIVATE_REQUEST}")" = "600"
                test ! -e "${PRIVATE_CIPHERTEXT}"
                test ! -L "${PRIVATE_CIPHERTEXT}"
                age --encrypt --armor \
                  --recipient "${OWNER_AGE_RECIPIENT}" \
                  --output "${PRIVATE_CIPHERTEXT}" \
                  "${PRIVATE_REQUEST}"
                chmod 600 "${PRIVATE_CIPHERTEXT}"
                rm -f -- "${PRIVATE_REQUEST}"
                test ! -e "${PRIVATE_REQUEST}"
                test -s "${PRIVATE_CIPHERTEXT}"
                test "$(head -n 1 "${PRIVATE_CIPHERTEXT}")" = \
                  "-----BEGIN AGE ENCRYPTED FILE-----"
              '
          then
            mode_output_valid=0
            final_status=96
          fi
        fi
      else
        if ! run_docker_bounded exec "${target_container}" test \
            ! -e "${container_approval_request}" \
            -a ! -e "${container_approval_ciphertext}"
        then
          mode_output_valid=0
          final_status=95
        fi
      fi
      if [[ "${mode_output_valid}" -eq 1 ]]; then
        run_docker_bounded cp "${target_container}:${container_artifact}" "${host_artifact}"
        chmod 600 "${host_artifact}"
        artifact_sha="$(sha256sum "${host_artifact}" | awk '{print $1}')"
        write_private_line \
          "${host_validated}" \
          "${validation_sentinel}:${artifact_sha}"
        if [[ "${MODE}" == "prepare" && "${runner_status}" -eq 0 ]]; then
          run_docker_bounded cp \
            "${target_container}:${container_approval_ciphertext}" \
            "${host_approval_ciphertext}"
          chmod 600 "${host_approval_ciphertext}"
          approval_ciphertext_sha="$(
            sha256sum "${host_approval_ciphertext}" | awk '{print $1}'
          )"
          write_private_line \
            "${host_approval_ciphertext_validated}" \
            "${approval_ciphertext_sentinel}:${OWNER_AGE_RECIPIENT_SHA256}:${approval_ciphertext_sha}"
        fi
      fi
    fi
  fi
fi

exit 0
