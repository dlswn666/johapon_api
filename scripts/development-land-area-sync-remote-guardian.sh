#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# GitHub SSH session과 분리된 host-side guardian이다. 이 프로세스가 operation
# lock을 직접 보유하므로 workflow 취소/SSH 단절이 진행 중인 API job과 lock을
# 분리하지 못한다. runner는 admission된 job을 durable terminal까지 drain한다.

uuid_pattern='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
sha_pattern='^[0-9a-f]{40}$'
if [[
  ! "${RUN_KEY:-}" =~ ^[0-9]+-[0-9]+$
  || ( "${FULL_REFRESH_MODE:-}" != "0" && "${FULL_REFRESH_MODE:-}" != "1" )
  || ! "${ACTOR_AUTH_USER_ID:-}" =~ ${uuid_pattern}
  || ! "${EXPECTED_GIT_SHA:-}" =~ ${sha_pattern}
  || "${EXPECTED_IMAGE_TAG:-}" != "ghcr.io/dlswn666/alimtalk-proxy:${EXPECTED_GIT_SHA}"
 ]]; then
  exit 64
fi

container_name="alimtalk-proxy"
application_root="${HOME}/alimtalk-proxy"
host_root="${application_root}/.development-land-area-sync-workflow/${RUN_KEY}"
host_target="${host_root}/target.json"
host_db_approval="${host_root}/db-approval.json"
host_evidence="${host_root}/evidence.json"
host_artifact="${host_root}/artifact.json"
host_status="${host_root}/status"
host_validated="${host_root}/validated"
host_started="${host_root}/guardian-started"
host_capture_failure="${host_root}/capture-failure-summary.json"
operation_lock_path="${application_root}/.land-area-sync-operation.lock"
container_root="/app/.development-land-area-sync"
container_target="${container_root}/target-${RUN_KEY}.json"
container_db_approval="${container_root}/db-approval-${RUN_KEY}.json"
container_evidence="${container_root}/evidence-${RUN_KEY}.json"
container_artifact="${container_root}/artifact-${RUN_KEY}.json"
container_capture_root="/app/.development-land-area-evidence-capture"
container_capture_target="${container_capture_root}/target-${RUN_KEY}.json"
container_capture_evidence="${container_capture_root}/evidence-${RUN_KEY}.json"
container_capture_audit="${container_capture_root}/audit-${RUN_KEY}.json"
validation_sentinel="LAND_AREA_DEVELOPMENT_RUN_ARTIFACT_VALIDATED"
capture_timeout_seconds=3600
runner_timeout_seconds=18000
post_timeout_quarantine_seconds=720
host_self_cleanup_delay_seconds=1200
target_container=""
cleanup_complete=0
final_status=90

write_private_line() {
  local target="$1"
  local value="$2"
  local temporary="${target}.tmp.$$"
  local write_status=0
  if ! install -m 600 /dev/null "${temporary}"; then
    write_status=1
  fi
  if ! printf '%s\n' "${value}" > "${temporary}"; then
    write_status=1
  fi
  if ! mv -f -- "${temporary}" "${target}"; then
    write_status=1
  fi
  if ! chmod 600 "${target}"; then
    write_status=1
  fi
  return "${write_status}"
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
  local cleanup_status=0
  if ! docker exec "${target_container}" rm -f -- \
      "${container_target}" \
      "${container_db_approval}" \
      "${container_evidence}" \
      "${container_artifact}" \
      "${container_capture_target}" \
      "${container_capture_evidence}" \
      "${container_capture_audit}"
  then
    cleanup_status=1
  fi
  local candidate
  for candidate in \
    "${container_target}" \
    "${container_db_approval}" \
    "${container_evidence}" \
    "${container_artifact}" \
    "${container_capture_target}" \
    "${container_capture_evidence}" \
    "${container_capture_audit}"
  do
    if ! docker exec "${target_container}" test ! -e "${candidate}"; then
      cleanup_status=1
    fi
  done
  return "${cleanup_status}"
}

cleanup_host_inputs() {
  local cleanup_status=0
  if ! rm -f -- \
      "${host_target}" \
      "${host_db_approval}" \
      "${host_evidence}"
  then
    cleanup_status=1
  fi
  if ! verify_absent \
      "${host_target}" \
      "${host_db_approval}" \
      "${host_evidence}"
  then
    cleanup_status=1
  fi
  return "${cleanup_status}"
}

schedule_host_self_cleanup() {
  (
    # 부모 guardian의 operation lock FD를 상속한 채 sleep하지 않는다.
    exec 8>&-
    trap '' HUP
    trap - INT TERM
    sleep "${host_self_cleanup_delay_seconds}"
    if [[ ! -e "${host_root}" && ! -L "${host_root}" ]]; then
      exit 0
    fi
    test -d "${host_root}"
    test ! -L "${host_root}"
    test "$(stat -c '%u' "${host_root}")" = "$(id -u)"
    exec 9>>"${operation_lock_path}"
    flock -w 30 9
    rm -f -- \
      "${host_root}/target.json" \
      "${host_root}/db-approval.json" \
      "${host_root}/evidence.json" \
      "${host_root}/guardian.sh" \
      "${host_root}/guardian.log" \
      "${host_root}/guardian.pid" \
      "${host_root}/guardian-started" \
      "${host_root}/artifact.json" \
      "${host_root}/status" \
      "${host_root}/validated" \
      "${host_root}/capture-failure-summary.json"
    rmdir -- "${host_root}"
  ) </dev/null >/dev/null 2>&1 &
}

finish_guardian() {
  local prior_status="$?"
  trap - EXIT
  set +e
  local cleanup_status=0
  if [[ "${cleanup_complete}" -ne 1 ]]; then
    cleanup_container_inputs
    if [[ "$?" -ne 0 ]]; then
      cleanup_status=1
    fi
    cleanup_host_inputs
    if [[ "$?" -ne 0 ]]; then
      cleanup_status=1
    fi
  fi
  if [[ "${prior_status}" -ne 0 || "${cleanup_status}" -ne 0 ]]; then
    final_status=90
  fi
  write_private_line "${host_status}" "${final_status}"
  local status_write_status="$?"
  set -e
  if [[ "${status_write_status}" -ne 0 ]]; then
    exit 91
  fi
  # workflow가 GitHub hard timeout/취소로 remote cleanup을 호출하지 못해도 raw
  # artifact/status/log가 host에 영구 잔존하지 않게 exact run directory를 만료한다.
  schedule_host_self_cleanup
  exit 0
}

# nohup/setsid guardian은 workflow cancellation의 HUP과 SSH 단절에 영향받지
# 않는다. TERM/INT도 foreground runner가 terminal drain을 마칠 때까지 무시한다.
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
if [[ ! -f "${operation_lock_path}" || -L "${operation_lock_path}" ]] \
  || [[ "$(stat -c '%u' "${operation_lock_path}")" != "$(id -u)" ]] \
  || [[ "$(stat -c '%a' "${operation_lock_path}")" != "600" ]]; then
  exit 65
fi
exec 8>>"${operation_lock_path}"
if ! flock -w 300 8; then
  exit 66
fi

test -d "${host_root}"
test ! -L "${host_root}"
test "$(stat -c '%u' "${host_root}")" = "$(id -u)"
test "$(stat -c '%a' "${host_root}")" = "700"
candidates=("${host_target}")
if [[ "${FULL_REFRESH_MODE}" == "0" ]]; then
  candidates+=("${host_db_approval}" "${host_evidence}")
fi
for candidate in "${candidates[@]}"
do
  test -f "${candidate}"
  test ! -L "${candidate}"
  test "$(stat -c '%u' "${candidate}")" = "$(id -u)"
  test "$(stat -c '%a' "${candidate}")" = "600"
  size="$(stat -c '%s' "${candidate}")"
  test "${size}" -ge 2
  test "${size}" -le 1048576
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
      if (!/^\/app\/\.development-land-area-sync\/[a-z-]+-[0-9]+-[0-9]+\.json$/.test(target)) {
        process.exit(1);
      }
      const chunks = [];
      let size = 0;
      process.stdin.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1048576) process.exit(1);
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
stream_file "${host_target}" "${container_target}"
if [[ "${FULL_REFRESH_MODE}" == "0" ]]; then
  stream_file "${host_db_approval}" "${container_db_approval}"
  stream_file "${host_evidence}" "${container_evidence}"
else
  docker exec "${target_container}" \
    install -d -m 700 "${container_capture_root}"
  docker exec "${target_container}" \
    cp -- "${container_target}" "${container_capture_target}"
  docker exec "${target_container}" \
    chmod 600 "${container_capture_target}"
  capture_run_id="${RUN_KEY//-/}"
  set +e
  timeout --foreground --kill-after=30s "${capture_timeout_seconds}" \
  docker exec -w /app \
    -e LAND_AREA_SYNC_ENABLED= \
    "${target_container}" \
    node dist/cli/development-land-area-evidence-capture.js \
    --target ".development-land-area-evidence-capture/target-${RUN_KEY}.json" \
    --capture-run-id "${capture_run_id}" \
    --evidence-out ".development-land-area-evidence-capture/evidence-${RUN_KEY}.json" \
    --audit-out ".development-land-area-evidence-capture/audit-${RUN_KEY}.json"
  inline_capture_status="$?"
  set -e
  if [[ "${inline_capture_status}" -ne 0 ]]; then
    # 인라인 캡처 실패 audit의 redacted 요약만 host로 반출한다. 공개 capture
    # artifact와 같은 수위(게이트/승격 코드·집계 카운트·retry·issue code 카운트)만
    # 허용하고 anchorPnu/UUID 등 식별자는 어떤 경로로도 내보내지 않는다.
    docker exec -w /app \
      -e "AUDIT_PATH=${container_capture_audit}" \
      -e "INLINE_CAPTURE_STATUS=${inline_capture_status}" \
      "${target_container}" \
      node -e '
        const fs = require("node:fs");
        const CODE_RE = /^[A-Z0-9_]{1,100}$/;
        const n = (v) => (Number.isSafeInteger(v) ? v : null);
        const code = (v) => (typeof v === "string" && CODE_RE.test(v) ? v : null);
        const codes = (v) =>
          Array.isArray(v) ? v.map(code).filter(Boolean).slice(0, 32) : null;
        let audit = null;
        try {
          audit = JSON.parse(fs.readFileSync(process.env.AUDIT_PATH ?? "", "utf8"));
        } catch {}
        const entries = Array.isArray(audit?.entries) ? audit.entries : [];
        const statusCounts = {};
        const issueCodeCounts = {};
        for (const entry of entries) {
          const status = code(entry?.status);
          if (status) statusCounts[status] = (statusCounts[status] ?? 0) + 1;
          for (const issue of codes(entry?.issueCodes) ?? []) {
            issueCodeCounts[issue] = (issueCodeCounts[issue] ?? 0) + 1;
          }
        }
        const summary = {
          inlineCaptureExitStatus: n(Number(process.env.INLINE_CAPTURE_STATUS)),
          auditReadable: audit !== null,
          failureCode: code(audit?.failureCode),
          gateStatus: code(audit?.gate?.status),
          gateFailureCodes: codes(audit?.gate?.failureCodes),
          promotionGateStatus: code(audit?.promotionGate?.status),
          promotionGateFailureCodes: codes(audit?.promotionGate?.failureCodes),
          entryCount: n(entries.length),
          statusCounts,
          issueCodeCounts,
          retry: audit?.retry
            ? {
                rounds: n(audit.retry.rounds),
                retriedAnchorCount: n(audit.retry.retriedAnchorCount),
                recoveredAnchorCount: n(audit.retry.recoveredAnchorCount),
                skipped: code(audit.retry.skipped),
              }
            : null,
        };
        process.stdout.write(`${JSON.stringify(summary)}\n`);
      ' > "${host_capture_failure}.tmp.$$" \
      && mv -f -- "${host_capture_failure}.tmp.$$" "${host_capture_failure}" \
      && chmod 600 "${host_capture_failure}" \
      || rm -f -- "${host_capture_failure}.tmp.$$"
    exit "${inline_capture_status}"
  fi
  docker exec -w /app \
    -e "FULL_REFRESH_TARGET=${container_capture_target}" \
    -e "FULL_REFRESH_EVIDENCE=${container_capture_evidence}" \
    -e "FULL_REFRESH_AUDIT=${container_capture_audit}" \
    -e "RUNNER_EVIDENCE=${container_evidence}" \
    -e "RUNNER_APPROVAL=${container_db_approval}" \
    "${target_container}" \
    node -e '
      const fs = require("node:fs");
      const runner = require("./dist/operations/development-land-area-sync-runner.js");
      const read = (name) => JSON.parse(fs.readFileSync(process.env[name], "utf8"));
      const target = runner.parseDevelopmentTargetManifest(read("FULL_REFRESH_TARGET"));
      const evidence = runner.parseDevelopmentEvidenceManifest(read("FULL_REFRESH_EVIDENCE"));
      const audit = read("FULL_REFRESH_AUDIT");
      const marker = runner.developmentFullRefreshMarkerForTarget(target);
      const exactFullRefreshComponentCoverage =
        audit?.verifiedNoDataCount === 0
          && audit?.sameRunOfficialComponentCount
            + audit?.sameRunOfficialParcelCount
          === target.targetCount;
      if (
        !marker
        || audit?.gate?.status !== "PASS"
        || audit?.promotionGate?.status !== "PASS"
        || audit?.promotionGate?.writeEligible !== true
        || audit?.readOnlyGuards?.durableSyncJobWrites !== 0
        || audit?.readOnlyGuards?.propertyUnitWriteRpcCalls !== 0
        || audit?.resolvedComponentCount !== target.targetCount
        || !exactFullRefreshComponentCoverage
        || evidence.manifestDigest !== target.manifestDigest
      ) process.exit(1);
      const approval = {
        version: "land-area-development-db-approval-manifest@1",
        databaseTarget: "development",
        unionId: target.unionId,
        pnus: target.allowedScopePnus,
        targetCount: target.allowedScopePnus.length,
        manifestDigest: target.scopeDigest,
        enabled: true,
      };
      runner.validateDevelopmentRunnerManifests(target, approval, evidence);
      fs.writeFileSync(
        process.env.RUNNER_EVIDENCE,
        `${JSON.stringify(evidence, null, 2)}\n`,
        { flag: "wx", mode: 0o600 }
      );
      fs.writeFileSync(
        process.env.RUNNER_APPROVAL,
        `${JSON.stringify(approval, null, 2)}\n`,
        { flag: "wx", mode: 0o600 }
      );
    '
fi
write_private_line "${host_started}" "$$"

set +e
timeout --foreground --kill-after=30s "${runner_timeout_seconds}" \
docker exec -w /app "${target_container}" \
  node dist/cli/development-land-area-sync-runner.js \
  --target ".development-land-area-sync/target-${RUN_KEY}.json" \
  --db-approval ".development-land-area-sync/db-approval-${RUN_KEY}.json" \
  --evidence ".development-land-area-sync/evidence-${RUN_KEY}.json" \
  --actor-auth-user-id "${ACTOR_AUTH_USER_ID}" \
  --out ".development-land-area-sync/artifact-${RUN_KEY}.json"
runner_status="$?"
set -e
final_status="${runner_status}"

# hard timeout은 runner의 225분 신규-anchor cutoff와 admission wall timer/terminal
# drain보다 긴 비상 상한이다. timeout 뒤에도 DB approval의 1시간 remaining gate와
# 겹치는 quarantine 동안 operation lock을 유지한다.
if [[ "${runner_status}" -eq 124 || "${runner_status}" -eq 137 ]]; then
  sleep "${post_timeout_quarantine_seconds}"
fi

if [[ "${runner_status}" -eq 0 || "${runner_status}" -eq 1 ]]; then
  validation_output="$(
    docker exec -w /app "${target_container}" \
      node dist/cli/development-land-area-sync-validate.js \
      --target ".development-land-area-sync/target-${RUN_KEY}.json" \
      --artifact ".development-land-area-sync/artifact-${RUN_KEY}.json"
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

# 민감/evidence input은 operation lock을 놓기 전에 host/container 양쪽에서
# 제거하고 부재를 다시 검사한다. cleanup 실패는 status 90으로 green을 금지한다.
cleanup_container_inputs
cleanup_host_inputs
cleanup_complete=1
write_private_line "${host_status}" "${final_status}"
schedule_host_self_cleanup
trap - EXIT
exit 0
