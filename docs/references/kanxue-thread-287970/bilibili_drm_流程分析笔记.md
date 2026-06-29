# Bilibili DRM 视频流程分析笔记

> 基于看雪论坛文章 [thread-287970](https://bbs.kanxue.com/thread-287970.htm)（作者 mb_jepgtozh，2025-08-11）整理的技术笔记。
> 本笔记为复述+图片信息提取，重点保留代码片段、接口字段、调用链等可直接用于复现的技术信息。
> 原文配图嵌入 [`article.html`](article.html)（资源在 [`article_files/`](article_files/)）；2026 现行协议差异见 [`docs/cheese-drm-notes.md`](../../cheese-drm-notes.md)。

---

## 0. 范围

仅梳理 B 站 (bilibili / 课堂 cheese) DRM 视频的密钥获取链路与整体流程，不涉及具体算法实现与逆向细节。

测试样本：`https://www.bilibili.com/cheese/play/ep1302284`（课堂付费课程）

---

## 1. 背景知识：浏览器 DRM 三件套

| 模块 | 作用 |
|---|---|
| **EME**（Encrypted Media Extensions） | W3C 标准 JS API，让网页与浏览器内置 CDM 通信，自身不接触密钥 |
| **CDM**（Content Decryption Module） | 浏览器/系统内置的真正解密模块。Chrome=Widevine、Safari=FairPlay、Edge=PlayReady |
| **MSE**（Media Source Extensions） | DASH/HLS 这类自适应流必须通过它把分片喂给 `<video>` |

DASH 加密流的标准播放流程：

1. 拉取并解析 `.mpd` 清单。
2. 创建 `MediaSource` → 绑定到 `<video>.src` → 在其上创建 `SourceBuffer`，逐段 `appendBuffer()` 加密分片。
3. 加密分片到达时触发 `'encrypted'` 事件 → 进入 EME 握手。

EME 握手 8 步（关键 API 串）：

```text
navigator.requestMediaKeySystemAccess('com.widevine.alpha', cfg)
  → access.createMediaKeys()
  → video.setMediaKeys(mediaKeys)
  → video.addEventListener('encrypted', e => {
        session = mediaKeys.createSession()
        session.generateRequest('cenc', e.initData)
        // session 'message' 事件触发
        session.addEventListener('message', m => {
            fetch(licenseServerUrl, { method:'POST', body:m.message })
              .then(r => r.arrayBuffer())
              .then(license => session.update(license))   // CDM 拿到 key
        })
    })
```

支持的 KeySystem 字符串（B 站播放器内）：

```js
this.CLEARKEY_KEYSTEM_STRING  = "org.w3.clearkey",
this.WIDEVINE_KEYSTEM_STRING  = "com.widevine.alpha",
this.PLAYREADY_KEYSTEM_STRING = "com.microsoft.playready"
```

---

## 2. 涉及的网络请求一览

> 图 1（请求列表）展示开发者工具 Network 面板中 DRM 相关请求的串行顺序：`playurl?` → `bilibili_certificate.bin` → `bili_widevine` → 第二次 `playurl` → `npd.drm_sdk.7d8e1e5f.js` → `bilidrm_pub.key` → `bilidrm`。所有 XHR 都由 `xhr_hook.js` 发起，主 SDK 由 `core.f404b15e.js:209` 注入。

| # | 接口 | 用途 |
|---|------|------|
| 1 | `https://api.bilibili.com/pugv/player/web/playurl?avid=…&drm_tech_type=2` | **第一次** playurl，返回 `widevine_pssh`（无 `bilidrm_uri`） |
| 2 | `https://bvc-drm.bilivideo.com/cer/bilibili_certificate.bin` | Widevine `serverCertificate`（二进制） |
| 3 | `https://bvc-drm.bilivideo.com/bili_widevine` | License 请求（POST），首次会返回 `device-certificate-revoked` |
| 4 | `https://api.bilibili.com/pugv/player/web/playurl?avid=…` | **第二次** playurl（**无** `drm_tech_type=2`），返回 `bilidrm_uri`（无 `widevine_pssh`） |
| 5 | `https://s1.hdslb.com/bfs/static/player/main/widgets/npd.drm_sdk.7d8e1e5f.js` | CKC 解密模块（前端 JS） |
| 6 | `https://bvc-drm.bilivideo.com/cer/bilidrm_pub.key` | DRM 公钥 |
| 7 | `https://bvc-drm.bilivideo.com/bilidrm` | CKC 数据 → 最终产出 `kid` / `key` |

> 注：`drm_tech_type=2` 只在第一次 playurl 用，控制响应里给 `widevine_pssh` 还是 `bilidrm_uri`，两次互斥。

---

## 3. playurl 响应中的 DRM 字段

> 图 2（playurl 响应）截图显示在 DASH 节点下出现了原本没有的字段：
> - `drm_type: "widevine"`
> - `dash.video[]` 每个流对象里多了 `widevine_pssh: "AAAAT3Bz…"`（base64，前缀对应 PSSH box magic `pssh`）
> - 同级还有 `bilidrm_uri`（首次为空字符串）
> - 其它常规字段：`base_url / backup_url / segment_base.initialization / index_range / codecs / size / bandwidth / mime_type / md5 …`

要点：每个音视频流都自带一份 `widevine_pssh`，所以解密时是逐流处理。

---

## 4. widevine_pssh → InitData

### 4.1 PSSH 注入到 ContentProtection

> 图 3（`setContentProtectionPSSH`）：JS 里把响应字段 `widevine_pssh` 拼装成 W3C ContentProtection 形式：
>
> ```js
> e.setContentProtectionPSSH = function (e) {
>   return Array.isArray(e) ? e.map(function (e) {
>     return e && e.widevine_pssh && (e.ContentProtection = {
>       schemeIdUri: "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", // Widevine UUID
>       pssh: { __prefix: "cenc", __text: e.widevine_pssh }
>     }), e
>   }) : e
> }
> ```

> 图 4（运行时对象）：在断点中可见每条流对象上挂了：
> - `ContentProtection.pssh.__prefix = "cenc"`
> - `ContentProtection.pssh.__text = "AAAAT3Bz…"`
> - `ContentProtection.schemeIdUri = "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"`（Widevine 标准 UUID）
> - `bilidrm_uri: ""`（首次空）

### 4.2 InitData 工厂

> 图 5（KeySystem 工厂）：`dashjs.FactoryMaker.getSingletonFactory(...)`，关键变量：
>
> ```js
> S.__dashjs_factory_name = "KeySystemW3CClearKey"
> var w = "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"
> var T = p.WIDEVINE_KEYSTEM_STRING
> var R = "urn:uuid:" + w
> ```
>
> 工厂返回对象暴露 `getInitData(e)`、`getRequestHeadersFromMessage`、`getLicenseRequestFromMessage`、`getLicenseServerURLFromInitData` 等钩子。
>
> **断点建议**：因为环境差异会切换 KeySystem，把 ClearKey/Widevine/PlayReady 三个工厂的 `getInitData` 都打上断点最稳。

### 4.3 PSSH 解析

> 图 6（`parsePSSHList` + 内存视图）：实际将 base64 解码成 `Uint8Array` 后扫描 `pssh` magic（`0x70 0x73 0x73 0x68`，对应整数 `1886614376`），按 4 字节大端长度切出每个 PSSH box：
>
> 内存十六进制示例：`00 00 00 4F 70 73 73 68 00 00 00 00 ED EF 8B A9 79 D6 4A CE A3 C8 27 DC D5 1D 21 ED …` — `4F` 是 box 总长度 79 字节，`70 73 73 68` 是 `pssh`，紧跟 Widevine SystemID 后是 PSSH 数据，尾部 ASCII 可见 `bilibili`。

---

## 5. bilibili_certificate.bin（Widevine serverCertificate）

### 5.1 触发路径

> 图 7（`fetchPlayUrl` 回调）：`httpStore.fetchPlayUrl(...)` 完成后，主流程在 `setMpdBody(e.body, n)` 处分支（图中红色箭头）。该回调还做了 `aid/cid/episodeId` 的写入和广告补丁。

> 图 8（`attachExternal`）：drm 流走的是 `b.attachExternal({ mediaDataSource, quality }, { initiator, preloadAVData, enableTransition })`。

> 图 9（`attachExternal` 内部 → `attachSourceProxy`）：经过若干 `validPerm`/`fakeSwitch` 判断后，调用 `this.kernelAtom.attachSourceProxy(e)`。

### 5.2 attachSourceProxy 主分支

> 图 10（`attachSourceProxy` 全貌）：核心是按 `e.mediaDataSource.type === "dash"` 进入 switch，再以 `a.drmTechType` 分流：
>
> ```js
> switch (a.drmTechType) {
>   case 3:                        // ClearKey
>     var l = a.streamKid,
>         c = i.guardAtom.getKeyDetail(1);
>     // c.promise.then(r => u(e, { protectionData: r.protectionData }))
>     // 失败 fallback(5100, "clearKeys")
>     break;
>   case 2:                        // Widevine
>     var d = i.guardAtom.getWidevineDetail();
>     // d.promise.then(r => u(e, {
>     //     protectionData: r.protectionData,
>     //     ignoreEmeEncryptedEvent: !0
>     // }))
>     // 失败 fallback(5300, "widevine")
>     break;
> }
> ```
>
> `case 2` 内部首次调用就会触发 `bilibili_certificate.bin` 的 GET。

### 5.3 证书装载

> 图 11（Widevine 路径成功回调）：拿到证书并 base64 后写入 `protectionData`：
>
> ```js
> u(e, {
>   protectionData: r.protectionData,   // { "com.widevine.alpha": { serverURL, serverCertificate } }
>   ignoreEmeEncryptedEvent: !0
> })
> ```
>
> 实际控制台值：
>
> ```
> protectionData["com.widevine.alpha"] = {
>   serverURL: "//bvc-drm.bilivideo.com/bili_widevine",
>   serverCertificate: "Cr0C…"   // 即 bilibili_certificate.bin 的 base64
> }
> ```

---

## 6. bili_widevine：License 请求与 device-certificate-revoked

### 6.1 License 请求构造

> 图 12（`updateKeySession` / XHR 拼装）：dashjs 内部生成 `license-request` 后，构造 `XMLHttpRequest`：
>
> ```js
> var g = new XMLHttpRequest();
> var v = "//bvc-drm.bilivideo.com/bili_widevine";
> // 若 mediaSource 提供了 serverURL 则用它覆盖
> if (f && f.serverURL) v = f.serverURL;
> g.open(h.getHTTPMethod(o), v, !0);
> g.responseType = h.getResponseType(p, o);     // p = "com.widevine.alpha"
> g.onload = function () {
>   if (200 == this.status) {
>     var e = h.getLicenseMessage(this.response, p, o);
>     // 走正常 update 分支
>     null !== e ? (C(y), y = { sessionToken:…, messageType:'license-request' },
>                   n.updateKeySession(d, e))
>                : E(this, y, p, o);
>   }
> }
> g.send(b.getLicenseRequestFromMessage(a));
> ```
>
> 关键参数：`pakku_url: '//bvc-drm.bilivideo.com/bili_widevine'`、`responseType: "arraybuffer"`、`a` 是 EME `'message'` 事件的 ArrayBuffer(1733)。

### 6.2 首次响应（不是 License）

> 图 13（响应字节）：响应不是 Widevine License，而是 JSON：
>
> ```json
> {"message":"device-certificate-revoked: …", "status": …}
> ```
>
> 字面意思：**Widevine 设备证书被吊销**。这里其实是 B 站故意把 Widevine 链路打断，目的是让前端走到失败回调，进入第二条链路。

### 6.3 updateKeySession 抛错

> 图 14（`updateKeySession`）：把上面的"许可证"塞给 `MediaKeySession.update()` 必然失败：
>
> ```js
> updateKeySession: function (e, t) {
>   var r = e.session;        // MediaKeySession
>   d.isClearKey(a) && (t = t.toJWK());
>   r.update(t).catch(function (r) {
>     var a = function (e) {
>       try { return String.fromCharCode.apply(null, new Uint8Array(e)) }
>       catch (e) { return o("DRM: Error converting ArrayBuffer to string! " + e.message), "" }
>     }(t);
>     var s = "Error sending update() message! " + r.name + " - " + a;
>     n.trigger(i.KEY_ERROR, { data: new K(e, s) });
>   })
> }
> ```
>
> Widevine 路径 catch 后命中 `fallback(5300, "widevine")` → 触发回退到 ClearKey 路径。

---

## 7. 第二次 playurl + bilidrm_uri：拿到真正的 kid

### 7.1 接口区别

| 字段 | 第一次 playurl<br>(`drm_tech_type=2`) | 第二次 playurl<br>(无该参数) |
|---|---|---|
| `drm_type` | `"widevine"` | `"widevine"` |
| `widevine_pssh` | 有 | **无** |
| `bilidrm_uri` | `""` | **有**，形如 `bili://d8f66b93db284984b4e7fc50d71278ff//<id>` 或带 url 形式 |

### 7.2 ClearKey 路径取 streamKid

> 图 15（`attachSourceProxy` 之 case 3）：fallback 后 `drmTechType` 走到 `case 3`：
>
> ```js
> case 3:
>   var l = a.streamKid,                          // 形如 "d8f66b93db284984b4e7fc50d71278ff"
>       c = i.guardAtom.getKeyDetail(1);          // 1 = streamKid 的来源标识
>   …
>   c.promise.then(r => u(e, { protectionData: r.protectionData }))
>   // 失败 fallback(5100, "clearKeys")
>   break;
> ```

### 7.3 streamKid 的来源 = bilidrm_uri 末段

> 图 16（getter）：相同模块里有一个属性 getter，从 `mediaDataSource.video / audio` 数组中读 `bilidrm_uri`，按 `"//"` 切，取最后一段：
>
> ```js
> if (Array.isArray(n) && n.length) {
>   var i = n[0],
>       o = null == i ? void 0 : i.bilidrm_uri;
>   if (typeof o === "string") return o.split("//").pop();
> }
> return null;
> ```
>
> 例：`bilidrm_uri = "bili://d8f66b93db284984b4e7fc50d71278ff//…"` → `pop()` 取到尾段（kid 十六进制串）。

---

## 8. 最终拿 key：getKeyDetail / npd.drm_sdk / bilidrm

### 8.1 getKeyDetail 返回结构

> 图 17（`getKeyDetail(1).promise.then(r => …)`）：promise 解析后的 `r` 在断点里展开为：
>
> ```js
> r = {
>   osStatus: 0,
>   iv:  "pIEmSahBQLWILQEUa+yFEw==",        // base64
>   key: "c6xChuWnTweKvL8/j0Cm8A==",        // base64 (标准)
>   protectionData: { "org.w3.clearkey": { clearkeys: { … }, priority: 0 } }
> }
> ```
>
> 注：实际作者抓到的 `protectionData.org.w3.clearkey.clearkeys` 的键值都是 **base64 url-safe** 形式，例如：
>
> ```json
> {
>   "osStatus": 0,
>   "iv":  "pIEmSahBQLWILQEUa+yFEw==",
>   "key": "c6xChuWnTweKvL8/j0Cm8A==",
>   "protectionData": {
>     "org.w3.clearkey": {
>       "clearkeys": {
>         "2PZrk9soSYS05_xQ1xJ4_w": "c6xChuWnTweKvL8_j0Cm8A"
>       },
>       "priority": 0
>     }
>   }
> }
> ```

`npd.drm_sdk.7d8e1e5f.js` + `bilidrm_pub.key` + POST `bilidrm` 三者协作产生上面这块 JSON（作者注明逻辑较直接，未深入分析）。

### 8.2 关键点

- `clearkeys` 的 **key 名是 base64-urlsafe 编码的 KeyID**，**值是 base64-urlsafe 编码的 Key**。
- `==` 等填充被去掉、`/` 替换为 `_`、`+` 替换为 `-`，所以解码时务必选 **URL-safe base64 (RFC 4648 §5)**。

---

## 9. 复现：用 ClearKey 解密下载

### 9.1 下载加密流（不合并）

```bash
BBDown.exe https://www.bilibili.com/cheese/play/ep1302284 --skip-mux
```

### 9.2 base64 → hex（kid:key）

> 图 18（CyberChef 截图）：用 CyberChef，配置 `From Base64 → Alphabet: URL safe (RFC 4648 §5): A-Za-z0-9-_` → `To Hex: Delimiter None`。
>
> 输入 `2PZrk9soSYS05_xQ1xJ4_w` → 输出 `d8f66b93db284984b4e7fc50d71278ff`（这就是 kid）
>
> 同法把 `c6xChuWnTweKvL8_j0Cm8A` → `73ac4286e5a74f078abcbf3f8f40a6f0`（key）

最终凭据：

```
kid : d8f66b93db284984b4e7fc50d71278ff
key : 73ac4286e5a74f078abcbf3f8f40a6f0
```

### 9.3 mp4decrypt 去 DRM + ffmpeg 合并

```bash
mp4decrypt.exe --key d8f66b93db284984b4e7fc50d71278ff:73ac4286e5a74f078abcbf3f8f40a6f0 "voice.m4a" "voice_.m4a"
mp4decrypt.exe --key d8f66b93db284984b4e7fc50d71278ff:73ac4286e5a74f078abcbf3f8f40a6f0 "video.mp4" "video_.mp4"

ffmpeg.exe -i voice_.m4a -i video_.mp4 -c:v copy -c:a copy output.mp4
```

---

## 10. 流程总览（合并视图）

```text
┌── playurl?…&drm_tech_type=2 ──────────► widevine_pssh (每条流)
│                                          │
│   setContentProtectionPSSH               ▼
│   ── 注入 cenc PSSH，schemeIdUri = urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed
│
├── attachExternal → attachSourceProxy
│        │
│        ├── (case 2: widevine)
│        │       ├── GET bilibili_certificate.bin   → serverCertificate (base64)
│        │       └── POST bili_widevine             → 返回 device-certificate-revoked
│        │             updateKeySession(...).update().catch  → fallback(5300,"widevine")
│        │
│        └── (case 3: clearKeys)  ← 上一步失败后回退
│                ├── 第二次 playurl（无 drm_tech_type）→ 含 bilidrm_uri
│                ├── streamKid = bilidrm_uri.split("//").pop()
│                ├── getKeyDetail(1)：
│                │      └── 加载 npd.drm_sdk.js + bilidrm_pub.key
│                │           POST bilidrm  → { osStatus, iv, key, protectionData{ clearkeys{kid:key} } }
│                └── 用 clearkeys 让 CDM 解密；离线复现走 mp4decrypt
└────────────────────────────────────────────────────────────────────────────────
```

要点回顾：

- **Widevine 链路是诱饵**：服务端故意返回 `device-certificate-revoked`，让客户端 fallback 到 ClearKey。
- **PSSH 与 KID 来自不同接口**：`widevine_pssh` 来自带 `drm_tech_type=2` 的 playurl；`bilidrm_uri`（含 KID）来自不带该参数的 playurl，需要重发请求。
- **ClearKey JSON 内 key/kid 是 url-safe base64**，转 hex 时一定换成 URL-safe alphabet。
- 真正密钥来自 `bilidrm` 接口（CKC 数据），由 `npd.drm_sdk.js` 配合 `bilidrm_pub.key` 解析。

---

## 参考

- bento4 DASH 加密与 DRM：<https://www.bento4.com/developers/dash/encryption_and_drm/>
- BBDown：<https://github.com/nilaoda/BBDown>
- 原文离线版：[article.html](article.html)（看雪 [thread-287970](https://bbs.kanxue.com/thread-287970.htm)）
