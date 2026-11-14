#!/usr/bin/env bash
set -eu
uses='' max_uses='' elapsed='' max_seconds='' lane='' dimension='' rows=''
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || exit 2
  case "$1" in
    --tool-uses) uses="$2" ;;
    --max-tool-uses) max_uses="$2" ;;
    --elapsed-seconds) elapsed="$2" ;;
    --max-seconds) max_seconds="$2" ;;
    --lane-id) lane="$2" ;;
    --dimension) dimension="$2" ;;
    --rows) rows="$2" ;;
    *) exit 2 ;;
  esac
  shift 2
done
for value in "$uses" "$max_uses" "$elapsed" "$max_seconds"; do
  [[ "$value" =~ ^(0|[1-9][0-9]{0,8})$ ]] || exit 2
done
[[ "$lane" =~ ^[[:alnum:]_.-]+$ && "$dimension" =~ ^[[:alnum:]_.-]+$ ]] || exit 2
(( max_uses > 0 && max_seconds > 0 )) || exit 2
if (( uses < max_uses && elapsed < max_seconds )); then exit 0; fi
[[ -f "$rows" && ! -L "$rows" ]] || exit 2
size="$(wc -c < "$rows")"
(( size <= 1048576 )) || exit 2
printf 'UNSETTLED lane=%s dimension=%s tool-uses=%s elapsed-seconds=%s\n' "$lane" "$dimension" "$uses" "$elapsed"
cat -- "$rows"
exit 3
