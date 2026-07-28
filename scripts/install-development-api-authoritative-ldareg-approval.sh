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
 ]]; then
  exit 65
fi

for private_input in "${identity}" "${private_target}"; do
  if [[
    ! -f "${private_input}"
    || -L "${private_input}"
    || "$(stat_uid "${private_input}")" != "$(id -u)"
    || "$(( 8#$(stat_mode "${private_input}") & 8#077 ))" -ne 0
  ]]; then
    exit 66
  fi
done
for input in "${ciphertext}" "${redacted_artifact}"; do
  if [[ ! -f "${input}" || -L "${input}" ]]; then
    exit 67
  fi
done

recipient="$(age-keygen -y "${identity}")"
if [[ ! "${recipient}" =~ ^age1[0-9a-z]{58}$ ]]; then
  exit 68
fi
actual_recipient_sha256="$(
  printf '%s' "${recipient}" | sha256_stdin
)"
if [[ "${actual_recipient_sha256}" != "${expected_recipient_sha256}" ]]; then
  exit 69
fi

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

plaintext_temporary="${output_parent}/.ldareg-owner-request-${source_release_sha}.tmp"
validation_root="${output_parent}/.ldareg-owner-validation-${source_release_sha}"
validation_private="${validation_root}/.development-api-authoritative-ldareg-backfill"
cleanup_plaintext() {
  rm -f -- \
    "${plaintext_temporary}" \
    "${validation_private}/target.json" \
    "${validation_private}/artifact.json" \
    "${validation_private}/owner-package.json"
  if [[ -d "${validation_private}" && ! -L "${validation_private}" ]]; then
    rmdir -- "${validation_private}"
  fi
  if [[ -d "${validation_root}" && ! -L "${validation_root}" ]]; then
    rmdir -- "${validation_root}"
  fi
}
trap cleanup_plaintext EXIT

test ! -e "${plaintext_temporary}"
test ! -L "${plaintext_temporary}"
install -m 600 /dev/null "${plaintext_temporary}"
age --decrypt --identity "${identity}" "${ciphertext}" \
  > "${plaintext_temporary}"
chmod 600 "${plaintext_temporary}"

mkdir -m 700 -- "${validation_root}"
mkdir -m 700 -- "${validation_private}"
install -m 600 "${private_target}" "${validation_private}/target.json"
install -m 600 "${redacted_artifact}" "${validation_private}/artifact.json"
install -m 600 "${plaintext_temporary}" "${validation_private}/owner-package.json"
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

install -m 600 "${plaintext_temporary}" "${private_output}"
test -f "${private_output}"
test ! -L "${private_output}"
test "$(stat_mode "${private_output}")" = "600"
printf '%s\n' "OWNER_APPROVAL_REQUEST_DECRYPTED_VALIDATED_AND_INSTALLED_0600"
