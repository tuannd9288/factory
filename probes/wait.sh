#!/usr/bin/env bash
# Waits until no PR among the given numbers is open with a check still running (or with fewer than 7 checks).
REPO=tuannd9288/factory-scratch
busy() {
  for n in "$@"; do
    s=$(gh pr view "$n" --repo $REPO --json state --jq .state 2>/dev/null) || return 0
    [ "$s" = OPEN ] || continue
    c=$(gh pr checks "$n" --repo $REPO --json state --jq '[length, ([.[]|select(.state!="SUCCESS" and .state!="FAILURE" and .state!="CANCELLED" and .state!="SKIPPED")]|length)] | join(" ")' 2>/dev/null) || return 0
    set -- $c; [ "${1:-0}" -lt 7 ] || [ "${2:-1}" -gt 0 ] && return 0
    shift 2
  done
  return 1
}
while busy "$@"; do sleep 15; done
