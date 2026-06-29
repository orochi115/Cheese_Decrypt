# Cheese_Decrypt

B 站课堂（cheese）DRM 加密课程的下载与解密工具链。在 [BBDown](https://github.com/nilaoda/BBDown) 基础上改造，支持 `--drm-auto` 自动取钥、`mp4decrypt` 解密，以及 `cheese.sh` 一键下载全集。

> **免责声明**：本项目仅供安全研究与个人学习使用。请确保你对目标课程拥有合法访问权限，勿将下载内容用于传播、商用或其他侵权行为。使用本工具即表示你自行承担相关责任。

## 功能

- 修复 BBDown 对 cheese 课程 playurl 端点（v2 → v1）的 404 问题
- `--drm-auto`：通过 Node.js helper 走 B 站 `bilidrm` SPC/CKC 协议自动获取 ClearKey
- `mp4decrypt` 解密 CENC 加密的 mp4/m4a 并混流输出
- `cheese.sh`：接受 `ssXXX` / `epXXX`，默认下载全集，自动检测登录态
- 可选 Tampermonkey 脚本：浏览器内手动取 `kid:key`
- 仓库内置 `npd.drm_sdk.7d8e1e5f.js`，支持离线取钥

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
├── HANDOVER.md               ← 协议细节、踩坑记录、改造说明
├── bilibili_drm_流程分析笔记.md  ← 看雪原文技术提炼
├── docs/references/          ← 外部参考资料归档
├── npd.drm_sdk.7d8e1e5f.js   ← B 站 DRM SDK（离线备用）
├── Bento4/                   ← git submodule（mp4decrypt 源码）
└── BBDown/                   ← 改造后的 BBDown（fork 源码）
    └── scripts/
        ├── bili-drm-helper.js
        └── bili-cheese-key-helper.user.js
```

## 文档

| 文档 | 内容 |
|------|------|
| [HANDOVER.md](HANDOVER.md) | 2026 现行协议、端点、SDK 用法、已知踩坑 |
| [bilibili_drm_流程分析笔记.md](bilibili_drm_流程分析笔记.md) | 看雪 thread-287970 技术复述 |
| [docs/references/kanxue-thread-287970/](docs/references/kanxue-thread-287970/) | 看雪原文链接与配图归档 |

## 相关链接

- BBDown 上游：https://github.com/nilaoda/BBDown
- Bento4：https://github.com/axiomatic-systems/Bento4
- 看雪原文：https://bbs.kanxue.com/thread-287970.htm