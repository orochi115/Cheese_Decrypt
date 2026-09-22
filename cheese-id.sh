#!/usr/bin/env bash
# 与 cheese.sh 相同, 但默认带上 --cheese-id-name。
# 目录: 课程名 [ssID]
# 单集: [Pxx]标题 [epID].mp4
# 用法:
#   ./cheese-id.sh ss723490818
#   ./cheese-id.sh ep2285190
#   ./cheese-id.sh https://www.bilibili.com/cheese/play/ssXXX
set -e

if [ $# -lt 1 ]; then
    echo "用法: $(basename "$0") <ssXXX|epXXX|完整URL> [BBDown 其他参数...]" >&2
    echo "示例: $(basename "$0") ss723490818" >&2
    exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/cheese.sh" "$@" --cheese-id-name
