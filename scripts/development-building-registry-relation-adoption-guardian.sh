#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

uuid_pattern='^[0-9]+-[0-9]+$'
sha_pattern='^[0-9a-f]{40}$'
if [[
  ! "${RUN_KEY:-}" =~ ${uuid_pattern}
  || ! "${EXPECTED_GIT_SHA:-}" =~ ${sha_pattern}
  || "${EXPECTED_IMAGE_TAG:-}" != "ghcr.io/dlswn666/alimtalk-proxy:${EXPECTED_GIT_SHA}"
 ]]; then
  exit 64
fi

container_name="alimtalk-proxy"
application_root="${HOME}/alimtalk-proxy"
host_root="${application_root}/.development-building-relation-adoption-workflow/${RUN_KEY}"
host_target="${host_root}/target.json"
host_phase0_manifest="${host_root}/phase0-manifest.json"
host_phase0="${host_root}/phase0-artifact.json"
host_artifact="${host_root}/artifact.json"
host_status="${host_root}/status"
host_validated="${host_root}/validated"
host_started="${host_root}/guardian-started"
operation_lock_path="${application_root}/.land-area-sync-operation.lock"
container_root="/app/.development-building-registry-relation-adoption"
container_target="${container_root}/target-${RUN_KEY}.json"
container_phase0_manifest="${container_root}/phase0-manifest-${RUN_KEY}.json"
container_phase0="${container_root}/phase0-artifact-${RUN_KEY}.json"
container_artifact="${container_root}/artifact-${RUN_KEY}.json"
validation_sentinel="DEVELOPMENT_BUILDING_REGISTRY_RELATION_ADOPTION_ARTIFACT_VALIDATED"
target_container=""
cleanup_complete=0
final_status=90

write_private_line() {
  local target="$1"
  local value="$2"
  local temporary="${target}.tmp.$$"
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

cleanup_container_inputs() {
  if [[ -z "${target_container}" ]]; then
    return 0
  fi
  local status=0
  if ! docker exec "${target_container}" rm -f -- \
      "${container_target}" \
      "${container_phase0_manifest}" \
      "${container_phase0}" \
      "${container_artifact}"
  then
    status=1
  fi
  local candidate
  for candidate in \
    "${container_target}" \
    "${container_phase0_manifest}" \
    "${container_phase0}" \
    "${container_artifact}"
  do
    if ! docker exec "${target_container}" test ! -e "${candidate}"; then
      status=1
    fi
  done
  return "${status}"
}

cleanup_host_inputs() {
  local status=0
  if ! rm -f -- \
      "${host_target}" \
      "${host_phase0_manifest}" \
      "${host_phase0}"
  then
    status=1
  fi
  if ! verify_absent \
      "${host_target}" \
      "${host_phase0_manifest}" \
      "${host_phase0}"
  then
    status=1
  fi
  return "${status}"
}

finish_guardian() {
  local prior_status="$?"
  trap - EXIT
  set +e
  local cleanup_status=0
  if [[ "${cleanup_complete}" -ne 1 ]]; then
    cleanup_container_inputs || cleanup_status=1
    cleanup_host_inputs || cleanup_status=1
  fi
  if [[ "${prior_status}" -ne 0 || "${cleanup_status}" -ne 0 ]]; then
    final_status=90
  fi
  write_private_line "${host_status}" "${final_status}"
  local status_write="$?"
  set -e
  if [[ "${status_write}" -ne 0 ]]; then
    exit 91
  fi
  exit 0
}

# workflow 취소나 SSH 단절과 분리해 DB approval cleanup/finally가 끝날 때까지
# operation lock을 guardian이 계속 보유한다.
trap ':' HUP INT TERM
trap finish_guardian EXIT

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

test -d "${host_root}"
test ! -L "${host_root}"
test "$(stat -c '%u' "${host_root}")" = "$(id -u)"
test "$(stat -c '%a' "${host_root}")" = "700"
for candidate in \
  "${host_target}" \
  "${host_phase0_manifest}" \
  "${host_phase0}"
do
  test -f "${candidate}"
  test ! -L "${candidate}"
  test "$(stat -c '%u' "${candidate}")" = "$(id -u)"
  test "$(stat -c '%a' "${candidate}")" = "600"
  size="$(stat -c '%s' "${candidate}")"
  test "${size}" -ge 2
  test "${size}" -le 3145728
done

target_container="$(docker inspect --format '{{.Id}}' "${container_name}")"
target_image_id="$(docker inspect --format '{{.Image}}' "${container_name}")"
target_revision="$(
  docker image inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "${target_image_id}"
)"
if [[
  ! "${target_container}" =~ ^[0-9a-f]{64}$
  || ! "${target_image_id}" =~ ^sha256:[0-9a-f]{64}$
  || "${target_revision}" != "${EXPECTED_GIT_SHA}"
 ]]; then
  exit 67
fi

verify_health() {
  docker exec \
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

stream_file() {
  local source="$1"
  local target="$2"
  docker exec -i \
    -e "PRIVATE_INPUT_PATH=${target}" \
    "${target_container}" \
    node -e '
      const fs = require("node:fs");
      const target = process.env.PRIVATE_INPUT_PATH ?? "";
      if (!/^\/app\/\.development-building-registry-relation-adoption\/[a-z0-9-]+-[0-9]+-[0-9]+\.json$/.test(target)) {
        process.exit(1);
      }
      const chunks = [];
      let size = 0;
      process.stdin.on("data", (chunk) => {
        size += chunk.length;
        if (size > 3145728) process.exit(1);
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
    ' < "${source}"
}

verify_health
docker exec "${target_container}" \
  sh -c "install -d -m 700 '${container_root}'"
stream_file "${host_target}" "${container_target}"
stream_file "${host_phase0_manifest}" "${container_phase0_manifest}"
stream_file "${host_phase0}" "${container_phase0}"
write_private_line "${host_started}" "$$"

set +e
# 컨테이너의 평시 자세(.env)를 바꾸지 않고 이 실행에만 target 을 주입한다.
# 미지정이면 CLI 가 development 로 폴백하므로 기존 동작은 그대로다.
docker exec -w /app \
  -e RELATION_ADOPTION_DATABASE_TARGET="${RELATION_ADOPTION_DATABASE_TARGET:-development}" \
  "${target_container}" \
  node dist/cli/development-building-registry-relation-adoption.js \
  --target ".development-building-registry-relation-adoption/target-${RUN_KEY}.json" \
  --phase0-manifest ".development-building-registry-relation-adoption/phase0-manifest-${RUN_KEY}.json" \
  --phase0-artifact ".development-building-registry-relation-adoption/phase0-artifact-${RUN_KEY}.json" \
  --source-release-sha "${EXPECTED_GIT_SHA}" \
  --out ".development-building-registry-relation-adoption/artifact-${RUN_KEY}.json"
runner_status="$?"
set -e
final_status="${runner_status}"

if [[ "${runner_status}" -eq 0 || "${runner_status}" -eq 1 ]]; then
  validation_output="$(
    docker exec -w /app "${target_container}" \
      node dist/cli/development-building-registry-relation-adoption-validate.js \
      --target ".development-building-registry-relation-adoption/target-${RUN_KEY}.json" \
      --artifact ".development-building-registry-relation-adoption/artifact-${RUN_KEY}.json" \
      --source-release-sha "${EXPECTED_GIT_SHA}"
  )"
  if [[ "${validation_output}" != "${validation_sentinel}" ]]; then
    final_status=92
  else
    verify_health
    container_after="$(docker inspect --format '{{.Id}}' "${container_name}")"
    if [[ "${container_after}" != "${target_container}" ]]; then
      final_status=93
    else
      docker cp "${target_container}:${container_artifact}" "${host_artifact}"
      chmod 600 "${host_artifact}"
      artifact_sha="$(sha256sum "${host_artifact}" | awk '{print $1}')"
      write_private_line \
        "${host_validated}" \
        "${validation_sentinel}:${artifact_sha}"
    fi
  fi
fi

cleanup_container_inputs
cleanup_host_inputs
cleanup_complete=1
write_private_line "${host_status}" "${final_status}"
trap - EXIT
exit 0
