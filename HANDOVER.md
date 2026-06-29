# 交接文档 — Bilibili 课堂 DRM 解密 / BBDown 改造

> 上次会话时间：2026-05-09  
> 状态：**端到端跑通**（`--drm-auto` + `cheese.sh` 一键下载）。

---

## 1. 目标与背景

**目标**：让 BBDown 能下载 B 站课堂（cheese）DRM 加密课程，例如  
`https://www.bilibili.com/cheese/play/ss723490818`

**背景**：
- 起点是看雪论坛 2025-08 文章（`bilibili_drm_流程分析笔记.md`）整理的分析，描述了一条 Widevine→ClearKey fallback 的旧链路。
- **关键发现**：B 站此后协议大改，2026 年实际行为与笔记不一致——见下文协议章节。
- 测试样本：课程 `ss723490818`（数独课，58 集）；需已登录 B 站且拥有该课程访问权限。

---

## 2. 当前已完成

### 2.1 BBDown 改造（C# 端）— ✅ 跑通

修改 / 新增的文件：

| 路径 | 改动 |
|---|---|
| `BBDown/BBDown.Core/Entity/Entity.cs` | `Video`/`Audio` 类各加可空字段 `kid` / `bilidrmUri` |
| `BBDown/BBDown.Core/Entity/ParsedResult.cs` | 加 `IsDrm` / `DrmType` 字段 |
| `BBDown/BBDown.Core/Parser.cs` | 1) `ExtractDrmInfo` 解析 `bilidrm_uri`/`widevine_pssh` → KID；2) 设置 `IsDrm`/`DrmType`；3) **修复 cheese 端点**：从 `/pugv/player/web/v2/playurl` 改用 `/pugv/player/web/playurl`（无 `/v2/`）——**v2 端点对 cheese 一律 404**，这是原 BBDown 至少一年都下不了课程的根因 |
| `BBDown/BBDown/BBDownDrm.cs` (新) | `ParseKeyArgs` / `ResolveKeyForKid` / `Decrypt` (调 mp4decrypt) / `IsAvailable` / `AcquireKeyAuto` |
| `BBDown/BBDown/Program.cs` | 下载完成后、混流前插入 mp4decrypt 解密块；支持 `--drm-auto` |
| `BBDown/BBDown/Program.Methods.cs` | `PrintSelectedTrackInfo` 选中流末尾追加 `[DRM kid=...]` |
| `BBDown/BBDown/CommandLineInvoker.cs` | 注册 `--key`、`--drm-auto`、`--mp4decrypt-path` |
| `BBDown/BBDown/MyOption.cs` | 对应字段 + `using System;` |

**验证**：
```bash
./cheese.sh ep2285190
# 或
./BBDown/bbdown.sh 'https://www.bilibili.com/cheese/play/ep2285190' --drm-auto
```
产出 `[P5]行列排除法.mp4`（H.264 1080×1442 + AAC, 8 分 7 秒），抽帧画面正常（标题 + 字幕清晰）。

### 2.2 Node.js DRM helper — ✅ 跑通（`--drm-auto`）

文件：`BBDown/scripts/bili-drm-helper.js`

- 内化 `npd.drm_sdk.7d8e1e5f.js` 的 SPC/CKC 协议
- BBDown 通过子进程调用，stdout 返回 `kid:key`
- 优先使用仓库根目录的 SDK 文件（离线），否则从 CDN 下载并缓存

### 2.3 Tampermonkey 用户脚本 — ✅ 跑通自动取 kid:key

文件：`BBDown/scripts/bili-cheese-key-helper.user.js`（v0.2.0, ~1300 行）

能力：
- `@run-at document-start` 钩 `XHR` / `fetch` / `MediaKeySession.update` / `generateRequest`
- 自动从 playurl 拦截 + 备份主动 prefetch 拿全 58 集的 KID
- **加载 `npd.drm_sdk.7d8e1e5f.js`（webpack chunk + Emscripten WASM）→ 调 `biliDRMGenSPC` / `biliDRMParseCKC`**
- 走完整 SPC/CKC 协议拿到 ClearKey
- Shadow DOM 浮动面板，每集独立 `[🔑 试取Key]` / `[📋 BBDown 命令]` / `[📋 kid:key]` / `[📋 JSON]` 按钮
- `GM_setValue` 持久化跨页面刷新
- `[导出诊断]` 按钮可快速 dump playurl 响应 + EME 抓包概要 + 多端点探针

### 2.4 一键脚本 — ✅

文件：`cheese.sh`

- 接受 `ssXXX` / `epXXX` / 完整 URL
- 默认 `-p ALL` 下载全集
- 自动检测登录态，缺失时触发 `BBDown login`

---

## 3. 关键协议发现（2026 现行 B 站 cheese DRM）

**笔记里描述的 ClearKey 路径在服务端仍然存活**——浏览器播放器选择走 Widevine（笔记说的"诱饵"在 2026 是真握手成功），但 `/bilidrm` 端点和 `npd.drm_sdk.7d8e1e5f.js` SDK 文件都没改。我们手动触发 ClearKey 路径就能跑通。

### 3.1 字段命名变化

| 笔记 (2025-08) | 现状 (2026) |
|---|---|
| `drm_type: "widevine"` | `drm_type: "bili_drm"`（**重要：值变了**）|
| `bilidrm_uri: "bili://<kid>//<extra>"` | `bilidrm_uri: "uri:bili://<kid>"`（前缀加 `uri:`，去掉 `//<extra>` 段）|
| 第二次 playurl 才有非空 `bilidrm_uri` | **当前调用仍然这样**——**带** `drm_tech_type=2` → 空串；不带 → 含 KID |

KID 提取：`bilidrm_uri.split('//').pop().slice(0, 32)` 或直接从 `widevine_pssh` PSSH box 解析（field 2 length-16 protobuf KID）。两个来源给出的 KID 一致。

### 3.2 SDK 协议链路

`npd.drm_sdk.7d8e1e5f.js` 暴露两个 API（webpack chunk 565, module 36861）：

```js
// 输入 kid (32 hex 字符串), aesKey (16 字符 ASCII 字符串, charcode 1-127), 
//      cert (ArrayBuffer, ≤10KB, 实测用 bilidrm_pub.key 的 PEM 字节即可)
// 输出 { osStatus: 0, spc: <base64> }
sdk.biliDRMGenSPC(kid, aesKey, cert) → SPC

// 输入 ckc (ArrayBuffer, 服务端响应里的 CKC 字节), aesKey (同上)
// 输出 { osStatus: 0, iv: <base64>, key: <base64> }
sdk.biliDRMParseCKC(ckc, aesKey) → {iv, key}
```

错误码（`OSStatus`）取自 Apple FairPlay 命名空间——意味着 B 站 cheese DRM 是 **FairPlay 风格 SPC/CKC 协议的复用**，不是 Widevine 也不是真 ClearKey。但因为 mp4 容器本身用 CENC 加密，最终的 16 字节 AES key 仍可被 mp4decrypt 直接消费。

### 3.3 服务端 endpoints

| URL | 用途 | 当前状态 |
|---|---|---|
| `https://api.bilibili.com/pugv/player/web/playurl?...&drm_tech_type=2` | 第一次 playurl，回 `widevine_pssh`，`bilidrm_uri` 为空 | ✓ 200 |
| `https://api.bilibili.com/pugv/player/web/playurl?...`（无 drm_tech_type） | 第二次 playurl，回非空 `bilidrm_uri`，无 `widevine_pssh` | ✓ 200 |
| `https://api.bilibili.com/pugv/player/web/v2/playurl?...` | v2 端点 | ❌ 404（cheese 不可用，BBDown 老代码下不了课程的根因）|
| `https://bvc-drm.bilivideo.com/cer/bilidrm_pub.key` | RSA 公钥（PEM, 272B, RSA-2048 SPKI）| ✓ 200 |
| `https://bvc-drm.bilivideo.com/cer/bilibili_certificate.bin` | Widevine cert (707B) | ✓ 200 |
| `https://bvc-drm.bilivideo.com/bili_widevine` | Widevine license | ✓ 200（仅播放器实际播放时调）|
| `https://bvc-drm.bilivideo.com/bilidrm` | **ClearKey 路径的 license endpoint，关键** | ✓ 200，**body 必须 `Content-Type: application/json`，shape `{"spc": "<base64>"}`**（错了会返 `40002 only support JSON format`）；响应是 JSON 套 base64 CKC，例如 `{"code":0, "data":{"ckc":"<b64>", ...}}`，CKC ~84B |
| `https://s1.hdslb.com/bfs/static/player/main/widgets/npd.drm_sdk.7d8e1e5f.js` | DRM SDK | ✓ 200，**hash `7d8e1e5f` 与 2025-08 笔记一致，未更新** |

### 3.4 端到端流程

```
[BBDown / 用户脚本端]
1. GET season → 拿全 ep 列表
2. GET playurl (no drm_tech_type) → 提取 bilidrm_uri → KID (32 hex)
3. 加载 npd.drm_sdk.js (浏览器 webpack chunk hook 或 Node.js 类似)
4. await sdk.ready
5. aesKey = 16 字节随机 ASCII 字符串 (charcode 1-127)
6. cert = GET bilidrm_pub.key (ArrayBuffer)
7. {spc} = sdk.biliDRMGenSPC(KID, aesKey, cert)
8. POST /bilidrm  Content-Type: application/json  body=`{"spc":"<base64>"}`
9. 解响应 JSON, 取出 data.ckc (base64), atob → ArrayBuffer
10. {iv, key} = sdk.biliDRMParseCKC(ckcBuf, aesKey)
11. b64→hex; key 是 16 字节 = 32 hex

[BBDown 解密]
12. 正常下载加密 mp4/m4a (走 v1 playurl)
13. mp4decrypt --key kid:key in.mp4 out.mp4
14. ffmpeg/mp4box mux
```

---

## 4. 重要踩坑记录（避免下次重蹈）

### 4.1 SDK factory 返回值

```js
// SDK 工厂 E(cfg)：
//   1) mutate cfg 把 ready/biliDRMGenSPC/biliDRMParseCKC 挂上去
//   2) return cfg.ready  ← 返回的是 Promise, 不是 instance!
const instance = {};
const ready = factory(instance);
await ready;
// instance.biliDRMGenSPC, instance.biliDRMParseCKC 才能用
// 错: const inst = factory({}) → inst 是 Promise, 没有 exports
```

### 4.2 `aesKey` 是字符串不是 Uint8Array

SDK 内部 `h(aesKey)` 把它当 UTF-8 写入 WASM，必须是 16 个 charcode ≤ 127 的 ASCII 字符（每字符的 charcode 直接当那一字节的 AES key 字节）。如果用 `String.fromCharCode(...buf)` 中含 ≥128 字节，会被 UTF-8 编码膨胀，不再是 16 字节，结果一定算错。

### 4.3 POST `/bilidrm` 的 body 格式

- `Content-Type` 必须 `application/json`，否则服务端回 `{"status":40002, "message":"only support JSON format"}`
- body shape `{"spc": "<base64>"}` 工作，其他 shape（`data` / `SPC` / 加 kid 的）也试过，统一返回 200 时取 JSON `data.ckc` 字段
- 必须带 cookie（`anonymous: false`），否则未授权

### 4.4 `--drm-tech-type=2` 的 playurl 响应特性

带 `drm_tech_type=2` 时：
- 有 `widevine_pssh`
- `bilidrm_uri` 是 **空串**（笔记 §3 描述符合）
- `drm_type: "bili_drm"`

**所以走 ClearKey 路径必须发"不带 `drm_tech_type=2`"那一次 playurl**，否则 `bilidrm_uri` 永远空。

### 4.5 v2 端点与 v1 端点

- BBDown 老代码用 `/pugv/player/web/v2/playurl`（从 bangumi 链路继承），**对 cheese 课程返回 404**，已在 `Parser.cs` 修复。
- 浏览器实际播放走的是 `/pugv/player/web/playurl`（无 v2）。

### 4.6 webpack chunk JSONP 截获

SDK 加载方式特殊——它 push 到全局 `nanoWidgetsJsonp` 数组，需要在加载 SDK script 之前 patch `nanoWidgetsJsonp.push` 才能截获 chunk。chunk ID `565`，module ID `36861`。如果未来 hash 变了，这两个 ID 也可能变，需要重新看 SDK 源码顶部的 `(self.nanoWidgetsJsonp=...).push([[XXX], {YYY: function(...) {...}}])`。

---

## 5. 已经验证 OK 的样本

```
课程: 数独高玩速成班 (ss723490818, 58 集)
P5: ep2285190 / 行列排除法 / 8m07s
KID: 10c8d74d3f58448bb81d81d347f8b2a2
KEY/IV: 运行时通过 --drm-auto 或用户脚本获取（勿写入仓库）
```

P5 已在本地验证下载并解密通过。其他集的 KID 可在脚本面板中查看；key 需逐集 `[🔑 试取Key]` 触发（每次约 200–500ms）。

---

## 6. 文件分布

```
<repo-root>/
├── HANDOVER.md                            ← 本文件
├── cheese.sh                              ← 一键下载脚本
├── bilibili_drm_流程分析笔记.md           ← 看雪原文整理（旧协议参考）
├── npd.drm_sdk.7d8e1e5f.js                ← B 站 DRM SDK（离线备用，亦可从 CDN 获取）
├── Bento4/                                ← git submodule（mp4decrypt 源码，上游无本地修改）
├── BBDown/                                ← 改造后的 BBDown 源码（fork，非 submodule）
│   ├── BBDown/
│   │   ├── BBDownDrm.cs
│   │   ├── Program.cs
│   │   └── ...
│   ├── BBDown.Core/
│   │   └── Parser.cs                      ← DRM 解析 + v1 端点
│   └── scripts/
│       ├── bili-drm-helper.js             ← Node.js --drm-auto helper
│       └── bili-cheese-key-helper.user.js ← Tampermonkey 脚本
└── (gitignored: publish*/, BBDown.data, diag*.txt, netlog.txt, html cache)
```

---

## 7. 后续可改进项

- 用户脚本 v0.3：加「批量拉所有集 Key」按钮，串行调 `extractClearKey`，间隔约 200ms。
- `Parser.cs` 的 cheese 端点改造可重构成更明确的分支（当前是字符串替换，功能正确）。
- 扩大测试矩阵：不同品类课程、不同付费档位、旧课程是否走同一协议。
- `BBDownDrm.IsAvailable` 的 mp4decrypt 探测略 hacky，可改为 `--version` 类探测。

---

## 8. 依赖与环境

| 依赖 | 用途 |
|---|---|
| .NET 9 SDK | 编译 BBDown |
| Node.js ≥ 18 | `--drm-auto`（`bili-drm-helper.js`）|
| mp4decrypt | 解密 CENC 容器（Bento4 submodule 或系统安装）|
| ffmpeg | 混流（BBDown 原有依赖）|

首次使用：
```bash
git submodule update --init --recursive   # 拉取 Bento4（可选，仅需自行编译 mp4decrypt 时）
./BBDown/bbdown.sh login                # 扫码登录，生成 publish/BBDown.data
./cheese.sh ss723490818                 # 下载全集
```

---

## 9. 关键链接

- 看雪原文（笔记基础）：https://bbs.kanxue.com/thread-287970.htm
- BBDown 上游：https://github.com/nilaoda/BBDown
- Bento4 上游：https://github.com/axiomatic-systems/Bento4
- bento4 (mp4decrypt)：https://www.bento4.com/developers/dash/encryption_and_drm/
- W3C EME 标准（ClearKey JWK 格式）：https://www.w3.org/TR/encrypted-media/