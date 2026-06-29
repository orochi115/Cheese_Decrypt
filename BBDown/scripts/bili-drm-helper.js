#!/usr/bin/env node
// bili-drm-helper.js — Node.js side of BBDown --drm-auto.
// 内化 npd.drm_sdk.7d8e1e5f.js 的 SPC/CKC 协议, 给定 kid + cookie 输出 ClearKey。
// 与 BBDown/scripts/bili-cheese-key-helper.user.js 的 extractClearKey 流程对齐。
// 依赖: Node.js >= 18 (内置 fetch / WebAssembly / vm)。
//
// 用法:
//   node bili-drm-helper.js get-key --kid <hex32> --cookie "<cookie串>" [--sdk-path <文件>] [--json]
// 退出码 0 + stdout 一行 "kid:key" (lowercase hex), 失败时 stderr 带 [phase] 标签 + 非 0 退出。

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');

const SDK_URL = 'https://s1.hdslb.com/bfs/static/player/main/widgets/npd.drm_sdk.7d8e1e5f.js';
const SDK_FILENAME = 'npd.drm_sdk.7d8e1e5f.js';
const SDK_CHUNK_ID = 565;
const SDK_MODULE_ID = 36861;
const BILIDRM_PUB_KEY_URL = 'https://bvc-drm.bilivideo.com/cer/bilidrm_pub.key';
const BILIDRM_POST_URL = 'https://bvc-drm.bilivideo.com/bilidrm';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function die(phase, msg, code = 1) {
    process.stderr.write(`[${phase}] ${msg}\n`);
    process.exit(code);
}

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) {
                out[key] = true;
            } else {
                out[key] = next;
                i++;
            }
        } else {
            out._.push(a);
        }
    }
    return out;
}

function cacheDir() {
    const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
    const d = path.join(base, 'bbdown-bili-drm');
    fs.mkdirSync(d, { recursive: true });
    return d;
}

async function loadSdkText(explicitPath) {
    if (explicitPath) {
        try { return await fsp.readFile(explicitPath, 'utf8'); }
        catch (e) { die('sdk-load', `读取 --sdk-path 失败 (${explicitPath}): ${e.message}`); }
    }
    // 1) 缓存
    const cached = path.join(cacheDir(), SDK_FILENAME);
    try {
        const st = await fsp.stat(cached);
        if (st.size > 100_000) return await fsp.readFile(cached, 'utf8');
    } catch { /* not cached */ }
    // 2) 与 helper 同目录 (publish/scripts/ 或源码 scripts/) — 离线备用
    const sibling = path.resolve(__dirname, SDK_FILENAME);
    try {
        const st = await fsp.stat(sibling);
        if (st.size > 100_000) {
            const text = await fsp.readFile(sibling, 'utf8');
            try { await fsp.writeFile(cached, text); } catch { /* best effort */ }
            return text;
        }
    } catch { /* nope */ }
    // 3) 远程下载
    let resp;
    try { resp = await fetch(SDK_URL); }
    catch (e) { die('sdk-load', `下载 SDK 失败: ${e.message}`); }
    if (!resp.ok) die('sdk-load', `下载 SDK HTTP ${resp.status}`);
    const text = await resp.text();
    if (text.length < 100_000) die('sdk-load', `SDK 体积异常 (${text.length} bytes), 可能是被反代/节流`);
    try { await fsp.writeFile(cached, text); } catch { /* best effort */ }
    return text;
}

function extractWasmBinary(sdkText) {
    const m = sdkText.match(/data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)/);
    if (!m) die('wasm-extract', 'SDK 中未找到 inline data:application/octet-stream;base64,... wasm');
    const b64 = m[1];
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 1024) die('wasm-extract', `wasm 解码异常, 大小 ${buf.length} bytes`);
    return buf;
}

async function loadSdkInstance(sdkText, wasmBinary) {
    const sandbox = {};
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    sandbox.window = sandbox;
    sandbox.console = console;
    sandbox.WebAssembly = WebAssembly;
    sandbox.TextEncoder = TextEncoder;
    sandbox.TextDecoder = TextDecoder;
    sandbox.atob = (s) => Buffer.from(s, 'base64').toString('binary');
    sandbox.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
    sandbox.setTimeout = setTimeout;
    sandbox.clearTimeout = clearTimeout;
    sandbox.setImmediate = setImmediate;
    sandbox.clearImmediate = clearImmediate;
    sandbox.queueMicrotask = queueMicrotask;
    sandbox.performance = { now: () => Number(process.hrtime.bigint() / 1_000_000n) };
    sandbox.URL = URL;
    sandbox.crypto = crypto.webcrypto;
    sandbox.document = { currentScript: { src: '' } };
    sandbox.location = { href: '', origin: '' };
    sandbox.navigator = { userAgent: UA };

    sandbox.nanoWidgetsJsonp = [];
    let captured = null;
    const origPush = sandbox.nanoWidgetsJsonp.push.bind(sandbox.nanoWidgetsJsonp);
    sandbox.nanoWidgetsJsonp.push = function (chunk) {
        try {
            if (chunk && Array.isArray(chunk[0]) && chunk[0].includes(SDK_CHUNK_ID) &&
                chunk[1] && chunk[1][SDK_MODULE_ID]) {
                captured = chunk[1][SDK_MODULE_ID];
            }
        } catch { /* ignore */ }
        return origPush(chunk);
    };

    const ctx = vm.createContext(sandbox);
    try {
        vm.runInContext(sdkText, ctx, { filename: SDK_FILENAME });
    } catch (e) {
        die('factory', `执行 SDK 脚本异常: ${e.message}`);
    }
    if (typeof captured !== 'function') {
        die('factory', `SDK chunk 未捕获到 module ${SDK_MODULE_ID} (chunk ${SDK_CHUNK_ID}), SDK 版本可能已变`);
    }

    // 手动跑 webpack 模块: captured(module, exports, __webpack_require__)
    // SDK 内部用 I.nmd(A), 我们 stub 一个 require + nmd
    const moduleObj = { exports: {} };
    const stubRequire = function () { return {}; };
    stubRequire.nmd = function (m) { return m; };
    try {
        captured(moduleObj, moduleObj.exports, stubRequire);
    } catch (e) {
        die('factory', `执行 SDK module 异常: ${e.message}`);
    }
    const factory = moduleObj.exports;
    if (typeof factory !== 'function') {
        die('factory', `SDK module.exports 不是函数 (typeof=${typeof factory})`);
    }

    // factory(cfg) mutate cfg, return cfg.ready
    const inst = { wasmBinary };
    let ready;
    try { ready = factory(inst); }
    catch (e) { die('factory', `调用 factory 异常: ${e.message}`); }
    try { await ready; }
    catch (e) { die('factory', `factory ready Promise reject: ${e && e.message ? e.message : e}`); }

    if (typeof inst.biliDRMGenSPC !== 'function' || typeof inst.biliDRMParseCKC !== 'function') {
        die('factory', `factory 完成但 instance 缺方法; keys=[${Object.keys(inst).join(',')}]`);
    }
    return inst;
}

async function fetchCert() {
    const cached = path.join(cacheDir(), 'bilidrm_pub.key');
    try {
        const buf = await fsp.readFile(cached);
        if (buf.length > 100) return buf;
    } catch { /* not cached */ }
    let resp;
    try { resp = await fetch(BILIDRM_PUB_KEY_URL); }
    catch (e) { die('cert-fetch', `下载证书异常: ${e.message}`); }
    if (!resp.ok) die('cert-fetch', `下载证书 HTTP ${resp.status}`);
    const ab = await resp.arrayBuffer();
    const buf = Buffer.from(ab);
    if (buf.length < 64) die('cert-fetch', `证书体积异常 ${buf.length} bytes`);
    try { await fsp.writeFile(cached, buf); } catch { /* best effort */ }
    return buf;
}

function genAesKey() {
    // 16 字节 ASCII (charcode 1..126), 必须是字符串而非 Uint8Array
    // 见 docs/cheese-drm-notes.md §4.2 与用户脚本 genAesSessionKey
    let s = '';
    for (let i = 0; i < 16; i++) s += String.fromCharCode(1 + crypto.randomInt(126));
    return s;
}

async function postBilidrm(spcB64, kid, cookie, verbose) {
    if (verbose) {
        process.stderr.write(`[debug] SPC length=${spcB64.length} head=${spcB64.slice(0, 64)}\n`);
        process.stderr.write(`[debug] cookie length=${cookie.length}\n`);
    }
    const candidates = [
        { spc: spcB64 },
        { spc: spcB64, kid },
        { data: spcB64 },
        { data: spcB64, kid },
        { SPC: spcB64 },
        { spc: spcB64, kid_id: kid },
        { spc_data: spcB64, kid },
    ];
    let lastInfo = '';
    for (const payload of candidates) {
        const shape = Object.keys(payload).join('+');
        const body = JSON.stringify(payload);
        let resp;
        try {
            resp = await fetch(BILIDRM_POST_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': 'https://www.bilibili.com',
                    'Referer': 'https://www.bilibili.com/',
                    'Accept': 'application/json, text/plain, */*',
                    'User-Agent': UA,
                    'Cookie': cookie,
                },
                body,
            });
        } catch (e) {
            lastInfo = `payload=${shape} network ${e.message}`;
            continue;
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        if (resp.status !== 200) {
            lastInfo = `payload=${shape} status=${resp.status} body=${buf.subarray(0, 160).toString('utf8')}`;
            if (verbose) process.stderr.write(`[debug] ${lastInfo}\n`);
            continue;
        }
        const head = buf.subarray(0, Math.min(160, buf.length)).toString('utf8').trimStart();
        if (head.startsWith('{')) {
            let j = null;
            try { j = JSON.parse(buf.toString('utf8')); }
            catch { lastInfo = `payload=${shape} JSON parse fail`; continue; }
            const fields = ['ckc', 'CKC', 'data', 'response', 'license'];
            let ckcB64 = null;
            for (const f of fields) {
                if (typeof j[f] === 'string' && j[f].length > 32) { ckcB64 = j[f]; break; }
                if (j.data && typeof j.data === 'object' && typeof j.data[f] === 'string' && j.data[f].length > 32) { ckcB64 = j.data[f]; break; }
            }
            // B 站 cheese DRM 服务端: status=200 (HTTP 风格) 表示成功 + ckc 在顶层。
            // 历史路径里 code/status === 0 也见过, 用户脚本里只接受 0/undefined; 这里放宽:
            // 有 ckc 字段就接受, 除非 code 显式非 0 错误。
            const codeBad = typeof j.code === 'number' && j.code !== 0;
            const statusBad = typeof j.status === 'number' && j.status !== 0 && j.status !== 200;
            if (ckcB64 && !codeBad && !statusBad) {
                return { ckc: Buffer.from(ckcB64, 'base64'), shape, raw: 'json' };
            }
            lastInfo = `payload=${shape} status=200 but no usable ckc; json=${JSON.stringify(j).slice(0, 400)}`;
            if (verbose) process.stderr.write(`[debug] ${lastInfo}\n`);
            continue;
        }
        if (buf.length > 32) {
            return { ckc: buf, shape, raw: 'bin' };
        }
        lastInfo = `payload=${shape} short response (${buf.length}B)`;
    }
    die('bilidrm-post', `所有 payload 都失败; last: ${lastInfo}`);
}

function bufferToArrayBuffer(buf) {
    // 复制成独立 ArrayBuffer, 避免 Buffer pool 共享给 SDK 造成奇怪偏移
    const out = new ArrayBuffer(buf.length);
    new Uint8Array(out).set(buf);
    return out;
}

async function getKey(args) {
    const kid = String(args.kid || '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(kid)) die('args', `--kid 必须 32 位 hex (got ${args.kid})`);
    const cookie = String(args.cookie || '');
    if (!cookie) die('args', '--cookie 必填 (浏览器登录态, 至少含 SESSDATA)');

    const sdkText = await loadSdkText(args['sdk-path']);
    const wasmBinary = extractWasmBinary(sdkText);
    const sdk = await loadSdkInstance(sdkText, wasmBinary);

    const certBuf = await fetchCert();
    const certAb = bufferToArrayBuffer(certBuf);
    const aesKey = genAesKey();

    let gen;
    try { gen = sdk.biliDRMGenSPC(kid, aesKey, certAb); }
    catch (e) { die('factory', `biliDRMGenSPC 抛错: ${e.message}`); }
    if (!gen || gen.osStatus !== 0 || !gen.spc) {
        die('factory', `biliDRMGenSPC osStatus=${gen && gen.osStatus} spc=${gen && gen.spc ? '<有>' : '<空>'}`);
    }

    const { ckc, shape } = await postBilidrm(gen.spc, kid, cookie, args.verbose === true);
    const ckcAb = bufferToArrayBuffer(ckc);

    let parsed;
    try { parsed = sdk.biliDRMParseCKC(ckcAb, aesKey); }
    catch (e) { die('ckc-parse', `biliDRMParseCKC 抛错: ${e.message}`); }
    if (!parsed || parsed.osStatus !== 0 || !parsed.key) {
        die('ckc-parse', `biliDRMParseCKC osStatus=${parsed && parsed.osStatus}`);
    }

    const keyHex = Buffer.from(parsed.key, 'base64').toString('hex');
    const ivHex = parsed.iv ? Buffer.from(parsed.iv, 'base64').toString('hex') : '';
    if (!/^[0-9a-f]{32}$/.test(keyHex)) {
        die('ckc-parse', `解析出的 key 不是 16 字节 hex: ${parsed.key}`);
    }

    if (args.json === true) {
        process.stdout.write(JSON.stringify({
            kid, key: keyHex, iv: ivHex,
            ckcLength: ckc.length, payloadShape: shape,
        }) + '\n');
    } else {
        process.stdout.write(`${kid}:${keyHex}\n`);
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const cmd = args._[0];
    if (cmd === 'get-key') {
        await getKey(args);
        return;
    }
    process.stderr.write(
        'usage:\n' +
        '  node bili-drm-helper.js get-key --kid <hex32> --cookie "<cookie>" [--sdk-path <file>] [--json]\n'
    );
    process.exit(2);
}

main().catch((e) => die('uncaught', (e && (e.stack || e.message)) || String(e)));
