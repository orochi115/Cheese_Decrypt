#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_BIN="$SCRIPT_DIR/publish/BBDown"
DLL="$SCRIPT_DIR/BBDown/bin/Release/net9.0/BBDown.dll"

# 检测当前平台对应的 RID（仅支持常见的 macOS / Linux）
detect_rid() {
    local os arch
    case "$(uname -s)" in
        Darwin) os="osx" ;;
        Linux)  os="linux" ;;
        *) echo ""; return ;;
    esac
    case "$(uname -m)" in
        arm64|aarch64) arch="arm64" ;;
        x86_64) arch="x64" ;;
        *) echo ""; return ;;
    esac
    echo "$os-$arch"
}

build_native() {
    local rid
    rid="$(detect_rid)"
    if [ -z "$rid" ]; then
        echo "[bbdown.sh] 无法识别平台，回退到 dotnet 模式" >&2
        return 1
    fi
    echo "[bbdown.sh] 正在为 $rid 发布独立可执行文件..." >&2
    dotnet publish "$SCRIPT_DIR/BBDown/BBDown.csproj" \
        -c Release -r "$rid" --self-contained true \
        -p:PublishSingleFile=true \
        -o "$SCRIPT_DIR/publish" >&2
}

# 优先使用 native 可执行文件（子命令 login/logintv/serve 才能正常工作）
if [ ! -x "$NATIVE_BIN" ]; then
    if ! build_native; then
        # 退路：通过 dotnet 调用 DLL（注意：login/logintv 子命令在此模式下无法使用）
        if [ ! -f "$DLL" ]; then
            echo "[bbdown.sh] 正在执行 Release 编译..." >&2
            dotnet build "$SCRIPT_DIR/BBDown.sln" -c Release >&2
        fi
        exec dotnet "$DLL" "$@"
    fi
fi

exec "$NATIVE_BIN" "$@"
