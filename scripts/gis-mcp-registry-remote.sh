#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() {
  printf '%s\n' "$1" >&2
  exit "${2:-64}"
}

for name in REGISTRY_OPERATION REGISTRY_OPERATION_ID \
  REGISTRY_EXPECTED_SCRIPT_SHA256 REGISTRY_RUN_ID REGISTRY_RUN_ATTEMPT; do
  [[ -n "${!name:-}" ]] || fail "Required operation metadata is missing."
done
protocol_action="${REGISTRY_PROTOCOL_ACTION:-operate}"
[[ "${protocol_action}" =~ ^(operate|ack)$ ]] || fail "Invalid protocol action."
[[ "${REGISTRY_OPERATION}" =~ ^(validate|list|add|revoke|recover)$ ]] || fail "Invalid operation."
if [[ "${protocol_action}" == "ack" \
  && ( "${REGISTRY_OPERATION}" != "add" && "${REGISTRY_OPERATION}" != "revoke" ) ]]; then
  fail "ACK is allowed only for add/revoke outcomes."
fi
[[ "${#REGISTRY_OPERATION_ID}" -ge 8 && "${#REGISTRY_OPERATION_ID}" -le 64 ]] \
  && [[ "${REGISTRY_OPERATION_ID}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] \
  || fail "Invalid operation ID."
[[ "${REGISTRY_EXPECTED_SCRIPT_SHA256}" =~ ^[0-9a-f]{64}$ ]] \
  || fail "Invalid operator script digest."
[[ "$(sha256sum -- "$0" | awk '{print $1}')" == "${REGISTRY_EXPECTED_SCRIPT_SHA256}" ]] \
  || fail "Operator script digest mismatch."
[[ "${REGISTRY_RUN_ID}" =~ ^[1-9][0-9]*$ && "${REGISTRY_RUN_ATTEMPT}" =~ ^[1-9][0-9]*$ ]] \
  || fail "Invalid run identity."

client_id="${REGISTRY_CLIENT_ID:-}"
expected_client_count="${REGISTRY_EXPECTED_CLIENT_COUNT:-}"
expected_client_state="${REGISTRY_EXPECTED_CLIENT_STATE:-}"
ack_expected_outcome="${REGISTRY_ACK_EXPECTED_OUTCOME:-}"
expected_token_commitment="${REGISTRY_EXPECTED_TOKEN_COMMITMENT:-}"
if [[ "${REGISTRY_OPERATION}" == "add" || "${REGISTRY_OPERATION}" == "revoke" \
  || "${REGISTRY_OPERATION}" == "recover" ]]; then
  [[ "${#client_id}" -le 64 ]] \
    && [[ "${client_id}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] \
    || fail "Invalid client ID."
elif [[ -n "${REGISTRY_CLIENT_ID:-}" ]]; then
  fail "client_id is allowed only for add/revoke/recover."
fi
if [[ "${protocol_action}" == "ack" ]]; then
  [[ "${ack_expected_outcome}" =~ ^(verified|known-precommit)$ ]] \
    || fail "ACK expected outcome is invalid."
  [[ -z "${expected_client_count}" && -z "${expected_client_state}" ]] \
    || fail "Recover state metadata is not allowed for ACK."
elif [[ "${REGISTRY_OPERATION}" == "recover" ]]; then
  [[ "${expected_client_count}" =~ ^([1-9]|[12][0-9]|3[0-2])$ ]] \
    || fail "Recover expected client count is invalid."
  [[ "${expected_client_state}" =~ ^(present|absent)$ ]] \
    || fail "Recover expected client state is invalid."
elif [[ -n "${expected_client_count}" || -n "${expected_client_state}" ]]; then
  fail "Expected client state metadata is allowed only for recover."
fi
marker_token_commitment="none"
if [[ "${REGISTRY_OPERATION}" == "add" ]]; then
  [[ "${expected_token_commitment}" =~ ^[0-9a-f]{64}$ ]] \
    || fail "Add token commitment is invalid."
  marker_token_commitment="${expected_token_commitment}"
elif [[ "${REGISTRY_OPERATION}" == "revoke" ]]; then
  [[ "${expected_token_commitment}" == "none" ]] \
    || fail "Revoke token commitment must be none."
elif [[ -n "${expected_token_commitment}" ]]; then
  fail "Token commitment metadata is allowed only for add/revoke."
fi
if [[ "${protocol_action}" == "operate" \
  && ( "${REGISTRY_OPERATION}" == "add" || "${REGISTRY_OPERATION}" == "revoke" \
    || "${REGISTRY_OPERATION}" == "recover" ) \
  && "${REGISTRY_RUN_ATTEMPT}" != "1" ]]; then
  fail "State-changing operations cannot run from a re-run attempt."
fi

pending_digest=""
if [[ "${protocol_action}" == "operate" && "${REGISTRY_OPERATION}" == "add" ]]; then
  IFS= read -r pending_digest || fail "Pending digest was not received."
  [[ "${pending_digest}" =~ ^[0-9a-f]{64}$ ]] || fail "Pending digest is invalid."
  _unexpected_input=""
  if IFS= read -r _unexpected_input || [[ -n "${_unexpected_input}" ]]; then
    fail "Add accepts exactly one digest line."
  fi
  actual_token_commitment="$(
    printf '{"version":1,"operationId":"%s","action":"add","clientId":"%s","tokenSha256":"%s"}' \
      "${REGISTRY_OPERATION_ID}" "${client_id}" "${pending_digest}" \
      | sha256sum | awk '{print $1}'
  )" || fail "Pending digest commitment cannot be computed."
  [[ "${actual_token_commitment}" == "${marker_token_commitment}" ]] \
    || fail "Pending digest commitment does not bind this operation."
  actual_token_commitment=""
else
  _unexpected_input=""
  if IFS= read -r _unexpected_input || [[ -n "${_unexpected_input}" ]]; then
    fail "Only add accepts standard input."
  fi
fi

app_root="${HOME}/alimtalk-proxy"
lock_path="${app_root}/.tonghari-api-production.lock"
marker_path="${app_root}/.gis-mcp-file-registry-v1"
registry_dir="${app_root}/.gis-mcp-secrets"
registry_file="${registry_dir}/clients.json"
container_registry_dir="/run/secrets/tonghari-gis-mcp"
container_registry_file="${container_registry_dir}/clients.json"
container_name="alimtalk-proxy"
unknown_marker="${app_root}/.gis-mcp-registry-commit-unknown"
receipts_dir="${app_root}/.gis-mcp-registry-receipts"
run_parent="${app_root}/.gis-mcp-registry-operations"
run_root="${run_parent}/${REGISTRY_RUN_ID}-${REGISTRY_RUN_ATTEMPT}"
receipt_path="${receipts_dir}/${REGISTRY_RUN_ID}-${REGISTRY_RUN_ATTEMPT}"
active_path="${run_root}/active"
name_prefix="gis-mcp-registry-${REGISTRY_RUN_ID}-${REGISTRY_RUN_ATTEMPT}"
pre_name="${name_prefix}-precheck"
updater_name="${name_prefix}-updater"
post_name="${name_prefix}-postcheck"

mutation=0
[[ "${protocol_action}" == "operate" \
  && ( "${REGISTRY_OPERATION}" == "add" || "${REGISTRY_OPERATION}" == "revoke" ) ]] \
  && mutation=1
phase="precommit"
active_expected_payload=""
marker_armed=0
marker_outcome=""
marker_pre_count=""
marker_pre_state=""
marker_post_count=""
marker_post_state=""
ack_marker_owned=0

loaded_run_key=""
loaded_operation=""
loaded_operation_id=""
loaded_client_id=""
loaded_pre_count=""
loaded_pre_state=""
loaded_post_count=""
loaded_post_state=""
loaded_token_commitment=""
loaded_script_sha256=""
loaded_outcome=""

load_operation_marker() {
  [[ -f "${unknown_marker}" && ! -L "${unknown_marker}" ]] \
    && [[ "$(realpath -e -- "${unknown_marker}")" == "${unknown_marker}" ]] \
    && [[ "$(stat -c '%u:%a' "${unknown_marker}" 2>/dev/null)" == "$(id -u):600" ]] \
    || fail "Operation marker must be a deploy-user-owned mode 600 regular file."
  local -a marker_lines=()
  mapfile -t marker_lines < "${unknown_marker}"
  [[ "${#marker_lines[@]}" -eq 12 && "${marker_lines[0]}" == "version=4" ]] \
    || fail "Operation marker format is not recoverable automatically."
  loaded_run_key="${marker_lines[1]#runKey=}"
  loaded_operation="${marker_lines[2]#operation=}"
  loaded_operation_id="${marker_lines[3]#operationId=}"
  loaded_client_id="${marker_lines[4]#clientId=}"
  loaded_pre_count="${marker_lines[5]#preCount=}"
  loaded_pre_state="${marker_lines[6]#preState=}"
  loaded_post_count="${marker_lines[7]#postCount=}"
  loaded_post_state="${marker_lines[8]#postState=}"
  loaded_token_commitment="${marker_lines[9]#tokenCommitment=}"
  loaded_script_sha256="${marker_lines[10]#scriptSha256=}"
  loaded_outcome="${marker_lines[11]#outcome=}"
  [[ "${marker_lines[1]}" == "runKey=${loaded_run_key}" \
    && "${loaded_run_key}" =~ ^[1-9][0-9]*-[1-9][0-9]*$ \
    && "${marker_lines[2]}" == "operation=${loaded_operation}" \
    && "${loaded_operation}" =~ ^(add|revoke)$ \
    && "${marker_lines[3]}" == "operationId=${loaded_operation_id}" \
    && "${#loaded_operation_id}" -ge 8 && "${#loaded_operation_id}" -le 64 \
    && "${loaded_operation_id}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ \
    && "${marker_lines[4]}" == "clientId=${loaded_client_id}" \
    && "${#loaded_client_id}" -le 64 \
    && "${loaded_client_id}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ \
    && "${marker_lines[5]}" == "preCount=${loaded_pre_count}" \
    && "${loaded_pre_count}" =~ ^([1-9]|[12][0-9]|3[0-2])$ \
    && "${marker_lines[6]}" == "preState=${loaded_pre_state}" \
    && "${loaded_pre_state}" =~ ^(present|absent)$ \
    && "${marker_lines[7]}" == "postCount=${loaded_post_count}" \
    && "${loaded_post_count}" =~ ^([1-9]|[12][0-9]|3[0-2])$ \
    && "${marker_lines[8]}" == "postState=${loaded_post_state}" \
    && "${loaded_post_state}" =~ ^(present|absent)$ \
    && "${marker_lines[9]}" == "tokenCommitment=${loaded_token_commitment}" \
    && "${marker_lines[10]}" == "scriptSha256=${loaded_script_sha256}" \
    && "${loaded_script_sha256}" =~ ^[0-9a-f]{64}$ \
    && "${marker_lines[11]}" == "outcome=${loaded_outcome}" \
    && "${loaded_outcome}" =~ ^(intent|verified|known-precommit|unknown)$ ]] \
    || fail "Operation marker fields are invalid."
  if [[ "${loaded_operation}" == "add" ]]; then
    [[ "${loaded_token_commitment}" =~ ^[0-9a-f]{64}$ ]] \
      || fail "Add operation marker token commitment is invalid."
  else
    [[ "${loaded_token_commitment}" == "none" ]] \
      || fail "Revoke operation marker token commitment is invalid."
  fi
  if [[ "${loaded_outcome}" == "known-precommit" \
    && "${loaded_pre_count}" == "${loaded_post_count}" \
    && "${loaded_pre_state}" == "${loaded_post_state}" ]]; then
    :
  elif [[ "${loaded_operation}" == "add" ]]; then
    [[ "${loaded_pre_state}" == "absent" && "${loaded_post_state}" == "present" \
      && "${loaded_post_count}" -eq "$((loaded_pre_count + 1))" ]] \
      || fail "Add operation marker transition is invalid."
  else
    [[ "${loaded_pre_state}" == "present" && "${loaded_post_state}" == "absent" \
      && "${loaded_pre_count}" -eq "$((loaded_post_count + 1))" ]] \
      || fail "Revoke operation marker transition is invalid."
  fi
}

assert_receipt_ledger_safe() (
  local rejected_operation_id="${1:-}"
  local allowed_recovery_temp="${2:-}"
  if [[ ! -e "${receipts_dir}" && ! -L "${receipts_dir}" ]]; then
    return 0
  fi
  [[ -d "${receipts_dir}" && ! -L "${receipts_dir}" \
    && "$(realpath -e -- "${receipts_dir}")" == "${receipts_dir}" \
    && "$(stat -c '%u:%a' "${receipts_dir}")" == "$(id -u):700" ]] \
    || return 1

  local receipt receipt_name receipt_run_key receipt_operation receipt_operation_id
  local receipt_client_id receipt_pre_count receipt_pre_state receipt_post_count
  local receipt_post_state receipt_token_commitment receipt_script_sha256 receipt_outcome
  local -a receipt_entries=() receipt_lines=()
  local -A seen_operation_ids=()
  shopt -s nullglob dotglob
  receipt_entries=("${receipts_dir}"/*)
  shopt -u nullglob dotglob
  for receipt in "${receipt_entries[@]}"; do
    if [[ -n "${allowed_recovery_temp}" && "${receipt}" == "${allowed_recovery_temp}" ]]; then
      continue
    fi
    receipt_name="${receipt##*/}"
    [[ "${receipt_name}" =~ ^[1-9][0-9]*-[1-9][0-9]*$ \
      && -f "${receipt}" && ! -L "${receipt}" \
      && "$(realpath -e -- "${receipt}")" == "${receipt}" \
      && "$(stat -c '%u:%a' "${receipt}")" == "$(id -u):600" ]] \
      || return 1
    receipt_lines=()
    mapfile -t receipt_lines < "${receipt}"
    [[ "${#receipt_lines[@]}" -eq 12 && "${receipt_lines[0]}" == "version=4" ]] \
      || return 1
    receipt_run_key="${receipt_lines[1]#runKey=}"
    receipt_operation="${receipt_lines[2]#operation=}"
    receipt_operation_id="${receipt_lines[3]#operationId=}"
    receipt_client_id="${receipt_lines[4]#clientId=}"
    receipt_pre_count="${receipt_lines[5]#preCount=}"
    receipt_pre_state="${receipt_lines[6]#preState=}"
    receipt_post_count="${receipt_lines[7]#postCount=}"
    receipt_post_state="${receipt_lines[8]#postState=}"
    receipt_token_commitment="${receipt_lines[9]#tokenCommitment=}"
    receipt_script_sha256="${receipt_lines[10]#scriptSha256=}"
    receipt_outcome="${receipt_lines[11]#outcome=}"
    [[ "${receipt_lines[1]}" == "runKey=${receipt_run_key}" \
      && "${receipt_run_key}" == "${receipt_name}" \
      && "${receipt_lines[2]}" == "operation=${receipt_operation}" \
      && "${receipt_operation}" =~ ^(add|revoke)$ \
      && "${receipt_lines[3]}" == "operationId=${receipt_operation_id}" \
      && "${#receipt_operation_id}" -ge 8 && "${#receipt_operation_id}" -le 64 \
      && "${receipt_operation_id}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ \
      && "${receipt_lines[4]}" == "clientId=${receipt_client_id}" \
      && "${#receipt_client_id}" -le 64 \
      && "${receipt_client_id}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ \
      && "${receipt_lines[5]}" == "preCount=${receipt_pre_count}" \
      && "${receipt_pre_count}" =~ ^([1-9]|[12][0-9]|3[0-2])$ \
      && "${receipt_lines[6]}" == "preState=${receipt_pre_state}" \
      && "${receipt_pre_state}" =~ ^(present|absent)$ \
      && "${receipt_lines[7]}" == "postCount=${receipt_post_count}" \
      && "${receipt_post_count}" =~ ^([1-9]|[12][0-9]|3[0-2])$ \
      && "${receipt_lines[8]}" == "postState=${receipt_post_state}" \
      && "${receipt_post_state}" =~ ^(present|absent)$ \
      && "${receipt_lines[9]}" == "tokenCommitment=${receipt_token_commitment}" \
      && "${receipt_lines[10]}" == "scriptSha256=${receipt_script_sha256}" \
      && "${receipt_script_sha256}" =~ ^[0-9a-f]{64}$ \
      && "${receipt_lines[11]}" == "outcome=${receipt_outcome}" \
      && "${receipt_outcome}" =~ ^(verified|known-precommit)$ ]] \
      || return 1
    if [[ "${receipt_operation}" == "add" ]]; then
      [[ "${receipt_token_commitment}" =~ ^[0-9a-f]{64}$ ]] || return 1
    else
      [[ "${receipt_token_commitment}" == "none" ]] || return 1
    fi
    [[ -z "${seen_operation_ids[${receipt_operation_id}]+x}" ]] || return 1
    seen_operation_ids["${receipt_operation_id}"]=1
    [[ -z "${rejected_operation_id}" \
      || "${receipt_operation_id}" != "${rejected_operation_id}" ]] || return 1
    if [[ "${receipt_outcome}" == "known-precommit" \
      && "${receipt_pre_count}" == "${receipt_post_count}" \
      && "${receipt_pre_state}" == "${receipt_post_state}" ]]; then
      :
    elif [[ "${receipt_operation}" == "add" ]]; then
      [[ "${receipt_pre_state}" == "absent" && "${receipt_post_state}" == "present" \
        && "${receipt_post_count}" -eq "$((receipt_pre_count + 1))" ]] \
        || return 1
    else
      [[ "${receipt_pre_state}" == "present" && "${receipt_post_state}" == "absent" \
        && "${receipt_pre_count}" -eq "$((receipt_post_count + 1))" ]] \
        || return 1
    fi
  done
)

operation_marker_payload() {
  local outcome="$1"
  printf \
    'version=4\nrunKey=%s\noperation=%s\noperationId=%s\nclientId=%s\npreCount=%s\npreState=%s\npostCount=%s\npostState=%s\ntokenCommitment=%s\nscriptSha256=%s\noutcome=%s' \
    "${REGISTRY_RUN_ID}-${REGISTRY_RUN_ATTEMPT}" "${REGISTRY_OPERATION}" \
    "${REGISTRY_OPERATION_ID}" "${client_id}" "${marker_pre_count}" \
    "${marker_pre_state}" "${marker_post_count}" "${marker_post_state}" \
    "${marker_token_commitment}" "${REGISTRY_EXPECTED_SCRIPT_SHA256}" "${outcome}"
}

write_operation_marker() {
  local outcome="$1" payload marker_identity marker_temp
  [[ "${outcome}" =~ ^(intent|verified|known-precommit|unknown)$ ]] \
    || fail "Invalid operation marker outcome."
  payload="$(operation_marker_payload "${outcome}")"
  if [[ ! -e "${unknown_marker}" && ! -L "${unknown_marker}" ]]; then
    [[ "${outcome}" == "intent" || "${outcome}" == "known-precommit" ]] \
      || fail "Initial operation marker outcome is invalid."
    (umask 077; set -o noclobber; printf '%s\n' "${payload}" > "${unknown_marker}") \
      2>/dev/null || fail "Cannot create durable mutation intent." 75
  else
    load_operation_marker
    [[ "${loaded_run_key}" == "${REGISTRY_RUN_ID}-${REGISTRY_RUN_ATTEMPT}" \
      && "${loaded_operation}" == "${REGISTRY_OPERATION}" \
      && "${loaded_operation_id}" == "${REGISTRY_OPERATION_ID}" \
      && "${loaded_client_id}" == "${client_id}" \
      && "${loaded_pre_count}" == "${marker_pre_count}" \
      && "${loaded_pre_state}" == "${marker_pre_state}" \
      && "${loaded_post_count}" == "${marker_post_count}" \
      && "${loaded_post_state}" == "${marker_post_state}" \
      && "${loaded_token_commitment}" == "${marker_token_commitment}" \
      && "${loaded_script_sha256}" == "${REGISTRY_EXPECTED_SCRIPT_SHA256}" ]] \
      || fail "Operation marker identity changed." 75
    marker_identity="$(stat -c '%d:%i' "${unknown_marker}")"
    marker_temp="${unknown_marker}.${REGISTRY_RUN_ID}-${REGISTRY_RUN_ATTEMPT}.$$"
    [[ ! -e "${marker_temp}" && ! -L "${marker_temp}" ]] \
      || fail "Operation marker temporary path already exists." 75
    (umask 077; set -o noclobber; printf '%s\n' "${payload}" > "${marker_temp}") \
      2>/dev/null || fail "Cannot stage operation marker outcome." 75
    sync -d "${marker_temp}" || fail "Cannot flush operation marker outcome." 75
    [[ -f "${unknown_marker}" && ! -L "${unknown_marker}" \
      && "$(stat -c '%d:%i' "${unknown_marker}")" == "${marker_identity}" ]] \
      || fail "Operation marker changed before outcome publish." 75
    mv -T -- "${marker_temp}" "${unknown_marker}" \
      || fail "Cannot publish operation marker outcome." 75
  fi
  sync -d "${unknown_marker}" || fail "Cannot flush operation marker." 75
  sync -f "${app_root}" || fail "Cannot flush operation marker directory." 75
  load_operation_marker
  [[ "${loaded_run_key}" == "${REGISTRY_RUN_ID}-${REGISTRY_RUN_ATTEMPT}" \
    && "${loaded_operation}" == "${REGISTRY_OPERATION}" \
    && "${loaded_operation_id}" == "${REGISTRY_OPERATION_ID}" \
    && "${loaded_client_id}" == "${client_id}" \
    && "${loaded_pre_count}" == "${marker_pre_count}" \
    && "${loaded_pre_state}" == "${marker_pre_state}" \
    && "${loaded_post_count}" == "${marker_post_count}" \
    && "${loaded_post_state}" == "${marker_post_state}" \
    && "${loaded_token_commitment}" == "${marker_token_commitment}" \
    && "${loaded_script_sha256}" == "${REGISTRY_EXPECTED_SCRIPT_SHA256}" \
    && "${loaded_outcome}" == "${outcome}" ]] \
    || fail "Published operation marker cannot be attested." 75
  marker_armed=1
  marker_outcome="${outcome}"
}

mark_unknown() {
  [[ "${marker_armed}" -eq 1 ]] || return 1
  if [[ "${marker_outcome}" == "intent" ]]; then
    write_operation_marker unknown
  else
    [[ "${marker_outcome}" =~ ^(verified|known-precommit|unknown)$ ]]
  fi
}

remove_current_active() {
  if [[ ! -e "${active_path}" && ! -L "${active_path}" ]]; then
    return 0
  fi
  [[ -f "${active_path}" && ! -L "${active_path}" ]] \
    && [[ "$(stat -c '%u:%a' "${active_path}" 2>/dev/null)" == "$(id -u):600" ]] \
    && [[ -n "${active_expected_payload}" ]] \
    && [[ "$(<"${active_path}")" == "${active_expected_payload}" ]] \
    || return 1
  rm -f -- "${active_path}"
}

remove_current_run_residue() {
  [[ ! -e "${active_path}" && ! -L "${active_path}" ]] || return 1
  local self_operator="${run_root}/operator.sh"
  [[ -d "${run_root}" && ! -L "${run_root}" ]] \
    && [[ "$(realpath -e -- "${run_root}")" == "${run_root}" ]] \
    && [[ "$(stat -c '%u:%a' "${run_root}")" == "$(id -u):700" ]] \
    && [[ -f "${self_operator}" && ! -L "${self_operator}" ]] \
    && [[ "$(stat -c '%u:%a' "${self_operator}")" == "$(id -u):600" ]] \
    && [[ "$(sha256sum -- "${self_operator}" | awk '{print $1}')" == "${REGISTRY_EXPECTED_SCRIPT_SHA256}" ]] \
    || return 1
  local -a remaining_entries=()
  mapfile -d '' -t remaining_entries \
    < <(find "${run_root}" -mindepth 1 -maxdepth 1 -print0)
  [[ "${#remaining_entries[@]}" -eq 1 \
    && "${remaining_entries[0]}" == "${self_operator}" ]] || return 1
  rm -f -- "${self_operator}" || return 1
  rmdir -- "${run_root}" || return 1
  sync -f "${run_parent}"
}

cleanup() {
  status=$?
  trap - EXIT INT TERM HUP
  set +e
  signal_status=0
  if [[ "${status}" -ge 128 ]]; then signal_status=1; fi
  if [[ "${phase}" == "mutation-started" \
    || ( "${phase}" == "verified" && "${mutation}" -eq 1 && "${status}" -ne 0 ) ]]; then
    mark_unknown || true
    status=75
  elif [[ "${status}" -ne 0 && "${status}" -ne 75 && "${signal_status}" -eq 0 ]]; then
    status=64
  fi
  for exact_name in "${pre_name}" "${updater_name}" "${post_name}"; do
    if docker container inspect "${exact_name}" >/dev/null 2>&1; then
      docker rm -f -- "${exact_name}" >/dev/null 2>&1 || {
        if [[ "${phase}" == "mutation-started" \
          || ( "${phase}" == "verified" && "${mutation}" -eq 1 ) ]]; then
          mark_unknown || true
          status=75
        elif [[ "${signal_status}" -eq 0 ]]; then
          status=64
        fi
      }
    fi
  done
  if [[ "${phase}" != "mutation-started" ]]; then
    remove_current_active || {
      if [[ "${signal_status}" -eq 0 ]]; then status=64; fi
    }
  fi
  preserve_for_ack=0
  if [[ "${mutation}" -eq 1 && "${marker_armed}" -eq 1 ]]; then
    preserve_for_ack=1
  elif [[ "${protocol_action}" == "ack" && "${ack_marker_owned}" -eq 1 ]]; then
    preserve_for_ack=1
  fi
  if [[ ( "${status}" -eq 0 || "${status}" -eq 64 || "${mutation}" -eq 0 ) \
    && "${preserve_for_ack}" -eq 0 ]]; then
    remove_current_run_residue || {
      status=64
    }
  fi
  if [[ "${status}" -eq 64 && "${protocol_action}" == "operate" ]]; then
    printf 'known-precommit-failure operation=%s operationId=%s\n' \
      "${REGISTRY_OPERATION}" "${REGISTRY_OPERATION_ID}" >&2
  fi
  exit "${status}"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

[[ -d "${app_root}" && ! -L "${app_root}" ]] \
  && [[ "$(realpath -e -- "${app_root}")" == "${app_root}" ]] \
  || fail "Application root is not canonical."
cd "${app_root}"
[[ -d "${run_root}" && ! -L "${run_root}" ]] \
  && [[ "$(stat -c '%u:%a' "${run_root}")" == "$(id -u):700" ]] \
  || fail "Operation run directory is invalid."
boot_id="$(< /proc/sys/kernel/random/boot_id)"
[[ "${boot_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
  || fail "Kernel boot identity is invalid."
proc_stat="$(< "/proc/$$/stat")"
proc_stat_tail="${proc_stat##*) }"
read -r -a proc_stat_fields <<< "${proc_stat_tail}"
proc_start_time="${proc_stat_fields[19]:-}"
[[ "${proc_start_time}" =~ ^[1-9][0-9]*$ ]] \
  || fail "Operator process start time is invalid."
active_expected_payload="$(printf \
  'version=2\nrunKey=%s\npid=%s\nbootId=%s\nstartTime=%s' \
  "${REGISTRY_RUN_ID}-${REGISTRY_RUN_ATTEMPT}" "$$" "${boot_id}" "${proc_start_time}")"
(set -o noclobber; printf '%s\n' "${active_expected_payload}" > "${active_path}") 2>/dev/null \
  || fail "Operation run is already active."

if [[ ! -e "${lock_path}" && ! -L "${lock_path}" ]]; then
  (umask 077; set -o noclobber; : > "${lock_path}") 2>/dev/null || true
fi
check_deploy_lock() {
  [[ -f "${lock_path}" && ! -L "${lock_path}" ]] \
    && [[ "$(stat -c '%u:%a' "${lock_path}")" == "$(id -u):600" ]] \
    || fail "Production lock must be a deploy-user-owned mode 600 regular file."
}
check_deploy_lock
exec 9>>"${lock_path}"
flock -w 2400 9 || fail "Timed out waiting for the production lock."
check_deploy_lock
[[ "$(stat -Lc '%d:%i' "/proc/$$/fd/9")" == "$(stat -c '%d:%i' "${lock_path}")" ]] \
  || fail "Production lock changed while acquired."

[[ -f "${marker_path}" && ! -L "${marker_path}" ]] \
  && [[ "$(realpath -e -- "${marker_path}")" == "${marker_path}" ]] \
  && [[ "$(stat -c '%u:%a:%s' "${marker_path}")" == "$(id -u):600:10" ]] \
  && [[ "$(<"${marker_path}")" == "version=1" ]] \
  || fail "File-registry marker is invalid."
check_registry() {
  registry_fs_attest 0 || fail "Registry file contract is invalid."
}

docker container inspect "${container_name}" >/dev/null 2>&1 \
  || fail "Current container is missing."
[[ "$(docker container inspect --format '{{.State.Running}}' "${container_name}")" == "true" ]] \
  || fail "Current container is not running."
running_container_id="$(docker container inspect --format '{{.Id}}' "${container_name}")"
running_image="$(docker container inspect --format '{{.Image}}' "${container_name}")"
configured_image="$(docker container inspect --format '{{.Config.Image}}' "${container_name}")"
[[ "${configured_image}" =~ ^ghcr\.io/dlswn666/alimtalk-proxy@sha256:[0-9a-f]{64}$ ]] \
  || fail "Current container image is not immutable."
[[ "$(docker image inspect --format '{{.Id}}' "${configured_image}")" == "${running_image}" ]] \
  || fail "Current container image ID is inconsistent."
running_git_sha="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${running_image}")"
[[ "${running_git_sha}" =~ ^[0-9a-f]{40}$ ]] \
  || fail "Current container image revision is invalid."
running_image_tag="ghcr.io/dlswn666/alimtalk-proxy:${running_git_sha}"
registry_mount="$(docker container inspect --format \
  '{{range .Mounts}}{{if eq .Destination "/run/secrets/tonghari-gis-mcp"}}{{.Type}}|{{.RW}}|{{.Source}}{{println}}{{end}}{{end}}' \
  "${container_name}")"
[[ "${registry_mount}" == "bind|false|${registry_dir}" ]] \
  || fail "Current container registry mount is invalid."

registry_fs_attest() {
  local require_clean="$1"
  local require_canonical_gid="${2:-0}"
  [[ "${require_clean}" =~ ^[01]$ ]] || return 1
  [[ "${require_canonical_gid}" =~ ^[01]$ ]] || return 1
  docker exec -i --user 1001:1001 \
    -e REGISTRY_DIRECTORY="${container_registry_dir}" \
    -e REGISTRY_FILE="${container_registry_file}" \
    -e REQUIRE_CLEAN="${require_clean}" \
    -e REQUIRE_CANONICAL_GID="${require_canonical_gid}" \
    "${container_name}" node -e '
      const fs = require("node:fs");
      try {
        const dir = process.env.REGISTRY_DIRECTORY;
        const file = process.env.REGISTRY_FILE;
        const dirStat = fs.lstatSync(dir);
        const fileStat = fs.lstatSync(file);
        const fileGidAllowed = process.env.REQUIRE_CANONICAL_GID === "1"
          ? fileStat.gid === 1001
          : fileStat.gid === 1001 || fileStat.gid === 65533;
        const valid = dirStat.isDirectory() && !dirStat.isSymbolicLink()
          && dirStat.uid === 1001 && dirStat.gid === 1001
          && (dirStat.mode & 0o7777) === 0o700
          && fs.realpathSync(dir) === dir
          && fileStat.isFile() && !fileStat.isSymbolicLink()
          && fileStat.uid === 1001 && fileGidAllowed
          && (fileStat.mode & 0o7777) === 0o600
          && fs.realpathSync(file) === file;
        if (!valid) process.exit(1);
        if (process.env.REQUIRE_CLEAN === "1") {
          const names = fs.readdirSync(dir);
          const dirty = names.includes("clients.json.lock")
            || names.some(name => /^\.clients\.json\..+\.tmp$/.test(name));
          if (dirty) process.exit(1);
        }
      } catch { process.exit(1); }
    ' </dev/null >/dev/null
}
check_registry

count_registry_updaters() {
  local names name count=0
  names="$(docker container ls -a --format '{{.Names}}')" || return 1
  while IFS= read -r name; do
    [[ -n "${name}" ]] || continue
    if [[ "${name}" =~ ^gis-mcp-registry-[0-9]+-[0-9]+-updater$ ]]; then
      count="$((count + 1))"
    fi
  done <<< "${names}"
  printf '%s\n' "${count}"
}

reconcile_unmarked_run_residue() {
  local covered_marker_root="${1:-}"
  if [[ -n "${covered_marker_root}" ]]; then
    [[ -f "${unknown_marker}" && ! -L "${unknown_marker}" \
      && "$(realpath -e -- "${unknown_marker}")" == "${unknown_marker}" \
      && "$(stat -c '%u:%a' "${unknown_marker}")" == "$(id -u):600" ]] \
      || fail "COMMIT_STATE_UNKNOWN: covered pending evidence is unsafe." 75
  else
    [[ ! -e "${unknown_marker}" && ! -L "${unknown_marker}" ]] \
      || fail "COMMIT_STATE_UNKNOWN: pending evidence cannot be garbage-collected." 75
  fi
  local residue residue_run_key residue_root_identity residue_operator residue_active residue_receipt
  local operator_present active_present entry entry_name entry_count
  local operator_identity operator_sha256 active_identity active_sha256
  local receipt_identity receipt_sha256
  local stale_pid stale_boot_id stale_start_time current_boot_id stale_proc_stat stale_proc_tail
  local -a active_lines=() stale_proc_fields=()
  while IFS= read -r -d '' residue; do
    [[ "${residue}" == "${run_root}" || ( -n "${covered_marker_root}" \
      && "${residue}" == "${covered_marker_root}" ) ]] && continue
    residue_run_key="${residue##*/}"
    [[ "${residue_run_key}" =~ ^[1-9][0-9]*-[1-9][0-9]*$ \
      && -d "${residue}" && ! -L "${residue}" \
      && "$(realpath -e -- "${residue}")" == "${residue}" \
      && "$(stat -c '%u:%a' "${residue}")" == "$(id -u):700" ]] \
      || fail "COMMIT_STATE_UNKNOWN: unmarked operation residue is unsafe." 75
    residue_operator="${residue}/operator.sh"
    residue_active="${residue}/active"
    residue_receipt="${receipts_dir}/${residue_run_key}"
    operator_present=0
    active_present=0
    entry_count=0
    while IFS= read -r -d '' entry; do
      entry_name="${entry##*/}"
      if [[ "${entry_name}" == "operator.sh" ]]; then
        operator_present=1
      elif [[ "${entry_name}" == "active" ]]; then
        active_present=1
      else
        fail "COMMIT_STATE_UNKNOWN: unmarked operation residue contains unexpected evidence." 75
      fi
      entry_count="$((entry_count + 1))"
    done < <(find "${residue}" -mindepth 1 -maxdepth 1 -print0)
    (( entry_count <= 2 )) \
      || fail "COMMIT_STATE_UNKNOWN: unmarked operation residue count is invalid." 75
    [[ "${active_present}" -eq 0 || "${operator_present}" -eq 1 ]] \
      || fail "COMMIT_STATE_UNKNOWN: unmarked active-only residue is unreachable." 75

    operator_identity=""
    operator_sha256=""
    if [[ "${operator_present}" -eq 1 ]]; then
      [[ -f "${residue_operator}" && ! -L "${residue_operator}" \
        && "$(stat -c '%u:%a' "${residue_operator}")" == "$(id -u):600" ]] \
        || fail "COMMIT_STATE_UNKNOWN: unmarked operator residue is unsafe." 75
      operator_identity="$(stat -c '%d:%i' "${residue_operator}")"
      operator_sha256="$(sha256sum -- "${residue_operator}" | awk '{print $1}')"
    fi

    receipt_identity=""
    receipt_sha256=""
    if [[ -e "${residue_receipt}" || -L "${residue_receipt}" ]]; then
      [[ -z "${covered_marker_root}" ]] \
        || fail "COMMIT_STATE_UNKNOWN: unmarked recovery residue has an unexpected receipt." 75
      [[ -d "${receipts_dir}" && ! -L "${receipts_dir}" \
        && "$(stat -c '%u:%a' "${receipts_dir}")" == "$(id -u):700" \
        && -f "${residue_receipt}" && ! -L "${residue_receipt}" \
        && "$(stat -c '%u:%a' "${residue_receipt}")" == "$(id -u):600" ]] \
        || fail "COMMIT_STATE_UNKNOWN: completed run receipt is unsafe." 75
      receipt_identity="$(stat -c '%d:%i' "${residue_receipt}")"
      receipt_sha256="$(sha256sum -- "${residue_receipt}" | awk '{print $1}')"
    fi

    active_identity=""
    active_sha256=""
    if [[ "${active_present}" -eq 1 ]]; then
      [[ -f "${residue_active}" && ! -L "${residue_active}" \
        && "$(stat -c '%u:%a' "${residue_active}")" == "$(id -u):600" ]] \
        || fail "COMMIT_STATE_UNKNOWN: unmarked active residue is unsafe." 75
      active_lines=()
      mapfile -t active_lines < "${residue_active}"
      stale_pid="${active_lines[2]:-}"
      stale_pid="${stale_pid#pid=}"
      stale_boot_id="${active_lines[3]:-}"
      stale_boot_id="${stale_boot_id#bootId=}"
      stale_start_time="${active_lines[4]:-}"
      stale_start_time="${stale_start_time#startTime=}"
      [[ "${#active_lines[@]}" -eq 5 \
        && "${active_lines[0]}" == "version=2" \
        && "${active_lines[1]}" == "runKey=${residue_run_key}" \
        && "${active_lines[2]}" == "pid=${stale_pid}" \
        && "${stale_pid}" =~ ^[1-9][0-9]*$ \
        && "${active_lines[3]}" == "bootId=${stale_boot_id}" \
        && "${stale_boot_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ \
        && "${active_lines[4]}" == "startTime=${stale_start_time}" \
        && "${stale_start_time}" =~ ^[1-9][0-9]*$ ]] \
        || fail "COMMIT_STATE_UNKNOWN: unmarked active process identity is invalid." 75
      current_boot_id="$(< /proc/sys/kernel/random/boot_id)"
      [[ "${current_boot_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
        || fail "COMMIT_STATE_UNKNOWN: current boot identity is invalid." 75
      if [[ "${stale_boot_id}" == "${current_boot_id}" \
        && ( -e "/proc/${stale_pid}/stat" || -L "/proc/${stale_pid}/stat" ) ]]; then
        [[ -r "/proc/${stale_pid}/stat" && ! -L "/proc/${stale_pid}/stat" ]] \
          || fail "COMMIT_STATE_UNKNOWN: unmarked operator liveness is ambiguous." 75
        stale_proc_stat="$(< "/proc/${stale_pid}/stat")"
        stale_proc_tail="${stale_proc_stat##*) }"
        stale_proc_fields=()
        read -r -a stale_proc_fields <<< "${stale_proc_tail}"
        [[ "${stale_proc_fields[19]:-}" =~ ^[1-9][0-9]*$ ]] \
          || fail "COMMIT_STATE_UNKNOWN: unmarked operator start time is invalid." 75
        [[ "${stale_proc_fields[19]}" != "${stale_start_time}" ]] \
          || fail "COMMIT_STATE_UNKNOWN: unmarked operator process is still alive." 75
      fi
      active_identity="$(stat -c '%d:%i' "${residue_active}")"
      active_sha256="$(sha256sum -- "${residue_active}" | awk '{print $1}')"
    fi

    residue_root_identity="$(stat -c '%d:%i' "${residue}")"
    [[ -d "${residue}" && ! -L "${residue}" \
      && "$(stat -c '%d:%i' "${residue}")" == "${residue_root_identity}" \
      && "$(stat -c '%u:%a' "${residue}")" == "$(id -u):700" ]] \
      || fail "COMMIT_STATE_UNKNOWN: unmarked operation root changed during cleanup." 75
    if [[ -n "${receipt_identity}" ]]; then
      [[ -f "${residue_receipt}" && ! -L "${residue_receipt}" \
        && "$(stat -c '%d:%i' "${residue_receipt}")" == "${receipt_identity}" \
        && "$(stat -c '%u:%a' "${residue_receipt}")" == "$(id -u):600" \
        && "$(sha256sum -- "${residue_receipt}" | awk '{print $1}')" == "${receipt_sha256}" ]] \
        || fail "COMMIT_STATE_UNKNOWN: completed run receipt changed during cleanup." 75
    fi
    if [[ -n "${active_identity}" ]]; then
      [[ -f "${residue_active}" && ! -L "${residue_active}" \
        && "$(stat -c '%d:%i' "${residue_active}")" == "${active_identity}" \
        && "$(stat -c '%u:%a' "${residue_active}")" == "$(id -u):600" \
        && "$(sha256sum -- "${residue_active}" | awk '{print $1}')" == "${active_sha256}" ]] \
        || fail "COMMIT_STATE_UNKNOWN: unmarked active evidence changed during cleanup." 75
      rm -f -- "${residue_active}"
    else
      [[ ! -e "${residue_active}" && ! -L "${residue_active}" ]] \
        || fail "COMMIT_STATE_UNKNOWN: unmarked active evidence appeared during cleanup." 75
    fi
    if [[ -n "${operator_identity}" ]]; then
      [[ -f "${residue_operator}" && ! -L "${residue_operator}" \
        && "$(stat -c '%d:%i' "${residue_operator}")" == "${operator_identity}" \
        && "$(stat -c '%u:%a' "${residue_operator}")" == "$(id -u):600" \
        && "$(sha256sum -- "${residue_operator}" | awk '{print $1}')" == "${operator_sha256}" ]] \
        || fail "COMMIT_STATE_UNKNOWN: unmarked operator evidence changed during cleanup." 75
      rm -f -- "${residue_operator}"
    else
      [[ ! -e "${residue_operator}" && ! -L "${residue_operator}" ]] \
        || fail "COMMIT_STATE_UNKNOWN: unmarked operator evidence appeared during cleanup." 75
    fi
    rmdir -- "${residue}" \
      || fail "COMMIT_STATE_UNKNOWN: unmarked operation root cleanup failed." 75
  done < <(find "${run_parent}" -mindepth 1 -maxdepth 1 -print0)
  sync -f "${run_parent}" \
    || fail "COMMIT_STATE_UNKNOWN: unmarked operation cleanup cannot be flushed." 75
}

if [[ "${mutation}" -eq 1 ]]; then
  if [[ -e "${unknown_marker}" || -L "${unknown_marker}" ]]; then
    load_operation_marker
    [[ "${loaded_operation_id}" != "${REGISTRY_OPERATION_ID}" ]] \
      || fail "COMMIT_STATE_UNKNOWN: operation ID already exists in the current marker." 75
    fail "COMMIT_STATE_UNKNOWN: an earlier mutation requires guarded recovery." 75
  fi
  assert_receipt_ledger_safe "${REGISTRY_OPERATION_ID}" \
    || fail "COMMIT_STATE_UNKNOWN: receipt ledger contains unresolved or unsafe evidence." 75
  registry_fs_attest 1 \
    || fail "COMMIT_STATE_UNKNOWN: registry lock, temporary file, or file contract is unsafe."
  stale_updaters="$(count_registry_updaters)" \
    || fail "COMMIT_STATE_UNKNOWN: registry updater enumeration failed."
  [[ "${stale_updaters}" == "0" ]] \
    || fail "COMMIT_STATE_UNKNOWN: an earlier updater exists."
  reconcile_unmarked_run_residue
  shopt -s nullglob
  run_entries=("${run_parent}"/*)
  shopt -u nullglob
  for entry in "${run_entries[@]}"; do
    [[ "${entry}" == "${run_root}" ]] \
      || fail "COMMIT_STATE_UNKNOWN: an earlier operation was not cleaned up."
  done
fi

for exact_name in "${pre_name}" "${updater_name}" "${post_name}"; do
  ! docker container inspect "${exact_name}" >/dev/null 2>&1 \
    || fail "An exact operation container already exists."
done

readonly_cli() {
  local exact_name="$1"
  shift
  docker run --rm --name "${exact_name}" \
    --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --user 1001:1001 \
    --pids-limit 64 --memory 128m --memory-swap 128m --cpus 0.5 \
    --mount "type=bind,src=${registry_dir},dst=${container_registry_dir},readonly" \
    "${running_image}" node /app/dist/cli/gis-mcp-registry.js "$@" \
    --path "${container_registry_file}" </dev/null
}

verify_add_content_commitment() {
  local operation_id="$1" target_client_id="$2" expected_count="$3"
  local expected_commitment="$4" exact_name="$5" attestation
  [[ "${operation_id}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ \
    && "${target_client_id}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ \
    && "${expected_count}" =~ ^([1-9]|[12][0-9]|3[0-2])$ \
    && "${expected_commitment}" =~ ^[0-9a-f]{64}$ ]] \
    || fail "Add content commitment verification input is invalid." 75
  attestation="$(readonly_cli "${exact_name}" attest-client \
    --client-id "${target_client_id}" --operation-id "${operation_id}")" \
    || fail "COMMIT_STATE_UNKNOWN: stored client commitment cannot be read." 75
  [[ "${attestation}" == \
    "action=attest-client clientId=${target_client_id} clientCount=${expected_count} tokenCommitment=${expected_commitment}" ]] \
    || fail "COMMIT_STATE_UNKNOWN: stored client commitment does not match the approved add." 75
}

create_mutation_container() {
  local action="$1" created_id inspected_id
  created_id="$(docker create -i --name "${updater_name}" \
    --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --user 1001:1001 \
    --pids-limit 64 --memory 128m --memory-swap 128m --cpus 0.5 \
    --mount "type=bind,src=${registry_dir},dst=${container_registry_dir}" \
    "${running_image}" node /app/dist/cli/gis-mcp-registry.js "${action}" \
    --path "${container_registry_file}" --client-id "${REGISTRY_CLIENT_ID}")"
  [[ "${created_id}" =~ ^[0-9a-f]{64}$ ]] \
    || fail "Updater container identity is invalid."
  inspected_id="$(docker container inspect --format '{{.Id}}' "${updater_name}")"
  [[ "${inspected_id}" == "${created_id}" \
    && "$(docker container inspect --format '{{.State.Status}}' "${updater_name}")" == "created" ]] \
    || fail "Updater container creation attestation failed."
}

run_mutation_container() {
  local action="$1" start_status=0 state exit_code running remaining
  write_operation_marker intent
  phase="mutation-started"
  set +e
  if [[ "${action}" == "add" ]]; then
    final_output="$(printf '%s\n' "${pending_digest}" | docker start -a -i "${updater_name}")"
    start_status=$?
    pending_digest=""
  else
    final_output="$(docker start -a "${updater_name}" </dev/null)"
    start_status=$?
  fi
  set -e

  state="$(docker container inspect --format '{{.State.Status}}' "${updater_name}")" \
    || fail "COMMIT_STATE_UNKNOWN: updater state is unavailable." 75
  exit_code="$(docker container inspect --format '{{.State.ExitCode}}' "${updater_name}")" \
    || fail "COMMIT_STATE_UNKNOWN: updater exit code is unavailable." 75
  running="$(docker container inspect --format '{{.State.Running}}' "${updater_name}")" \
    || fail "COMMIT_STATE_UNKNOWN: updater running state is unavailable." 75
  [[ "${state}" == "exited" && "${running}" == "false" && "${exit_code}" =~ ^[0-9]+$ ]] \
    || fail "COMMIT_STATE_UNKNOWN: updater did not reach an attested exit." 75
  docker rm -- "${updater_name}" >/dev/null \
    || fail "COMMIT_STATE_UNKNOWN: exited updater could not be removed." 75
  remaining="$(docker container ls -a --filter "name=${updater_name}" --format '{{.Names}}')" \
    || fail "COMMIT_STATE_UNKNOWN: updater removal cannot be verified." 75
  [[ -z "${remaining}" ]] \
    || fail "COMMIT_STATE_UNKNOWN: updater still exists after removal." 75

  if [[ "${exit_code}" -eq 1 || "${exit_code}" -eq 64 ]]; then
    registry_fs_attest 1 \
      || fail "COMMIT_STATE_UNKNOWN: failed updater left registry writer residue." 75
    local failure_output
    failure_output="$(readonly_cli "${post_name}" list)"
    parse_list "${failure_output}" "${REGISTRY_CLIENT_ID}"
    [[ "${parsed_count}" == "${pre_count}" && "${parsed_target}" == "${pre_target}" ]] \
      || fail "COMMIT_STATE_UNKNOWN: failed updater did not preserve the pre-state." 75
    check_registry
    verify_health "${pre_count}" \
      || fail "COMMIT_STATE_UNKNOWN: failed updater health does not prove the pre-state." 75
    verify_container_unchanged
    write_operation_marker known-precommit
    phase="known-precommit"
    fail "${action^} failed before registry commit and was not retried."
  elif [[ "${exit_code}" -ne 0 ]]; then
    fail "COMMIT_STATE_UNKNOWN: ${action} may have committed." 75
  fi
  # docker start/attach의 rc보다 exited container의 State.ExitCode를 신뢰한다.
  # attach rc가 달라도 아래 registry/health postcheck가 실제 commit을 재증명한다.
  : "${start_status}"
}

parsed_count=""
parsed_target=0
parse_list() {
  local output="$1" target="$2" index client
  local -a lines=()
  local -A seen=()
  mapfile -t lines <<< "${output}"
  [[ "${#lines[@]}" -ge 2 && "${lines[0]}" =~ ^action=list[[:space:]]clientCount=([1-9][0-9]*)$ ]] \
    || fail "List attestation is invalid."
  parsed_count="${BASH_REMATCH[1]}"
  (( parsed_count >= 1 && parsed_count <= 32 )) || fail "Client count is invalid."
  [[ "$(( ${#lines[@]} - 1 ))" -eq "${parsed_count}" ]] || fail "List count is inconsistent."
  parsed_target=0
  for ((index=1; index<${#lines[@]}; index+=1)); do
    [[ "${lines[index]}" =~ ^clientId=([a-z0-9]+(-[a-z0-9]+)*)$ ]] \
      || fail "List client ID is invalid."
    client="${BASH_REMATCH[1]}"
    [[ "${#client}" -le 64 && -z "${seen[${client}]+x}" ]] || fail "List client ID is duplicated."
    seen["${client}"]=1
    if [[ -n "${target}" && "${client}" == "${target}" ]]; then
      parsed_target=1
    fi
  done
  return 0
}

verify_health() {
  local count="$1"
  curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:3100/health \
    | docker exec -i -e EXPECTED_GIT_SHA="${running_git_sha}" \
        -e EXPECTED_IMAGE_TAG="${running_image_tag}" \
        -e EXPECTED_CLIENT_COUNT="${count}" "${container_name}" node -e '
      let body="";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", c => { body += c; });
      process.stdin.on("end", () => {
        try {
          const h=JSON.parse(body), f=h.features ?? {};
          const ok=h.status === "ok" && h.gitSha === process.env.EXPECTED_GIT_SHA
            && h.imageTag === process.env.EXPECTED_IMAGE_TAG
            && f.gisMcpConfigurationValid === true
            && f.gisMcpAuthMode === "client_registry"
            && f.gisMcpAuthSource === "file_registry"
            && f.gisMcpProviderMode === "vworld_and_data_portal"
            && String(f.gisMcpRegisteredClientCount) === process.env.EXPECTED_CLIENT_COUNT
            && String(f.gisMcpRegisteredTokenCount) === process.env.EXPECTED_CLIENT_COUNT;
          process.exit(ok ? 0 : 1);
        } catch { process.exit(1); }
      });' >/dev/null
}

verify_container_unchanged() {
  [[ "$(docker container inspect --format '{{.State.Running}}' "${container_name}")" == "true" ]] \
    && [[ "$(docker container inspect --format '{{.Id}}' "${container_name}")" == "${running_container_id}" ]] \
    && [[ "$(docker container inspect --format '{{.Image}}' "${container_name}")" == "${running_image}" ]] \
    && [[ "$(docker container inspect --format '{{.Config.Image}}' "${container_name}")" == "${configured_image}" ]] \
    || fail "Application container changed during the registry operation."
}

assert_no_registry_writer_residue() {
  local updater_count
  updater_count="$(count_registry_updaters)" \
    || fail "Registry updater enumeration failed."
  [[ "${updater_count}" == "0" ]] \
    || fail "A registry updater still exists."
  registry_fs_attest 1 || fail "Registry writer residue or file contract is unsafe."
}

acknowledge_operation() {
  [[ -e "${unknown_marker}" && ! -L "${unknown_marker}" ]] \
    || fail "ACK requires the durable operation marker."
  load_operation_marker
  [[ "${loaded_run_key}" == "${REGISTRY_RUN_ID}-${REGISTRY_RUN_ATTEMPT}" \
    && "${loaded_operation}" == "${REGISTRY_OPERATION}" \
    && "${loaded_operation_id}" == "${REGISTRY_OPERATION_ID}" \
    && "${loaded_client_id}" == "${client_id}" \
    && "${loaded_token_commitment}" == "${marker_token_commitment}" \
    && "${loaded_script_sha256}" == "${REGISTRY_EXPECTED_SCRIPT_SHA256}" ]] \
    || fail "ACK operation identity does not match."
  ack_marker_owned=1
  [[ "${loaded_outcome}" == "${ack_expected_outcome}" ]] \
    || fail "ACK operation outcome does not match."

  local expected_count expected_state current_state marker_identity marker_sha256
  local receipt_identity receipt_temp
  if [[ "${loaded_outcome}" == "verified" ]]; then
    expected_count="${loaded_post_count}"
    expected_state="${loaded_post_state}"
  else
    expected_count="${loaded_pre_count}"
    expected_state="${loaded_pre_state}"
  fi
  if [[ "${pre_target}" -eq 1 ]]; then current_state="present"; else current_state="absent"; fi
  [[ "${pre_count}" == "${expected_count}" && "${current_state}" == "${expected_state}" ]] \
    || fail "ACK registry state does not match the marked outcome."
  if [[ "${loaded_operation}" == "add" && "${loaded_outcome}" == "verified" ]]; then
    verify_add_content_commitment "${loaded_operation_id}" "${loaded_client_id}" \
      "${expected_count}" "${loaded_token_commitment}" "${post_name}"
  fi
  assert_no_registry_writer_residue
  check_registry
  verify_health "${pre_count}" || fail "ACK health evidence is inconsistent."
  verify_container_unchanged

  local run_entry run_entry_count=0
  while IFS= read -r -d '' run_entry; do
    [[ "${run_entry}" == "${run_root}" ]] \
      || fail "ACK found operation residue outside its marked run."
    run_entry_count="$((run_entry_count + 1))"
  done < <(find "${run_parent}" -mindepth 1 -maxdepth 1 -print0)
  [[ "${run_entry_count}" -eq 1 ]] || fail "ACK operation residue is incomplete."

  marker_identity="$(stat -c '%d:%i' "${unknown_marker}")"
  marker_sha256="$(sha256sum -- "${unknown_marker}" | awk '{print $1}')"
  load_operation_marker
  [[ "${loaded_run_key}" == "${REGISTRY_RUN_ID}-${REGISTRY_RUN_ATTEMPT}" \
    && "${loaded_operation}" == "${REGISTRY_OPERATION}" \
    && "${loaded_operation_id}" == "${REGISTRY_OPERATION_ID}" \
    && "${loaded_client_id}" == "${client_id}" \
    && "${loaded_token_commitment}" == "${marker_token_commitment}" \
    && "${loaded_script_sha256}" == "${REGISTRY_EXPECTED_SCRIPT_SHA256}" \
    && "${loaded_outcome}" == "${ack_expected_outcome}" \
    && "$(stat -c '%d:%i' "${unknown_marker}")" == "${marker_identity}" \
    && "$(sha256sum -- "${unknown_marker}" | awk '{print $1}')" == "${marker_sha256}" ]] \
    || fail "ACK operation marker changed during verification."
  if [[ -e "${receipts_dir}" || -L "${receipts_dir}" ]]; then
    [[ -d "${receipts_dir}" && ! -L "${receipts_dir}" \
      && "$(realpath -e -- "${receipts_dir}")" == "${receipts_dir}" \
      && "$(stat -c '%u:%a' "${receipts_dir}")" == "$(id -u):700" ]] \
      || fail "ACK receipt directory is invalid."
  else
    mkdir -m 700 -- "${receipts_dir}" || fail "ACK receipt directory cannot be created."
    sync -f "${app_root}" || fail "ACK receipt directory cannot be flushed."
  fi
  receipt_temp="${receipt_path}.tmp"
  if [[ ( -e "${receipt_path}" || -L "${receipt_path}" ) \
    && ( -e "${receipt_temp}" || -L "${receipt_temp}" ) ]]; then
    fail "ACK found both a receipt and a receipt temporary file."
  elif [[ -e "${receipt_path}" || -L "${receipt_path}" ]]; then
    [[ -f "${receipt_path}" && ! -L "${receipt_path}" \
      && "$(stat -c '%u:%a' "${receipt_path}")" == "$(id -u):600" \
      && "$(sha256sum -- "${receipt_path}" | awk '{print $1}')" == "${marker_sha256}" ]] \
      || fail "ACK existing receipt does not match the pending marker."
    receipt_identity="$(stat -c '%d:%i' "${receipt_path}")"
  elif [[ -e "${receipt_temp}" || -L "${receipt_temp}" ]]; then
    [[ -f "${receipt_temp}" && ! -L "${receipt_temp}" \
      && "$(stat -c '%u:%a' "${receipt_temp}")" == "$(id -u):600" \
      && "$(sha256sum -- "${receipt_temp}" | awk '{print $1}')" == "${marker_sha256}" ]] \
      || fail "ACK existing receipt temporary file does not match the pending marker."
    receipt_identity="$(stat -c '%d:%i' "${receipt_temp}")"
    sync -d "${receipt_temp}" || fail "ACK staged receipt cannot be flushed."
    [[ -f "${receipt_temp}" && ! -L "${receipt_temp}" \
      && "$(stat -c '%d:%i' "${receipt_temp}")" == "${receipt_identity}" \
      && "$(stat -c '%u:%a' "${receipt_temp}")" == "$(id -u):600" \
      && "$(sha256sum -- "${receipt_temp}" | awk '{print $1}')" == "${marker_sha256}" ]] \
      || fail "ACK staged receipt changed before publish."
    mv -T -- "${receipt_temp}" "${receipt_path}" \
      || fail "ACK staged receipt cannot be published."
  else
    (umask 077; set -o noclobber; printf '%s\n' "$(<"${unknown_marker}")" > "${receipt_temp}") \
      2>/dev/null || fail "ACK receipt cannot be staged."
    [[ -f "${receipt_temp}" && ! -L "${receipt_temp}" \
      && "$(stat -c '%u:%a' "${receipt_temp}")" == "$(id -u):600" \
      && "$(sha256sum -- "${receipt_temp}" | awk '{print $1}')" == "${marker_sha256}" ]] \
      || fail "ACK staged receipt cannot be attested."
    receipt_identity="$(stat -c '%d:%i' "${receipt_temp}")"
    sync -d "${receipt_temp}" || fail "ACK staged receipt cannot be flushed."
    [[ -f "${receipt_temp}" && ! -L "${receipt_temp}" \
      && "$(stat -c '%d:%i' "${receipt_temp}")" == "${receipt_identity}" \
      && "$(stat -c '%u:%a' "${receipt_temp}")" == "$(id -u):600" \
      && "$(sha256sum -- "${receipt_temp}" | awk '{print $1}')" == "${marker_sha256}" ]] \
      || fail "ACK staged receipt changed before publish."
    mv -T -- "${receipt_temp}" "${receipt_path}" \
      || fail "ACK staged receipt cannot be published."
  fi
  sync -d "${receipt_path}" || fail "ACK receipt cannot be flushed."
  sync -f "${receipts_dir}" || fail "ACK receipt directory update cannot be flushed."
  [[ -f "${receipt_path}" && ! -L "${receipt_path}" \
    && "$(stat -c '%d:%i' "${receipt_path}")" == "${receipt_identity}" \
    && "$(stat -c '%u:%a' "${receipt_path}")" == "$(id -u):600" \
    && "$(sha256sum -- "${receipt_path}" | awk '{print $1}')" == "${marker_sha256}" ]] \
    || fail "ACK durable receipt cannot be attested."
  assert_receipt_ledger_safe \
    || fail "ACK durable receipt ledger cannot be verified."
  [[ -f "${unknown_marker}" && ! -L "${unknown_marker}" \
    && "$(stat -c '%d:%i' "${unknown_marker}")" == "${marker_identity}" \
    && "$(sha256sum -- "${unknown_marker}" | awk '{print $1}')" == "${marker_sha256}" ]] \
    || fail "ACK marker changed before receipt commit."
  rm -f -- "${unknown_marker}" || fail "ACK marker cannot be retired."
  sync -f "${app_root}" || fail "ACK marker retirement cannot be flushed."
  [[ ! -e "${unknown_marker}" && ! -L "${unknown_marker}" ]] \
    || fail "ACK marker retirement is incomplete."
  ack_marker_owned=0
  phase="acknowledged"
  final_count="${pre_count}"
  final_output="action=ack operation=${REGISTRY_OPERATION} clientId=${client_id} outcome=${ack_expected_outcome} clientCount=${pre_count}"
}

recovery_stale_root=""
recovery_stale_active=""
recovery_stale_operator=""
recovery_unknown_identity=""
recovery_root_identity=""
recovery_active_identity=""
recovery_operator_identity=""
recovery_operator_sha256=""
recovery_unknown_sha256=""
recovery_active_sha256=""
recovery_residue_state="marker-only"
recovery_receipt_mode="none"
recovery_receipt_path=""
recovery_receipt_temp=""
recovery_receipt_identity=""
recovery_receipt_sha256=""
recovery_receipt_outcome=""
recovery_resolved_outcome=""
recovery_terminal_receipt_payload=""

recovery_terminal_payload() {
  local outcome="$1"
  [[ "${outcome}" =~ ^(verified|known-precommit)$ ]] \
    || fail "Recovery terminal outcome is invalid."
  printf \
    'version=4\nrunKey=%s\noperation=%s\noperationId=%s\nclientId=%s\npreCount=%s\npreState=%s\npostCount=%s\npostState=%s\ntokenCommitment=%s\nscriptSha256=%s\noutcome=%s' \
    "${loaded_run_key}" "${loaded_operation}" "${loaded_operation_id}" \
    "${loaded_client_id}" "${loaded_pre_count}" "${loaded_pre_state}" \
    "${loaded_post_count}" "${loaded_post_state}" "${loaded_token_commitment}" \
    "${loaded_script_sha256}" "${outcome}"
}

inspect_recovery_receipt_file() {
  local evidence_path="$1"
  local -a evidence_lines=()
  mapfile -t evidence_lines < "${evidence_path}"
  [[ "${#evidence_lines[@]}" -eq 12 \
    && "${evidence_lines[0]}" == "version=4" \
    && "${evidence_lines[1]}" == "runKey=${loaded_run_key}" \
    && "${evidence_lines[2]}" == "operation=${loaded_operation}" \
    && "${evidence_lines[3]}" == "operationId=${loaded_operation_id}" \
    && "${evidence_lines[4]}" == "clientId=${loaded_client_id}" \
    && "${evidence_lines[5]}" == "preCount=${loaded_pre_count}" \
    && "${evidence_lines[6]}" == "preState=${loaded_pre_state}" \
    && "${evidence_lines[7]}" == "postCount=${loaded_post_count}" \
    && "${evidence_lines[8]}" == "postState=${loaded_post_state}" \
    && "${evidence_lines[9]}" == "tokenCommitment=${loaded_token_commitment}" \
    && "${evidence_lines[10]}" == "scriptSha256=${loaded_script_sha256}" \
    && "${evidence_lines[11]}" =~ ^outcome=(verified|known-precommit)$ ]] \
    || fail "Recover receipt immutable fields do not match the pending marker."
  recovery_receipt_outcome="${evidence_lines[11]#outcome=}"
  if [[ "${loaded_outcome}" =~ ^(verified|known-precommit)$ ]]; then
    [[ "${recovery_receipt_outcome}" == "${loaded_outcome}" ]] \
      || fail "Recover receipt terminal outcome does not match the marker."
  fi
  [[ "$(<"${evidence_path}")" == "$(recovery_terminal_payload "${recovery_receipt_outcome}")" ]] \
    || fail "Recover receipt payload is not canonical."
  recovery_receipt_sha256="$(sha256sum -- "${evidence_path}" | awk '{print $1}')"
}

inspect_recovery_evidence() {
  [[ -e "${unknown_marker}" && ! -L "${unknown_marker}" ]] \
    || fail "Recover requires a durable operation marker."
  load_operation_marker
  local stale_run_key="${loaded_run_key}"
  local stale_operation="${loaded_operation}"
  local stale_operation_id="${loaded_operation_id}"
  local stale_client_id="${loaded_client_id}"
  local stale_receipt="${receipts_dir}/${stale_run_key}"
  local stale_receipt_temp="${stale_receipt}.tmp"
  [[ "${stale_run_key}" != "${REGISTRY_RUN_ID}-${REGISTRY_RUN_ATTEMPT}" ]] \
    || fail "Operation marker run identity is invalid."
  [[ "${stale_client_id}" == "${client_id}" ]] \
    || fail "Recover client ID does not match the marked operation."
  recovery_unknown_sha256="$(sha256sum -- "${unknown_marker}" | awk '{print $1}')"
  recovery_receipt_path="${stale_receipt}"
  recovery_receipt_temp="${stale_receipt_temp}"
  recovery_receipt_mode="none"
  recovery_receipt_identity=""
  recovery_receipt_sha256=""
  recovery_receipt_outcome=""
  if [[ ( -e "${stale_receipt}" || -L "${stale_receipt}" ) \
    && ( -e "${stale_receipt_temp}" || -L "${stale_receipt_temp}" ) ]]; then
    fail "Recover refuses simultaneous receipt and receipt temporary evidence."
  elif [[ -e "${stale_receipt}" || -L "${stale_receipt}" \
    || -e "${stale_receipt_temp}" || -L "${stale_receipt_temp}" ]]; then
    [[ -d "${receipts_dir}" && ! -L "${receipts_dir}" \
      && "$(realpath -e -- "${receipts_dir}")" == "${receipts_dir}" \
      && "$(stat -c '%u:%a' "${receipts_dir}")" == "$(id -u):700" ]] \
      || fail "Recover receipt directory is invalid."
    if [[ -e "${stale_receipt}" || -L "${stale_receipt}" ]]; then
      [[ -f "${stale_receipt}" && ! -L "${stale_receipt}" \
        && "$(stat -c '%u:%a' "${stale_receipt}")" == "$(id -u):600" ]] \
        || fail "Recover receipt is unsafe."
      inspect_recovery_receipt_file "${stale_receipt}"
      recovery_receipt_mode="receipt"
      recovery_receipt_identity="$(stat -c '%d:%i' "${stale_receipt}")"
    else
      [[ -f "${stale_receipt_temp}" && ! -L "${stale_receipt_temp}" \
        && "$(stat -c '%u:%a' "${stale_receipt_temp}")" == "$(id -u):600" ]] \
        || fail "Recover receipt temporary file is unsafe."
      inspect_recovery_receipt_file "${stale_receipt_temp}"
      recovery_receipt_mode="temp"
      recovery_receipt_identity="$(stat -c '%d:%i' "${stale_receipt_temp}")"
    fi
  fi

  [[ -d "${run_parent}" && ! -L "${run_parent}" ]] \
    && [[ "$(realpath -e -- "${run_parent}")" == "${run_parent}" ]] \
    && [[ "$(stat -c '%u:%a' "${run_parent}")" == "$(id -u):700" ]] \
    || fail "Operation parent directory is invalid."
  recovery_stale_root="${run_parent}/${stale_run_key}"
  recovery_stale_active="${recovery_stale_root}/active"
  recovery_stale_operator="${recovery_stale_root}/operator.sh"
  recovery_root_identity=""
  recovery_operator_identity=""
  recovery_operator_sha256=""
  recovery_active_identity=""
  recovery_active_sha256=""
  recovery_residue_state="marker-only"
  local stale_root_present=0
  if [[ -e "${recovery_stale_root}" || -L "${recovery_stale_root}" ]]; then
    [[ -d "${recovery_stale_root}" && ! -L "${recovery_stale_root}" ]] \
      && [[ "$(realpath -e -- "${recovery_stale_root}")" == "${recovery_stale_root}" ]] \
      && [[ "$(stat -c '%u:%a' "${recovery_stale_root}")" == "$(id -u):700" ]] \
      || fail "Stale operation directory is invalid."
    stale_root_present=1
  fi
  local pre_reconcile_updater_count
  pre_reconcile_updater_count="$(count_registry_updaters)" \
    || fail "Recover cannot enumerate registry updaters before residue reconciliation."
  [[ "${pre_reconcile_updater_count}" == "0" ]] \
    || fail "Recover refuses while any registry updater exists."
  registry_fs_attest 1 \
    || fail "Recover refuses while registry writer residue or an unsafe file contract exists."
  reconcile_unmarked_run_residue "${recovery_stale_root}"
  local run_entry run_entry_count=0
  while IFS= read -r -d '' run_entry; do
    [[ "${run_entry}" == "${run_root}" || "${run_entry}" == "${recovery_stale_root}" ]] \
      || fail "Recover found an operation directory not covered by the unknown marker."
    run_entry_count="$((run_entry_count + 1))"
  done < <(find "${run_parent}" -mindepth 1 -maxdepth 1 -print0)
  [[ "${run_entry_count}" -eq "$((1 + stale_root_present))" ]] \
    || fail "Recover found operation residue not covered by the unknown marker."
  if [[ "${stale_root_present}" -eq 1 ]]; then
    local entry base entry_count=0 operator_present=0 active_present=0
    while IFS= read -r -d '' entry; do
      base="${entry##*/}"
      if [[ "${base}" == "operator.sh" ]]; then
        operator_present=1
      elif [[ "${base}" == "active" ]]; then
        active_present=1
      else
        fail "Stale operation directory contains unexpected evidence."
      fi
      entry_count="$((entry_count + 1))"
    done < <(find "${recovery_stale_root}" -mindepth 1 -maxdepth 1 -print0)
    (( entry_count <= 2 )) || fail "Stale operation evidence count is invalid."
    if [[ "${operator_present}" -eq 1 && "${active_present}" -eq 1 ]]; then
      recovery_residue_state="active-operator"
    elif [[ "${operator_present}" -eq 1 ]]; then
      recovery_residue_state="operator"
    elif [[ "${active_present}" -eq 0 && "${entry_count}" -eq 0 ]]; then
      recovery_residue_state="empty"
    else
      fail "Recover refuses unreachable active-only residue."
    fi
    if [[ "${operator_present}" -eq 1 ]]; then
      [[ -f "${recovery_stale_operator}" && ! -L "${recovery_stale_operator}" \
        && "$(stat -c '%u:%a' "${recovery_stale_operator}")" == "$(id -u):600" ]] \
        || fail "Stale operator evidence is invalid."
    fi
    if [[ "${active_present}" -eq 1 ]]; then
      [[ -f "${recovery_stale_active}" && ! -L "${recovery_stale_active}" ]] \
        && [[ "$(stat -c '%u:%a' "${recovery_stale_active}")" == "$(id -u):600" ]] \
        || fail "Stale active evidence is invalid."
      local -a active_lines=()
      mapfile -t active_lines < "${recovery_stale_active}"
      [[ "${#active_lines[@]}" -eq 5 \
        && "${active_lines[0]}" == "version=2" \
        && "${active_lines[1]}" == "runKey=${stale_run_key}" ]] \
        || fail "Stale active evidence format is invalid."
      local stale_pid="${active_lines[2]#pid=}"
      local stale_boot_id="${active_lines[3]#bootId=}"
      local stale_start_time="${active_lines[4]#startTime=}"
      [[ "${active_lines[2]}" == "pid=${stale_pid}" && "${stale_pid}" =~ ^[1-9][0-9]*$ \
        && "${active_lines[3]}" == "bootId=${stale_boot_id}" \
        && "${stale_boot_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ \
        && "${active_lines[4]}" == "startTime=${stale_start_time}" \
        && "${stale_start_time}" =~ ^[1-9][0-9]*$ ]] \
        || fail "Stale active process identity is invalid."
      local current_boot_id="$(< /proc/sys/kernel/random/boot_id)"
      [[ "${current_boot_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
        || fail "Current boot identity is invalid."
      if [[ "${stale_boot_id}" == "${current_boot_id}" \
        && ( -e "/proc/${stale_pid}/stat" || -L "/proc/${stale_pid}/stat" ) ]]; then
        [[ -r "/proc/${stale_pid}/stat" && ! -L "/proc/${stale_pid}/stat" ]] \
          || fail "Stale operator process state cannot be verified."
        local stale_proc_stat stale_proc_tail
        local -a stale_proc_fields=()
        stale_proc_stat="$(< "/proc/${stale_pid}/stat")"
        stale_proc_tail="${stale_proc_stat##*) }"
        read -r -a stale_proc_fields <<< "${stale_proc_tail}"
        [[ "${stale_proc_fields[19]:-}" =~ ^[1-9][0-9]*$ ]] \
          || fail "Stale operator process start time cannot be verified."
        [[ "${stale_proc_fields[19]}" != "${stale_start_time}" ]] \
          || fail "Recover refuses while the stale operator process is still alive."
      fi
    fi
  else
    [[ ! -e "${recovery_stale_active}" && ! -L "${recovery_stale_active}" \
      && ! -e "${recovery_stale_operator}" && ! -L "${recovery_stale_operator}" ]] \
      || fail "Marker-only recovery paths are not absent."
  fi

  local updater_count
  updater_count="$(count_registry_updaters)" \
    || fail "Recover cannot enumerate registry updaters."
  [[ "${updater_count}" == "0" ]] || fail "Recover refuses while any registry updater exists."
  registry_fs_attest 1 \
    || fail "Recover refuses while registry writer residue or an unsafe file contract exists."

  recovery_unknown_identity="$(stat -c '%d:%i' "${unknown_marker}")"
  if [[ "${stale_root_present}" -eq 1 ]]; then
    recovery_root_identity="$(stat -c '%d:%i' "${recovery_stale_root}")"
  fi
  if [[ "${stale_root_present}" -eq 1 \
    && -f "${recovery_stale_operator}" && ! -L "${recovery_stale_operator}" ]]; then
    recovery_operator_identity="$(stat -c '%d:%i' "${recovery_stale_operator}")"
    recovery_operator_sha256="$(sha256sum -- "${recovery_stale_operator}" | awk '{print $1}')"
    [[ "${recovery_operator_sha256}" == "${loaded_script_sha256}" ]] \
      || fail "Stale operator does not match the marker script revision."
  fi
  if [[ "${stale_root_present}" -eq 1 \
    && -f "${recovery_stale_active}" && ! -L "${recovery_stale_active}" ]]; then
    recovery_active_identity="$(stat -c '%d:%i' "${recovery_stale_active}")"
    recovery_active_sha256="$(sha256sum -- "${recovery_stale_active}" | awk '{print $1}')"
  fi
}

ensure_recovery_receipt_published() {
  [[ "${recovery_resolved_outcome}" =~ ^(verified|known-precommit)$ ]] \
    || fail "Recovery outcome was not resolved before receipt publication."
  recovery_terminal_receipt_payload="$(recovery_terminal_payload "${recovery_resolved_outcome}")"
  local expected_receipt_sha256 receipt_identity
  expected_receipt_sha256="$(printf '%s\n' "${recovery_terminal_receipt_payload}" | sha256sum | awk '{print $1}')"
  [[ "${expected_receipt_sha256}" =~ ^[0-9a-f]{64}$ ]] \
    || fail "Recovery receipt digest cannot be computed."
  if [[ -n "${recovery_receipt_outcome}" ]]; then
    [[ "${recovery_receipt_outcome}" == "${recovery_resolved_outcome}" ]] \
      || fail "Recovery receipt outcome does not match the current endpoint."
  fi
  [[ -f "${unknown_marker}" && ! -L "${unknown_marker}" \
    && "$(stat -c '%d:%i' "${unknown_marker}")" == "${recovery_unknown_identity}" \
    && "$(stat -c '%u:%a' "${unknown_marker}")" == "$(id -u):600" \
    && "$(sha256sum -- "${unknown_marker}" | awk '{print $1}')" == "${recovery_unknown_sha256}" ]] \
    || fail "Recovery marker changed before receipt publication."

  if [[ -e "${receipts_dir}" || -L "${receipts_dir}" ]]; then
    [[ -d "${receipts_dir}" && ! -L "${receipts_dir}" \
      && "$(realpath -e -- "${receipts_dir}")" == "${receipts_dir}" \
      && "$(stat -c '%u:%a' "${receipts_dir}")" == "$(id -u):700" ]] \
      || fail "Recovery receipt directory is invalid."
  else
    mkdir -m 700 -- "${receipts_dir}" \
      || fail "Recovery receipt directory cannot be created."
    sync -f "${app_root}" || fail "Recovery receipt directory cannot be flushed."
  fi

  if [[ "${recovery_receipt_mode}" == "receipt" ]]; then
    assert_receipt_ledger_safe \
      || fail "Recovery receipt ledger is unsafe before evidence cleanup."
    [[ -f "${recovery_receipt_path}" && ! -L "${recovery_receipt_path}" \
      && "$(stat -c '%d:%i' "${recovery_receipt_path}")" == "${recovery_receipt_identity}" \
      && "$(stat -c '%u:%a' "${recovery_receipt_path}")" == "$(id -u):600" \
      && "$(sha256sum -- "${recovery_receipt_path}" | awk '{print $1}')" == "${expected_receipt_sha256}" \
      && ! -e "${recovery_receipt_temp}" && ! -L "${recovery_receipt_temp}" ]] \
      || fail "Recovery durable receipt changed before cleanup."
  elif [[ "${recovery_receipt_mode}" == "temp" ]]; then
    assert_receipt_ledger_safe "${loaded_operation_id}" "${recovery_receipt_temp}" \
      || fail "Recovery receipt ledger is unsafe before staged receipt publication."
    [[ -f "${recovery_receipt_temp}" && ! -L "${recovery_receipt_temp}" \
      && "$(stat -c '%d:%i' "${recovery_receipt_temp}")" == "${recovery_receipt_identity}" \
      && "$(stat -c '%u:%a' "${recovery_receipt_temp}")" == "$(id -u):600" \
      && "$(sha256sum -- "${recovery_receipt_temp}" | awk '{print $1}')" == "${expected_receipt_sha256}" \
      && ! -e "${recovery_receipt_path}" && ! -L "${recovery_receipt_path}" ]] \
      || fail "Recovery staged receipt changed before publication."
    sync -d "${recovery_receipt_temp}" \
      || fail "Recovery staged receipt could not be flushed."
    [[ -f "${recovery_receipt_temp}" && ! -L "${recovery_receipt_temp}" \
      && "$(stat -c '%d:%i' "${recovery_receipt_temp}")" == "${recovery_receipt_identity}" \
      && "$(sha256sum -- "${recovery_receipt_temp}" | awk '{print $1}')" == "${expected_receipt_sha256}" ]] \
      || fail "Recovery staged receipt changed before publish."
    mv -T -- "${recovery_receipt_temp}" "${recovery_receipt_path}" \
      || fail "Recovery staged receipt could not be published."
  elif [[ "${recovery_receipt_mode}" == "none" ]]; then
    assert_receipt_ledger_safe "${loaded_operation_id}" \
      || fail "Recovery receipt ledger is unsafe before terminal receipt creation."
    [[ ! -e "${recovery_receipt_path}" && ! -L "${recovery_receipt_path}" \
      && ! -e "${recovery_receipt_temp}" && ! -L "${recovery_receipt_temp}" ]] \
      || fail "Recovery receipt evidence appeared before creation."
    (umask 077; set -o noclobber; printf '%s\n' "${recovery_terminal_receipt_payload}" \
      > "${recovery_receipt_temp}") 2>/dev/null \
      || fail "Recovery terminal receipt cannot be staged."
    [[ -f "${recovery_receipt_temp}" && ! -L "${recovery_receipt_temp}" \
      && "$(stat -c '%u:%a' "${recovery_receipt_temp}")" == "$(id -u):600" \
      && "$(sha256sum -- "${recovery_receipt_temp}" | awk '{print $1}')" == "${expected_receipt_sha256}" ]] \
      || fail "Recovery terminal receipt cannot be attested."
    recovery_receipt_identity="$(stat -c '%d:%i' "${recovery_receipt_temp}")"
    sync -d "${recovery_receipt_temp}" \
      || fail "Recovery terminal receipt could not be flushed."
    [[ -f "${recovery_receipt_temp}" && ! -L "${recovery_receipt_temp}" \
      && "$(stat -c '%d:%i' "${recovery_receipt_temp}")" == "${recovery_receipt_identity}" \
      && "$(sha256sum -- "${recovery_receipt_temp}" | awk '{print $1}')" == "${expected_receipt_sha256}" ]] \
      || fail "Recovery terminal receipt changed before publish."
    mv -T -- "${recovery_receipt_temp}" "${recovery_receipt_path}" \
      || fail "Recovery terminal receipt could not be published."
  else
    fail "Recovery receipt mode is invalid."
  fi

  sync -d "${recovery_receipt_path}" \
    || fail "Recovery published receipt could not be flushed."
  sync -f "${receipts_dir}" \
    || fail "Recovery receipt directory update could not be flushed."
  [[ -f "${recovery_receipt_path}" && ! -L "${recovery_receipt_path}" \
    && "$(stat -c '%u:%a' "${recovery_receipt_path}")" == "$(id -u):600" \
    && "$(sha256sum -- "${recovery_receipt_path}" | awk '{print $1}')" == "${expected_receipt_sha256}" \
    && ! -e "${recovery_receipt_temp}" && ! -L "${recovery_receipt_temp}" ]] \
    || fail "Recovery durable receipt cannot be attested."
  receipt_identity="$(stat -c '%d:%i' "${recovery_receipt_path}")"
  [[ "${receipt_identity}" == "${recovery_receipt_identity}" ]] \
    || fail "Recovery published receipt identity is inconsistent."
  inspect_recovery_receipt_file "${recovery_receipt_path}"
  [[ "${recovery_receipt_outcome}" == "${recovery_resolved_outcome}" \
    && "${recovery_receipt_sha256}" == "${expected_receipt_sha256}" ]] \
    || fail "Recovery durable receipt payload cannot be verified."
  assert_receipt_ledger_safe \
    || fail "Recovery durable receipt ledger cannot be verified."
  recovery_receipt_mode="receipt"
  recovery_receipt_identity="${receipt_identity}"
}

remove_recovery_evidence() {
  [[ "$(stat -c '%d:%i' "${unknown_marker}")" == "${recovery_unknown_identity}" ]] \
    && [[ "$(stat -c '%u:%a' "${unknown_marker}")" == "$(id -u):600" ]] \
    && [[ "$(sha256sum -- "${unknown_marker}" | awk '{print $1}')" == "${recovery_unknown_sha256}" ]] \
    || fail "Recovery evidence changed after inspection."
  local updater_count
  updater_count="$(count_registry_updaters)" \
    || fail "Recovery safety state cannot enumerate registry updaters."
  [[ "${updater_count}" == "0" ]] \
    || fail "Recovery safety state found a registry updater."
  registry_fs_attest 1 \
    || fail "Recovery safety state found writer residue or an unsafe file contract."
  [[ "${recovery_receipt_mode}" == "receipt" \
    && -f "${recovery_receipt_path}" && ! -L "${recovery_receipt_path}" \
    && "$(stat -c '%d:%i' "${recovery_receipt_path}")" == "${recovery_receipt_identity}" \
    && "$(stat -c '%u:%a' "${recovery_receipt_path}")" == "$(id -u):600" \
    && "$(sha256sum -- "${recovery_receipt_path}" | awk '{print $1}')" == "${recovery_receipt_sha256}" \
    && "${recovery_receipt_outcome}" == "${recovery_resolved_outcome}" \
    && ! -e "${recovery_receipt_temp}" && ! -L "${recovery_receipt_temp}" ]] \
    || fail "Recovery durable receipt changed after publication."
  inspect_recovery_receipt_file "${recovery_receipt_path}"
  [[ "${recovery_receipt_outcome}" == "${recovery_resolved_outcome}" ]] \
    || fail "Recovery durable receipt outcome changed before cleanup."
  [[ -f "${unknown_marker}" && ! -L "${unknown_marker}" \
    && "$(stat -c '%d:%i' "${unknown_marker}")" == "${recovery_unknown_identity}" \
    && "$(sha256sum -- "${unknown_marker}" | awk '{print $1}')" == "${recovery_unknown_sha256}" ]] \
    || fail "Recovery pending marker changed before cleanup."
  if [[ -n "${recovery_root_identity}" ]]; then
    [[ -d "${recovery_stale_root}" && ! -L "${recovery_stale_root}" ]] \
      && [[ "$(stat -c '%d:%i' "${recovery_stale_root}")" == "${recovery_root_identity}" ]] \
      && [[ "$(stat -c '%u:%a' "${recovery_stale_root}")" == "$(id -u):700" ]] \
      || fail "Recovery residue changed after inspection."
    if [[ -n "${recovery_active_identity}" ]]; then
      [[ -f "${recovery_stale_active}" && ! -L "${recovery_stale_active}" ]] \
        && [[ "$(stat -c '%d:%i' "${recovery_stale_active}")" == "${recovery_active_identity}" ]] \
        && [[ "$(stat -c '%u:%a' "${recovery_stale_active}")" == "$(id -u):600" ]] \
        && [[ "$(sha256sum -- "${recovery_stale_active}" | awk '{print $1}')" == "${recovery_active_sha256}" ]] \
        || fail "Stale active evidence changed after inspection."
      rm -f -- "${recovery_stale_active}"
    else
      [[ ! -e "${recovery_stale_active}" && ! -L "${recovery_stale_active}" ]] \
        || fail "Stale active evidence appeared after inspection."
    fi
    if [[ -n "${recovery_operator_identity}" ]]; then
      [[ -f "${recovery_stale_operator}" && ! -L "${recovery_stale_operator}" \
        && "$(stat -c '%d:%i' "${recovery_stale_operator}")" == "${recovery_operator_identity}" \
        && "$(stat -c '%u:%a' "${recovery_stale_operator}")" == "$(id -u):600" \
        && "$(sha256sum -- "${recovery_stale_operator}" | awk '{print $1}')" == "${recovery_operator_sha256}" ]] \
        || fail "Stale operator evidence changed after inspection."
      rm -f -- "${recovery_stale_operator}"
    else
      [[ ! -e "${recovery_stale_operator}" && ! -L "${recovery_stale_operator}" ]] \
        || fail "Stale operator evidence appeared after inspection."
    fi
    rmdir -- "${recovery_stale_root}"
  else
    [[ ! -e "${recovery_stale_root}" && ! -L "${recovery_stale_root}" \
      && ! -e "${recovery_stale_active}" && ! -L "${recovery_stale_active}" \
      && ! -e "${recovery_stale_operator}" && ! -L "${recovery_stale_operator}" ]] \
      || fail "Marker-only recovery residue appeared after inspection."
  fi
  sync -f "${run_parent}"
  rm -f -- "${unknown_marker}"
  sync -f "${app_root}"
  [[ ! -e "${recovery_stale_root}" && ! -L "${recovery_stale_root}" \
    && ! -e "${unknown_marker}" && ! -L "${unknown_marker}" ]] \
    || fail "Recovery evidence cleanup was incomplete."
}

pre_output="$(readonly_cli "${pre_name}" list)"
parse_list "${pre_output}" "${REGISTRY_CLIENT_ID:-}"
pre_count="${parsed_count}"
pre_target="${parsed_target}"
verify_health "${pre_count}" || fail "Pre-operation health is inconsistent."
final_output="${pre_output}"
final_count="${pre_count}"

if [[ "${protocol_action}" == "ack" ]]; then
  acknowledge_operation
elif [[ "${REGISTRY_OPERATION}" == "add" ]]; then
  if [[ "${pre_target}" -ne 0 || "${pre_count}" -ge 32 ]]; then
    marker_pre_count="${pre_count}"
    marker_post_count="${pre_count}"
    if [[ "${pre_target}" -eq 1 ]]; then
      marker_pre_state="present"
      marker_post_state="present"
    else
      marker_pre_state="absent"
      marker_post_state="absent"
    fi
    write_operation_marker known-precommit
    phase="known-precommit"
    fail "Add precondition failed."
  fi
  marker_pre_count="${pre_count}"
  marker_pre_state="absent"
  marker_post_count="$((pre_count + 1))"
  marker_post_state="present"
  create_mutation_container add
  run_mutation_container add
elif [[ "${REGISTRY_OPERATION}" == "revoke" ]]; then
  if [[ "${pre_target}" -ne 1 || "${pre_count}" -le 1 ]]; then
    marker_pre_count="${pre_count}"
    marker_post_count="${pre_count}"
    if [[ "${pre_target}" -eq 1 ]]; then
      marker_pre_state="present"
      marker_post_state="present"
    else
      marker_pre_state="absent"
      marker_post_state="absent"
    fi
    write_operation_marker known-precommit
    phase="known-precommit"
    fail "Revoke precondition failed."
  fi
  marker_pre_count="${pre_count}"
  marker_pre_state="present"
  marker_post_count="$((pre_count - 1))"
  marker_post_state="absent"
  create_mutation_container revoke
  run_mutation_container revoke
elif [[ "${REGISTRY_OPERATION}" == "validate" ]]; then
  final_output="$(readonly_cli "${updater_name}" validate)"
  [[ "${final_output}" == "clientCount=${pre_count}" ]] || fail "Validate attestation is invalid."
elif [[ "${REGISTRY_OPERATION}" == "recover" ]]; then
  inspect_recovery_evidence
  [[ "${pre_count}" == "${expected_client_count}" ]] \
    || fail "Recover client count does not match the operator-approved count."
  if [[ "${expected_client_state}" == "present" ]]; then
    [[ "${pre_target}" -eq 1 ]] \
      || fail "Recover target is absent but present was approved."
  else
    [[ "${pre_target}" -eq 0 ]] \
      || fail "Recover target is present but absent was approved."
  fi
  current_state="absent"
  [[ "${pre_target}" -eq 1 ]] && current_state="present"
  if [[ "${loaded_outcome}" == "verified" ]]; then
    [[ "${pre_count}" == "${loaded_post_count}" \
      && "${current_state}" == "${loaded_post_state}" ]] \
      || fail "Recover current state does not match the verified post-state."
    recovery_resolved_outcome="verified"
  elif [[ "${loaded_outcome}" == "known-precommit" ]]; then
    [[ "${pre_count}" == "${loaded_pre_count}" \
      && "${current_state}" == "${loaded_pre_state}" ]] \
      || fail "Recover current state does not match the known pre-state."
    recovery_resolved_outcome="known-precommit"
  else
    matches_pre=0
    matches_post=0
    [[ "${pre_count}" == "${loaded_pre_count}" \
      && "${current_state}" == "${loaded_pre_state}" ]] && matches_pre=1
    [[ "${pre_count}" == "${loaded_post_count}" \
      && "${current_state}" == "${loaded_post_state}" ]] && matches_post=1
    [[ "$((matches_pre + matches_post))" -eq 1 ]] \
      || fail "Recover current state is not exactly one marked transition endpoint."
    if [[ "${matches_post}" -eq 1 ]]; then
      recovery_resolved_outcome="verified"
    else
      recovery_resolved_outcome="known-precommit"
    fi
  fi
  if [[ "${loaded_operation}" == "add" && "${recovery_resolved_outcome}" == "verified" ]]; then
    verify_add_content_commitment "${loaded_operation_id}" "${loaded_client_id}" \
      "${loaded_post_count}" "${loaded_token_commitment}" "${post_name}"
  fi
  check_registry
  verify_health "${pre_count}" || fail "Recover health evidence is inconsistent."
  verify_container_unchanged
  ensure_recovery_receipt_published
  phase="recovery-cleanup"
  remove_recovery_evidence
  check_registry
  recovery_post_output="$(readonly_cli "${post_name}" list)"
  parse_list "${recovery_post_output}" "${REGISTRY_CLIENT_ID}"
  [[ "${parsed_count}" == "${pre_count}" && "${parsed_target}" == "${pre_target}" ]] \
    || fail "Registry state changed during recovery evidence cleanup."
  verify_health "${pre_count}" || fail "Recover post-cleanup health is inconsistent."
  verify_container_unchanged
  final_output="action=recover clientId=${client_id} clientState=${expected_client_state} clientCount=${pre_count}"
fi

if [[ "${mutation}" -eq 1 ]]; then
  registry_fs_attest 1 1 \
    || fail "Mutation postcondition did not converge the registry file to canonical GID 1001."
  post_output="$(readonly_cli "${post_name}" list)"
  parse_list "${post_output}" "${REGISTRY_CLIENT_ID}"
  final_count="${parsed_count}"
  if [[ "${REGISTRY_OPERATION}" == "add" ]]; then
    [[ "${parsed_target}" -eq 1 && "${final_count}" -eq "$((pre_count + 1))" ]] \
      || fail "Add postcondition failed."
    verify_add_content_commitment "${REGISTRY_OPERATION_ID}" "${REGISTRY_CLIENT_ID}" \
      "${final_count}" "${marker_token_commitment}" "${post_name}"
    final_output="action=add clientId=${REGISTRY_CLIENT_ID} clientCount=${final_count}"
  else
    [[ "${parsed_target}" -eq 0 && "${final_count}" -eq "$((pre_count - 1))" ]] \
      || fail "Revoke postcondition failed."
    final_output="action=revoke clientId=${REGISTRY_CLIENT_ID} clientCount=${final_count}"
  fi
fi
check_registry
verify_health "${final_count}" || fail "Live health did not reflect the registry operation."
verify_container_unchanged
if [[ "${mutation}" -eq 1 ]]; then
  write_operation_marker verified
fi
phase="verified"
printf '%s\n' "${final_output}"
printf 'verified operation=%s operationId=%s clientCount=%s gitSha=%s\n' \
  "${REGISTRY_OPERATION}" "${REGISTRY_OPERATION_ID}" "${final_count}" "${running_git_sha}"
