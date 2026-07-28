#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ "$#" -ne 6 ]]; then
  echo "usage: $0 <ciphertext.age> <age-identity> <private-target.json> <redacted-artifact.json> <source-release-sha> <private-output.json>" >&2
  exit 64
fi

ciphertext="$1"
identity="$2"
private_target="$3"
redacted_artifact="$4"
source_release_sha="$5"
private_output="$6"
expected_recipient_sha256="${LDAREG_APPROVAL_AGE_RECIPIENT_SHA256:-}"
script_root="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  pwd -P
)"
validator="${script_root}/dist/cli/development-api-authoritative-ldareg-backfill-approval-request-validate.js"
materializer="${script_root}/dist/cli/development-api-authoritative-ldareg-private-file-materialize.js"
stager="${script_root}/dist/cli/development-api-authoritative-ldareg-private-file-stage.js"

stat_uid() {
  if stat -c '%u' "$1" >/dev/null 2>&1; then
    stat -c '%u' "$1"
  else
    stat -f '%u' "$1"
  fi
}

stat_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

stat_identity() {
  if stat -L -c '%d:%i:%s' -- "$1" >/dev/null 2>&1; then
    stat -L -c '%d:%i:%s' -- "$1"
  else
    # macOS fdescfs는 /dev/fd/N에 별도 device id를 보고하므로
    # underlying vnode의 inode와 size를 함께 고정한다.
    stat -L -f '%i:%z' "$1"
  fi
}

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

if [[
  ! "${source_release_sha}" =~ ^[0-9a-f]{40}$
  || ! "${expected_recipient_sha256}" =~ ^[0-9a-f]{64}$
  || "$(age --version)" != "v1.3.1"
  || ! -f "${validator}"
  || -L "${validator}"
  || ! -f "${materializer}"
  || -L "${materializer}"
  || ! -f "${stager}"
  || -L "${stager}"
 ]]; then
  exit 65
fi

for private_input in \
  "${ciphertext}" \
  "${identity}" \
  "${private_target}" \
  "${redacted_artifact}"
do
  private_input_parent="$(dirname -- "${private_input}")"
  if [[
    ! -f "${private_input}"
    || -L "${private_input}"
    || "$(stat_uid "${private_input}")" != "$(id -u)"
    || "$(( 8#$(stat_mode "${private_input}") & 8#077 ))" -ne 0
    || ! -d "${private_input_parent}"
    || -L "${private_input_parent}"
    || "$(stat_uid "${private_input_parent}")" != "$(id -u)"
    || "$(stat_mode "${private_input_parent}")" != "700"
  ]]; then
    exit 66
  fi
done

output_parent="$(cd "$(dirname "${private_output}")" && pwd -P)"
if [[
  ! -d "${output_parent}"
  || -L "${output_parent}"
  || "$(stat_uid "${output_parent}")" != "$(id -u)"
  || "$(stat_mode "${output_parent}")" != "700"
  || -e "${private_output}"
  || -L "${private_output}"
 ]]; then
  exit 70
fi

validation_root="$(
  mktemp -d "${output_parent}/.ldareg-owner-validation-${source_release_sha}.XXXXXX"
)"
validation_private="${validation_root}/.development-api-authoritative-ldareg-backfill"
staged_ciphertext="${validation_private}/ciphertext.age"
staged_identity="${validation_private}/identity.txt"
staged_target="${validation_private}/target.json"
staged_artifact="${validation_private}/artifact.json"
plaintext_temporary="${validation_private}/owner-package.json"
cleanup_plaintext() {
  exec 7<&- || true
  exec 8<&- || true
  exec 9<&- || true
  rm -f -- \
    "${staged_ciphertext}" \
    "${staged_identity}" \
    "${staged_target}" \
    "${staged_artifact}" \
    "${plaintext_temporary}"
  if [[ -d "${validation_private}" && ! -L "${validation_private}" ]]; then
    rmdir -- "${validation_private}" 2>/dev/null || true
  fi
  if [[ -d "${validation_root}" && ! -L "${validation_root}" ]]; then
    rmdir -- "${validation_root}" 2>/dev/null || true
  fi
}
trap cleanup_plaintext EXIT

chmod 700 -- "${validation_root}"
if [[
  ! -d "${validation_root}"
  || -L "${validation_root}"
  || "$(stat_uid "${validation_root}")" != "$(id -u)"
  || "$(stat_mode "${validation_root}")" != "700"
 ]]; then
  exit 67
fi
mkdir -m 700 -- "${validation_private}"

stage_private_input() {
  local source_path="$1"
  local output_path="$2"
  local maximum_bytes="$3"
  local stage_output
  stage_output="$(
    node "${stager}" \
      --source "${source_path}" \
      --out "${output_path}" \
      --max-bytes "${maximum_bytes}"
  )"
  if [[ "${stage_output}" != "DEVELOPMENT_API_AUTHORITATIVE_LDAREG_PRIVATE_FILE_STAGED" ]]; then
    exit 72
  fi
}

stage_private_input "${ciphertext}" "${staged_ciphertext}" 3145728
stage_private_input "${identity}" "${staged_identity}" 65536
stage_private_input "${private_target}" "${staged_target}" 262144
stage_private_input "${redacted_artifact}" "${staged_artifact}" 3145728

exec 7<"${staged_identity}"
exec 8<"${staged_identity}"
exec 9<"${staged_ciphertext}"
if [[
  ! -f /dev/fd/7
  || ! -f /dev/fd/8
  || ! -f /dev/fd/9
  || -L "${staged_identity}"
  || -L "${staged_ciphertext}"
  || "$(stat_identity "${staged_identity}")" != "$(stat_identity /dev/fd/7)"
  || "$(stat_identity "${staged_identity}")" != "$(stat_identity /dev/fd/8)"
  || "$(stat_identity "${staged_ciphertext}")" != "$(stat_identity /dev/fd/9)"
 ]]; then
  exit 74
fi

recipient="$(age-keygen -y /dev/fd/7)"
if [[ ! "${recipient}" =~ ^age1[0-9a-z]{58}$ ]]; then
  exit 68
fi
actual_recipient_sha256="$(
  printf '%s' "${recipient}" | sha256_stdin
)"
if [[ "${actual_recipient_sha256}" != "${expected_recipient_sha256}" ]]; then
  exit 69
fi

if [[
  -L "${staged_identity}"
  || -L "${staged_ciphertext}"
  || "$(stat_identity "${staged_identity}")" != "$(stat_identity /dev/fd/8)"
  || "$(stat_identity "${staged_ciphertext}")" != "$(stat_identity /dev/fd/9)"
 ]]; then
  exit 75
fi
materialize_output="$(
  age --decrypt \
    --identity /dev/fd/8 \
    /dev/fd/9 \
    | node "${materializer}" \
        --out "${plaintext_temporary}" \
        --encoding raw \
        --max-bytes 3145728
)"
if [[ "${materialize_output}" != "DEVELOPMENT_API_AUTHORITATIVE_LDAREG_PRIVATE_FILE_MATERIALIZED" ]]; then
  exit 73
fi

validation_output="$(
  cd "${validation_root}"
  node "${validator}" \
    --target ".development-api-authoritative-ldareg-backfill/target.json" \
    --artifact ".development-api-authoritative-ldareg-backfill/artifact.json" \
    --request ".development-api-authoritative-ldareg-backfill/owner-package.json" \
    --source-release-sha "${source_release_sha}"
)"
if [[ "${validation_output}" != "DEVELOPMENT_API_AUTHORITATIVE_LDAREG_APPROVAL_REQUEST_VALIDATED" ]]; then
  exit 71
fi

stage_private_input "${plaintext_temporary}" "${private_output}" 3145728
test -f "${private_output}"
test ! -L "${private_output}"
test "$(stat_uid "${private_output}")" = "$(id -u)"
test "$(stat_mode "${private_output}")" = "600"
printf '%s\n' "OWNER_APPROVAL_REQUEST_DECRYPTED_VALIDATED_AND_INSTALLED_0600"
