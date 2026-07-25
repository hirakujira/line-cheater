#!/bin/zsh
set -u

if [[ "$#" -lt 2 || "$1" != "--" ]]; then
  print -u2 "usage: $0 -- command [args ...]"
  exit 64
fi
shift

typeset -i peak_rss_kib=0
typeset -i root_pid
root_pid=0

sample_process_tree() {
  local -a queue
  queue=("$root_pid")
  typeset -i total=0
  while [[ "${#queue[@]}" -gt 0 ]]; do
    local pid="${queue[1]}"
    queue=("${queue[@]:1}")
    [[ "$pid" == <-> ]] || continue
    local rss
    rss="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    if [[ "$rss" == <-> ]]; then
      total+=rss
    fi
    local children
    children="$(pgrep -P "$pid" 2>/dev/null || true)"
    if [[ -n "$children" ]]; then
      queue+=(${(f)children})
    fi
  done
  if (( total > peak_rss_kib )); then
    peak_rss_kib=$total
  fi
}

"$@" &
root_pid=$!
while kill -0 "$root_pid" 2>/dev/null; do
  sample_process_tree
  sleep 0.1
done
sample_process_tree

wait "$root_pid"
typeset -i child_exit_code=$?
print -r -- "{\"peakRssKiB\":$peak_rss_kib,\"exitCode\":$child_exit_code,\"sampleIntervalMs\":100,\"scope\":\"process-tree\"}"
exit "$child_exit_code"
