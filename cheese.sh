#!/usr/bin/env bash
# 一键下载 B 站课堂 (cheese) 课程, 自动 DRM 解密 + 全集 + 单线程稳跑。
# 用法:
#   ./cheese.sh ss723490818              # 整个课程
#   ./cheese.sh ep2285190                # 某一集
#   ./cheese.sh https://...cheese/play/ssXXX [BBDown 其他参数]
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BBDOWN="$SCRIPT_DIR/BBDown/bbdown.sh"

if [ $# -lt 1 ]; then
    echo "用法: $(basename "$0") <ssXXX|epXXX|完整URL> [BBDown 其他参数...]" >&2
    echo "示例: $(basename "$0") ss723490818" >&2
    exit 2
fi

input="$1"
shift

case "$input" in
    ss[0-9]*|ep[0-9]*)
        url="https://www.bilibili.com/cheese/play/$input"
        ;;
    http://*|https://*)
        url="$input"
        ;;
    *)
        echo "[cheese.sh] 无法识别 '$input', 请传 ssXXX / epXXX / 完整 URL" >&2
        exit 2
        ;;
esac

# 用户没显式指定 -p / --select-page 时, 默认下载全集
user_set_page=0
for arg in "$@"; do
    case "$arg" in
        -p|--select-page|-p=*|--select-page=*) user_set_page=1; break ;;
    esac
done

extra_select_page=()
if [ "$user_set_page" -eq 0 ]; then
    extra_select_page=(-p ALL)
fi

# 登录态检测: BBDown.data 是 BBDown login 落盘的 cookie 文件
COOKIE_FILE="$SCRIPT_DIR/BBDown/publish/BBDown.data"
if [ ! -s "$COOKIE_FILE" ]; then
    echo "[cheese.sh] 未检测到登录态 ($COOKIE_FILE 不存在或为空), 先扫码登录..." >&2
    "$BBDOWN" login
    if [ ! -s "$COOKIE_FILE" ]; then
        echo "[cheese.sh] 登录未完成, 请重试。" >&2
        exit 1
    fi
fi

exec "$BBDOWN" "$url" --drm-auto "${extra_select_page[@]}" --multi-thread false "$@"
