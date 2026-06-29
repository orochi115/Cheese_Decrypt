# Cheese_Decrypt

B 站课堂（cheese）DRM 加密课程的下载与解密工具链。在 [BBDown](https://github.com/nilaoda/BBDown) 基础上改造，支持 `--drm-auto` 自动取钥、`mp4decrypt` 解密，以及 `cheese.sh` 一键下载全集。

> **免责声明**：本项目仅供安全研究与个人学习使用。请确保你对目标课程拥有合法访问权限，勿将下载内容用于传播、商用或其他侵权行为。使用本工具即表示你自行承担相关责任。

## 功能

- 修复 BBDown 对 cheese 课程 playurl 端点（v2 → v1）的 404 问题
- `--drm-auto`：通过 Node.js helper 走 B 站 `bilidrm` SPC/CKC 协议自动获取 ClearKey
- `mp4decrypt` 解密 CENC 加密的 mp4/m4a 并混流输出
- `cheese.sh`：接受 `ssXXX` / `epXXX`，默认下载全集，自动检测登录态
- 可选 Tampermonkey 脚本：浏览器内手动取 `kid:key`
- 仓库内置 `BBDown/scripts/npd.drm_sdk.7d8e1e5f.js`，支持离线取钥

## 架构

```text
cheese.sh
  └─ BBDown/bbdown.sh  (--drm-auto)
       ├─ 下载加密流 (playurl v1)
       ├─ bili-drm-helper.js  →  npd.drm_sdk.js  →  POST /bilidrm  →  kid:key
       └─ mp4decrypt  →  ffmpeg 混流  →  .mp4
```

## 环境要求

| 依赖 | 用途 |
|------|------|
| [.NET 9 SDK](https://dotnet.microsoft.com/) | 编译 BBDown |
| [Node.js](https://nodejs.org/) ≥ 18 | `--drm-auto`（内置 `fetch` / `WebAssembly`）|
| [mp4decrypt](https://www.bento4.com/) | 解密（可用 Homebrew 安装，或从 `Bento4/` submodule 编译）|
| [ffmpeg](https://ffmpeg.org/) | 混流（BBDown 原有依赖）|

## 快速开始

```bash
git clone --recurse-submodules https://github.com/orochi115/Cheese_Decrypt.git
cd Cheese_Decrypt

# 扫码登录（生成 BBDown/publish/BBDown.data，已在 .gitignore 中）
./BBDown/bbdown.sh login

# 下载整个课程（默认 -p ALL）
./cheese.sh ss723490818

# 下载单集
./cheese.sh ep2285190
```

首次运行 `bbdown.sh` 会自动 `dotnet publish` 生成 `BBDown/publish/BBDown` 可执行文件。

### 手动指定密钥

```bash
./BBDown/bbdown.sh 'https://www.bilibili.com/cheese/play/ep2285190' \
  --key '<kid>:<key>'
```

密钥可通过 Tampermonkey 脚本 `BBDown/scripts/bili-cheese-key-helper.user.js` 在浏览器课堂页面获取。

## 仓库结构

```text
├── README.md                 ← 本文件
├── cheese.sh                 ← 一键下载入口
├── docs/
│   ├── cheese-drm-notes.md   ← 现行协议、实现说明、踩坑记录
│   └── references/
│       └── kanxue-thread-287970/   ← 看雪原文离线 HTML + 提炼笔记
├── Bento4/                   ← git submodule（mp4decrypt 源码）
└── BBDown/                   ← 改造后的 BBDown
    └── scripts/
        ├── bili-drm-helper.js
        ├── bili-cheese-key-helper.user.js
        └── npd.drm_sdk.7d8e1e5f.js   ← B 站 DRM SDK（离线备用）
```

## 文档

| 文档 | 内容 |
|------|------|
| [docs/cheese-drm-notes.md](docs/cheese-drm-notes.md) | **本项目** 2026 现行协议、端点、SDK 用法、已知踩坑 |
| [docs/references/kanxue-thread-287970/](docs/references/kanxue-thread-287970/) | **看雪原文** 离线 HTML、提炼笔记（2025 旧协议参考） |

阅读顺序建议：先看 `cheese-drm-notes.md` 了解现行实现；需要追溯背景时再打开 `kanxue-thread-287970/` 里的原文与笔记。

## 相关链接

- BBDown 上游：https://github.com/nilaoda/BBDown
- Bento4：https://github.com/axiomatic-systems/Bento4
- 看雪原文：https://bbs.kanxue.com/thread-287970.htm