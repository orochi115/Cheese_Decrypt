// ==UserScript==
// @name         B站课堂 DRM kid:key 助手 (BBDown)
// @namespace    https://github.com/nilaoda/BBDown
// @version      0.2.0
// @description  在B站课堂(cheese)播放页一键收集 BBDown --key 所需的 kid:key、epId/aid/cid。通过 npd.drm_sdk.js (FairPlay SPC/CKC) 协议自动提取 ClearKey。
// @author       BBDown contributors
// @match        https://www.bilibili.com/cheese/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      bvc-drm.bilivideo.com
// @connect      api.bilibili.com
// @connect      s1.hdslb.com
// @noframes     false
// ==/UserScript==

(function () {
    'use strict';

    // ------------------------------------------------------------------
    // 0. 公共工具
    // ------------------------------------------------------------------
    const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    const LOG_PREFIX = '%c[bili-drm]';
    const LOG_STYLE = 'color:#00a1d6;font-weight:bold;';
    const log = (...a) => console.log(LOG_PREFIX, LOG_STYLE, ...a);
    const warn = (...a) => console.warn(LOG_PREFIX, LOG_STYLE, ...a);

    function b64urlToHex(s) {
        if (typeof s !== 'string' || !s) return '';
        s = s.replace(/-/g, '+').replace(/_/g, '/');
        while (s.length % 4) s += '=';
        try {
            const raw = atob(s);
            let hex = '';
            for (let i = 0; i < raw.length; i++) {
                hex += raw.charCodeAt(i).toString(16).padStart(2, '0');
            }
            return hex;
        } catch (e) {
            return '';
        }
    }

    function getCookie(name) {
        const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : '';
    }

    function getSessdata() {
        return getCookie('SESSDATA');
    }

    // 从当前 URL 解析 epId / ssId
    function parseUrlIds() {
        const m = location.pathname.match(/\/cheese\/play\/(ep|ss)(\d+)/);
        if (!m) return { kind: null, id: null };
        return { kind: m[1], id: m[2] };
    }

    // ------------------------------------------------------------------
    // 1. 全局 store: 跨集累积，落 GM_setValue
    // ------------------------------------------------------------------
    const STORE_KEY = 'bilidrm-store-v1';

    function emptyStore() {
        return {
            // ssId -> { title, episodes: { epId: { aid, cid, title, index, streams: [...], keys: {kid:key} } } }
            seasons: {},
            // 全局 kid -> key 索引（与具体 ep 解耦，因为 EME 拦截只给 kid:key 不告诉是哪集）
            keys: {}
        };
    }

    function loadStore() {
        try {
            const raw = (typeof GM_getValue !== 'undefined') ? GM_getValue(STORE_KEY, null) : null;
            if (!raw) return emptyStore();
            const o = (typeof raw === 'string') ? JSON.parse(raw) : raw;
            if (!o || typeof o !== 'object') return emptyStore();
            if (!o.seasons) o.seasons = {};
            if (!o.keys) o.keys = {};
            return o;
        } catch (e) {
            warn('store load failed:', e);
            return emptyStore();
        }
    }

    let _saveTimer = null;
    function saveStore() {
        if (_saveTimer) return;
        _saveTimer = setTimeout(() => {
            _saveTimer = null;
            try {
                if (typeof GM_setValue !== 'undefined') GM_setValue(STORE_KEY, JSON.stringify(store));
            } catch (e) { warn('store save failed:', e); }
        }, 250);
    }

    const store = loadStore();
    const ui = { root: null, listEl: null, headerEl: null, currentSsId: null };

    // ------------------------------------------------------------------
    // 2. 解析 playurl/season 响应
    // ------------------------------------------------------------------
    // base64 (标准, 非 URL-safe) → Uint8Array
    function b64ToBytes(s) {
        try {
            const raw = atob(s);
            const u = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i);
            return u;
        } catch (e) { return null; }
    }
    function bytesToHex(u, off = 0, len = u.length) {
        let h = '';
        for (let i = off; i < off + len; i++) h += u[i].toString(16).padStart(2, '0');
        return h;
    }
    // 从 Widevine PSSH (base64) 中提取第一个 KID (32 hex 小写). 兼容 v0/v1 两种 box 形态.
    function kidFromWidevinePssh(b64) {
        const u = b64ToBytes(b64);
        if (!u || u.length < 32) return '';
        // PSSH box: [size 4][type 'pssh' 4][version 1][flags 3][SystemID 16] ...
        if (!(u[4] === 0x70 && u[5] === 0x73 && u[6] === 0x73 && u[7] === 0x68)) return '';
        const version = u[8];
        let p = 8 + 4 + 16;
        if (version > 0) {
            // [KID_count 4][KID[] 16 each]
            if (p + 4 > u.length) return '';
            const cnt = (u[p] << 24) | (u[p + 1] << 16) | (u[p + 2] << 8) | u[p + 3];
            p += 4;
            if (cnt > 0 && p + 16 <= u.length) return bytesToHex(u, p, 16);
        }
        // version 0: [data_size 4][protobuf data]
        if (p + 4 > u.length) return '';
        p += 4;
        // 在 data 内找 protobuf field 2 (tag 0x12) length 16 的第一个 KID
        for (let i = p; i < u.length - 17; i++) {
            if (u[i] === 0x12 && u[i + 1] === 0x10) {
                return bytesToHex(u, i + 2, 16);
            }
        }
        return '';
    }

    function walkForBilidrm(node, out, parentCtx) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            node.forEach(v => walkForBilidrm(v, out, parentCtx));
            return;
        }
        // 优先从 bilidrm_uri 取 (非空时)
        let kid = '';
        let drmUri = '';
        if (typeof node.bilidrm_uri === 'string' && node.bilidrm_uri) {
            drmUri = node.bilidrm_uri;
            const tail = drmUri.split('//').pop() || '';
            if (tail.length >= 32 && /^[0-9a-f]{32}$/i.test(tail.slice(0, 32))) {
                kid = tail.slice(0, 32).toLowerCase();
            }
        }
        // 兜底: 从 widevine_pssh 解析
        if (!kid && typeof node.widevine_pssh === 'string' && node.widevine_pssh) {
            const k = kidFromWidevinePssh(node.widevine_pssh);
            if (/^[0-9a-f]{32}$/i.test(k)) kid = k.toLowerCase();
        }
        if (kid) {
            const isVideo = node.codecid !== undefined || node.frame_rate !== undefined || node.width !== undefined;
            out.push({
                kind: isVideo ? 'video' : 'audio',
                id: String(node.id ?? ''),
                codecs: String(node.codecs ?? ''),
                bandwidth: Number(node.bandwidth ?? 0),
                kid,
                bilidrm_uri: drmUri,
                widevine_pssh: typeof node.widevine_pssh === 'string' ? node.widevine_pssh : ''
            });
        }
        for (const k of Object.keys(node)) {
            const v = node[k];
            if (v && typeof v === 'object') walkForBilidrm(v, out, parentCtx);
        }
    }

    function ensureSeason(ssId, title) {
        if (!ssId) return null;
        if (!store.seasons[ssId]) store.seasons[ssId] = { title: title || '', episodes: {} };
        else if (title && !store.seasons[ssId].title) store.seasons[ssId].title = title;
        return store.seasons[ssId];
    }

    function ensureEpisode(ssId, ep) {
        const s = ensureSeason(ssId);
        if (!s) return null;
        const id = String(ep.id || ep.epid || '');
        if (!id) return null;
        if (!s.episodes[id]) {
            s.episodes[id] = {
                epId: id,
                aid: String(ep.aid || ''),
                cid: String(ep.cid || ''),
                title: String(ep.title || ''),
                index: Number(ep.index || 0),
                streams: [],
                seenLicense: false,
                keys: {}
            };
        } else {
            // 补全缺失字段
            const e = s.episodes[id];
            if (!e.aid && ep.aid) e.aid = String(ep.aid);
            if (!e.cid && ep.cid) e.cid = String(ep.cid);
            if (!e.title && ep.title) e.title = String(ep.title);
            if (!e.index && ep.index) e.index = Number(ep.index);
        }
        return s.episodes[id];
    }

    function handleSeasonResp(json) {
        try {
            const data = json?.data;
            if (!data) return;
            const ssId = String(data.season_id || '');
            const title = String(data.title || '');
            const eps = Array.isArray(data.episodes) ? data.episodes : [];
            ensureSeason(ssId, title);
            ui.currentSsId = ssId;
            for (const ep of eps) {
                ensureEpisode(ssId, {
                    id: ep.id, aid: ep.aid, cid: ep.cid,
                    title: ep.title, index: ep.index
                });
            }
            saveStore();
            renderPanel();
            log(`season 解析: ssId=${ssId}, ${eps.length} 集`);
        } catch (e) { warn('handleSeasonResp:', e); }
    }

    function handlePlayurlResp(json, urlObj) {
        try {
            const epId = String(urlObj.searchParams.get('ep_id') || '');
            const aid = String(urlObj.searchParams.get('avid') || '');
            const cid = String(urlObj.searchParams.get('cid') || '');
            if (!epId) return;
            // playurl 响应可能是 { code, message, result: { video_info: {dash} } } 或 { code, data: { dash } } 等多种 schema
            // 统一递归找 bilidrm_uri
            const drmStreams = [];
            walkForBilidrm(json, drmStreams);

            // ssId 反查
            let ssId = ui.currentSsId;
            if (!ssId) {
                for (const sid of Object.keys(store.seasons)) {
                    if (store.seasons[sid].episodes[epId]) { ssId = sid; break; }
                }
            }
            if (!ssId) ssId = '_unknown_';
            const ep = ensureEpisode(ssId, { id: epId, aid, cid });
            if (!ep) return;

            if (drmStreams.length === 0) {
                // 诊断: 看响应里是否有 dash / drm_type / 错误码
                const sketch = sketchPlayurlResp(json);
                log(`playurl epId=${epId}: 未发现 bilidrm_uri`, sketch);
                ep.respCode = sketch.code;
                ep.respMsg = sketch.message;
                ep.hasDash = sketch.hasDash;
                ep.drmTypeRaw = sketch.drmType;
                ep.hasWidevinePssh = sketch.hasWidevinePssh;
                // 若响应正常但完全没有 DRM 字段, 标记为 "无DRM"
                if (sketch.code === 0 && sketch.hasDash && !sketch.drmType && !sketch.hasWidevinePssh) {
                    ep.noDrm = true;
                }
                saveStore();
                renderPanel();
                return;
            }
            // 合并 streams (按 kid 去重)
            const seen = new Set(ep.streams.map(s => `${s.kind}:${s.kid}`));
            for (const s of drmStreams) {
                const k = `${s.kind}:${s.kid}`;
                if (!seen.has(k)) {
                    ep.streams.push(s);
                    seen.add(k);
                }
            }
            // 关联已捕获的 key
            for (const s of ep.streams) {
                if (store.keys[s.kid] && !ep.keys[s.kid]) {
                    ep.keys[s.kid] = store.keys[s.kid];
                }
            }
            saveStore();
            renderPanel();
            log(`playurl epId=${epId}: 捕获 ${drmStreams.length} 路 DRM 流`);
        } catch (e) { warn('handlePlayurlResp:', e); }
    }

    // 概要: 用于诊断为什么没找到 bilidrm_uri
    function sketchPlayurlResp(json) {
        const out = {
            code: json?.code,
            message: json?.message || json?.msg,
            topKeys: json && typeof json === 'object' ? Object.keys(json) : [],
            hasDash: false,
            videoCount: 0,
            audioCount: 0,
            drmType: null,
            hasWidevinePssh: false,
            sampleStreamKeys: null
        };
        const dashCandidates = [
            json?.data?.dash,
            json?.result?.dash,
            json?.result?.video_info?.dash,
            json?.data?.video_info?.dash,
        ].filter(Boolean);
        if (dashCandidates.length) {
            const d = dashCandidates[0];
            out.hasDash = true;
            out.videoCount = Array.isArray(d.video) ? d.video.length : 0;
            out.audioCount = Array.isArray(d.audio) ? d.audio.length : 0;
            out.drmType = d.drm_type || null;
            if (Array.isArray(d.video) && d.video[0]) {
                out.sampleStreamKeys = Object.keys(d.video[0]).slice(0, 30);
                if (d.video[0].widevine_pssh) out.hasWidevinePssh = true;
            }
        }
        // 兜底深搜
        if (!out.drmType) out.drmType = deepFindKey(json, 'drm_type');
        if (!out.hasWidevinePssh && deepFindKey(json, 'widevine_pssh')) out.hasWidevinePssh = true;
        return out;
    }

    function deepFindKey(obj, key, depth = 0) {
        if (!obj || typeof obj !== 'object' || depth > 8) return null;
        if (Array.isArray(obj)) {
            for (const v of obj) { const r = deepFindKey(v, key, depth + 1); if (r != null) return r; }
            return null;
        }
        if (key in obj) {
            const v = obj[key];
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
            if (v) return true;
        }
        for (const k of Object.keys(obj)) {
            const r = deepFindKey(obj[k], key, depth + 1);
            if (r != null) return r;
        }
        return null;
    }

    // 缓存最近一次 playurl 原始响应, 用于「导出诊断」
    const _diag = { lastPlayurlUrl: '', lastPlayurlJson: null, sessionInitData: [], emeMessages: [] };

    function ingestApiResponse(url, text) {
        try {
            const u = new URL(url, location.origin);
            const path = u.pathname;
            const json = JSON.parse(text);
            if (path.includes('/pugv/view/web/season')) handleSeasonResp(json);
            else if (path.includes('/pugv/player/web/v2/playurl') || path.includes('/pugv/player/web/playurl')) {
                _diag.lastPlayurlUrl = url;
                _diag.lastPlayurlJson = json;
                handlePlayurlResp(json, u);
            }
        } catch (e) { /* not JSON or wrong endpoint */ }
    }

    // ------------------------------------------------------------------
    // 3. 钩子: XHR + fetch + MediaKeySession.update
    // ------------------------------------------------------------------

    // 3.1 XHR
    try {
        const XHRProto = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
        if (XHRProto) {
            const _open = XHRProto.open;
            const _send = XHRProto.send;
            XHRProto.open = function (method, url) {
                try { this.__bilidrm_url = url; } catch (e) {}
                return _open.apply(this, arguments);
            };
            XHRProto.send = function () {
                try {
                    this.addEventListener('load', () => {
                        try {
                            const url = this.responseURL || this.__bilidrm_url;
                            if (typeof url !== 'string') return;
                            if (!/\/pugv\/(player\/web\/(v2\/)?playurl|view\/web\/season)/.test(url)) return;
                            const txt = (this.responseType === '' || this.responseType === 'text') ? this.responseText : null;
                            if (txt) ingestApiResponse(url, txt);
                        } catch (e) {}
                    });
                } catch (e) {}
                return _send.apply(this, arguments);
            };
            log('XHR hooked');
        }
    } catch (e) { warn('XHR hook failed:', e); }

    // 3.2 fetch
    try {
        const _fetch = win.fetch;
        if (typeof _fetch === 'function') {
            win.fetch = function (input, init) {
                const p = _fetch.apply(this, arguments);
                try {
                    const url = (typeof input === 'string') ? input : (input && input.url) || '';
                    if (typeof url === 'string' &&
                        /\/pugv\/(player\/web\/(v2\/)?playurl|view\/web\/season)/.test(url)) {
                        p.then(res => {
                            try {
                                if (!res || !res.clone) return;
                                res.clone().text().then(t => ingestApiResponse(url, t)).catch(() => {});
                            } catch (e) {}
                        }).catch(() => {});
                    }
                } catch (e) {}
                return p;
            };
            log('fetch hooked');
        }
    } catch (e) { warn('fetch hook failed:', e); }

    // 3.3 MediaKeySession.update
    function handleClearKeyLicense(buf) {
        try {
            let bytes;
            if (buf instanceof ArrayBuffer) bytes = new Uint8Array(buf);
            else if (ArrayBuffer.isView(buf)) bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
            else return;
            // 仅处理 ASCII JSON; ClearKey JWK Set 以 '{' 起头
            if (bytes.length === 0 || bytes[0] !== 0x7B /* { */) return;
            const txt = new TextDecoder().decode(bytes);
            const j = JSON.parse(txt);
            if (!j || !Array.isArray(j.keys)) return;
            let captured = 0;
            for (const e of j.keys) {
                if (e && e.kty === 'oct' && typeof e.kid === 'string' && typeof e.k === 'string') {
                    const kid = b64urlToHex(e.kid);
                    const key = b64urlToHex(e.k);
                    if (/^[0-9a-f]{32}$/.test(kid) && /^[0-9a-f]{32}$/.test(key)) {
                        if (store.keys[kid] !== key) {
                            store.keys[kid] = key;
                            captured++;
                            log(`✓ 捕获 ClearKey  kid=${kid}  key=${key}`);
                        }
                    }
                }
            }
            if (captured > 0) {
                // 把新 key 反向回灌到所有已知 episode 的 ep.keys
                for (const ssId of Object.keys(store.seasons)) {
                    const eps = store.seasons[ssId].episodes;
                    for (const epId of Object.keys(eps)) {
                        const ep = eps[epId];
                        ep.seenLicense = true;
                        for (const s of ep.streams) {
                            if (store.keys[s.kid]) ep.keys[s.kid] = store.keys[s.kid];
                        }
                    }
                }
                saveStore();
                renderPanel(true /* flash */);
                try {
                    if (typeof GM_notification !== 'undefined') {
                        GM_notification({ title: 'BBDown DRM Helper', text: `捕获 ${captured} 个新 key`, timeout: 2500 });
                    }
                } catch (e) {}
            }
        } catch (e) { /* not ClearKey JSON */ }
    }

    function bytesPreview(buf, take = 64) {
        try {
            const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf)
                : ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
                : null;
            if (!u8) return null;
            const len = u8.length;
            const head = Array.from(u8.slice(0, take)).map(b => b.toString(16).padStart(2, '0')).join('');
            // ASCII 4-char box names扫描
            const ascii = [];
            for (let i = 4; i < Math.min(u8.length, 4096) - 4; i++) {
                let ok = true; let s = '';
                for (let j = 0; j < 4; j++) {
                    const c = u8[i + j];
                    if (c < 0x61 || c > 0x7a) { ok = false; break; }
                    s += String.fromCharCode(c);
                }
                if (ok && /^(pssh|tenc|senc|sinf|frma|schm|schi|moof|moov|trak|encv|enca|mdat|sidx|styp|free|mvex|trex)$/.test(s)) {
                    ascii.push(s + '@' + (i - 4));
                }
            }
            return { byteLength: len, head32: head, boxes: Array.from(new Set(ascii)).slice(0, 30) };
        } catch (e) { return { error: String(e) }; }
    }

    try {
        const MKS = win.MediaKeySession;
        if (MKS && MKS.prototype) {
            if (typeof MKS.prototype.update === 'function') {
                const _update = MKS.prototype.update;
                MKS.prototype.update = function (response) {
                    try {
                        _diag.emeMessages.push({ type: 'update', preview: bytesPreview(response) });
                        handleClearKeyLicense(response);
                    } catch (e) {}
                    return _update.apply(this, arguments);
                };
            }
            if (typeof MKS.prototype.generateRequest === 'function') {
                const _gr = MKS.prototype.generateRequest;
                MKS.prototype.generateRequest = function (initDataType, initData) {
                    try {
                        _diag.sessionInitData.push({ initDataType, preview: bytesPreview(initData) });
                        log(`✓ EME generateRequest type=${initDataType}`, _diag.sessionInitData[_diag.sessionInitData.length - 1].preview);
                    } catch (e) {}
                    return _gr.apply(this, arguments);
                };
            }
            // 挂监听 'message' 事件 (license challenge)
            const _addEL = EventTarget.prototype.addEventListener;
            log('MediaKeySession.update / generateRequest hooked');
        } else {
            warn('当前环境无 MediaKeySession, 无法挂钩 EME (检查浏览器是否支持 EME)');
        }
    } catch (e) { warn('EME hook failed:', e); }

    // ------------------------------------------------------------------
    // 4. 主动批量预拉取每集 playurl，补全 KID 列表（不能补全 key）
    // ------------------------------------------------------------------
    // 顺序尝试多个 playurl 端点变体, 直到某个返回 200 + 含 dash 的 JSON
    // 重要: 同时跑两份, 一份带 drm_tech_type=2 (拿 widevine_pssh), 一份不带 (拿非空 bilidrm_uri,
    // 探测 2025-08 笔记里描述的 ClearKey 路径在 2026 是否还活着)
    async function tryPlayurlForEp(ep) {
        // 模仿真实浏览器请求里的全套参数
        const session = (Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)).slice(0, 32);
        const commonQs = `avid=${ep.aid}&cid=${ep.cid}&qn=0&fnver=0&fnval=16&fourk=1&gaia_source=` +
            `&from_client=BROWSER&is_main_page=true&need_fragment=false&season_id=${ui.currentSsId || ''}` +
            `&isGaiaAvoided=false&client_attr=0&version_name=4.9.73&app_id=100&ep_id=${ep.epId}` +
            `&session=${session}&voice_balance=1`;
        const candidates = [
            // 1) 带 drm_tech_type=2: 应返回 widevine_pssh (KID 可推导)
            `https://api.bilibili.com/pugv/player/web/playurl?${commonQs}&drm_tech_type=2`,
            // 2) 不带 drm_tech_type=2: 笔记 §7 描述这条路应返回非空 bilidrm_uri (ClearKey 路径)
            `https://api.bilibili.com/pugv/player/web/playurl?${commonQs}`,
        ];
        const referer = `https://www.bilibili.com/cheese/play/ep${ep.epId}`;
        let any = false;
        for (const url of candidates) {
            try {
                const r = await fetch(url, {
                    credentials: 'include',
                    headers: { 'Accept': 'application/json, text/plain, */*' },
                    referrer: referer,
                    referrerPolicy: 'strict-origin-when-cross-origin',
                });
                if (!r.ok) continue;
                const t = await r.text();
                ingestApiResponse(url, t);
                if (ep.streams.length > 0) any = true;
            } catch (e) {
                warn(`prefetch ep ${ep.epId} url=${url} fail:`, e);
            }
        }
        return any;
    }

    let prefetchInflight = false;
    async function prefetchAllPlayurls() {
        if (prefetchInflight) return;
        prefetchInflight = true;
        try {
            const ssId = ui.currentSsId;
            if (!ssId || !store.seasons[ssId]) {
                // 还没拿到 season, 主动拉一次
                const { kind, id } = parseUrlIds();
                if (!id) { warn('当前 URL 无法解析 ep/ss'); return; }
                const seasonUrl = `https://api.bilibili.com/pugv/view/web/season?` +
                    (kind === 'ss' ? `season_id=${id}` : `ep_id=${id}`);
                const r = await fetch(seasonUrl, { credentials: 'include' });
                const t = await r.text();
                ingestApiResponse(seasonUrl, t);
            }
            const sId = ui.currentSsId;
            if (!sId || !store.seasons[sId]) { warn('season 拉取失败'); return; }
            const eps = Object.values(store.seasons[sId].episodes);
            // 限并发 3
            const queue = eps.slice();
            let okCount = 0, failCount = 0;
            const workers = Array.from({ length: 3 }, async () => {
                while (queue.length) {
                    const ep = queue.shift();
                    if (!ep || ep.streams.length > 0) continue;
                    const ok = await tryPlayurlForEp(ep);
                    if (ok) okCount++; else failCount++;
                    await new Promise(r => setTimeout(r, 80));
                }
            });
            await Promise.all(workers);
            renderPanel();
            log(`批量预拉完成, 共处理 ${eps.length} 集 (成功 ${okCount}, 失败 ${failCount})`);
            if (okCount === 0 && failCount > 0) {
                warn('全部失败. 提示: ① 必须已登录且已购买课程; ② 此课程 cookie 域可能不一致, 试试在浏览器右上角已登录状态下点 [批量拉KID].');
            }
        } finally {
            prefetchInflight = false;
        }
    }

    // ------------------------------------------------------------------
    // 5. 浮动面板 UI (Shadow DOM)
    // ------------------------------------------------------------------

    const PANEL_HTML = `
<div id="root">
  <div id="bar">
    <span id="title">BBDown DRM Helper</span>
    <span id="counter"></span>
    <button id="btn-prefetch" title="主动拉取整课 KID 列表">批量拉KID</button>
    <button id="btn-copy-all" title="复制所有已就绪的 BBDown 命令">全量BBDown</button>
    <button id="btn-diag" title="导出 playurl 响应 + EME 抓包概要">导出诊断</button>
    <button id="btn-toggle">_</button>
  </div>
  <div id="body">
    <div id="hint"></div>
    <div id="list"></div>
  </div>
</div>`;

    const PANEL_CSS = `
:host { all: initial; }
#root {
  position: fixed; right: 16px; bottom: 16px;
  width: 460px; max-width: 90vw; max-height: 70vh;
  background: #1f1f1f; color: #f0f0f0;
  border: 1px solid #333; border-radius: 8px;
  font: 12px/1.4 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: 0 6px 24px rgba(0,0,0,0.4);
  z-index: 2147483646; display: flex; flex-direction: column;
  transition: background 0.3s;
}
#root.flash { background: #1a3b1f; }
#bar {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 10px; border-bottom: 1px solid #333;
  cursor: move; user-select: none;
}
#title { font-weight: bold; color: #00a1d6; }
#counter { color: #aaa; font-size: 11px; flex: 1; }
button {
  background: #2c2c2c; color: #f0f0f0;
  border: 1px solid #444; border-radius: 4px;
  padding: 3px 8px; font-size: 11px; cursor: pointer;
}
button:hover { background: #3a3a3a; border-color: #00a1d6; }
button:active { background: #00a1d6; color: #fff; }
#btn-toggle { padding: 0 8px; }
#body { overflow-y: auto; padding: 8px 10px; }
#hint { color: #888; font-size: 11px; margin-bottom: 6px; }
#list .ep {
  border: 1px solid #2a2a2a; border-radius: 4px;
  padding: 6px 8px; margin-bottom: 6px;
  background: #181818;
}
#list .ep.ready { border-color: #2a6f3f; }
#list .ep.partial { border-color: #6f6a2a; }
#list .ep .ep-head { display: flex; align-items: center; gap: 6px; }
#list .ep .ep-title { flex: 1; }
#list .ep .ep-status { font-size: 11px; }
#list .ep.ready .ep-status { color: #4caf50; }
#list .ep.partial .ep-status { color: #ffd54f; }
#list .ep .ep-meta { color: #888; font-size: 11px; margin-top: 3px; word-break: break-all; }
#list .ep .ep-meta .kid { font-family: SFMono-Regular, Consolas, monospace; color: #ccc; }
#list .ep .ep-meta .key { font-family: SFMono-Regular, Consolas, monospace; color: #4caf50; }
#list .ep .ep-actions { margin-top: 5px; display: flex; gap: 4px; flex-wrap: wrap; }
.collapsed #body { display: none; }
.copied { background: #00a1d6 !important; color: #fff !important; }
`;

    function buildPanel() {
        if (ui.root) return;
        if (!document.body) {
            // document-start, DOM 还没 ready
            window.addEventListener('DOMContentLoaded', buildPanel, { once: true });
            return;
        }
        const host = document.createElement('div');
        host.id = 'bilidrm-helper-host';
        host.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;z-index:2147483646;';
        const sr = host.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent = PANEL_CSS;
        sr.appendChild(style);
        const wrap = document.createElement('div');
        wrap.innerHTML = PANEL_HTML;
        sr.appendChild(wrap);
        document.body.appendChild(host);

        const root = sr.getElementById('root');
        ui.root = root;
        ui.headerEl = sr.getElementById('counter');
        ui.listEl = sr.getElementById('list');
        ui.hintEl = sr.getElementById('hint');

        // 折叠
        sr.getElementById('btn-toggle').addEventListener('click', () => {
            root.classList.toggle('collapsed');
        });

        // 拖拽
        const bar = sr.getElementById('bar');
        let dragging = false, sx, sy, ox, oy;
        bar.addEventListener('mousedown', (e) => {
            dragging = true;
            const r = root.getBoundingClientRect();
            sx = e.clientX; sy = e.clientY; ox = r.right; oy = r.bottom;
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            const newRight = Math.max(0, ox - (e.clientX - sx) - dx + dx);
            // 简化: 直接根据当前 mouse 位置估算 right/bottom
            root.style.right = Math.max(0, window.innerWidth - e.clientX - 50) + 'px';
            root.style.bottom = Math.max(0, window.innerHeight - e.clientY - 10) + 'px';
        });
        document.addEventListener('mouseup', () => { dragging = false; });

        // 按钮
        sr.getElementById('btn-prefetch').addEventListener('click', async (ev) => {
            const b = ev.target;
            b.disabled = true; const orig = b.textContent; b.textContent = '拉取中…';
            try { await prefetchAllPlayurls(); }
            finally { b.disabled = false; b.textContent = orig; }
        });
        sr.getElementById('btn-copy-all').addEventListener('click', () => {
            copyAllReadyCommands();
        });
        sr.getElementById('btn-diag').addEventListener('click', () => {
            exportDiag();
        });

        renderPanel();
    }

    function renderPanel(flash) {
        if (!ui.root) { buildPanel(); return; }
        const ssId = ui.currentSsId || Object.keys(store.seasons)[0];
        const season = ssId ? store.seasons[ssId] : null;

        // 计数
        let total = 0, ready = 0, partial = 0;
        if (season) {
            const eps = Object.values(season.episodes);
            total = eps.length;
            for (const ep of eps) {
                const status = epStatus(ep);
                if (status === 'ready') ready++;
                else if (status === 'partial') partial++;
            }
        }
        const titleStr = season ? (season.title || `(ssId ${ssId})`) : '(尚未捕获 season)';
        ui.headerEl.textContent = `${titleStr} · 就绪 ${ready}/${total}` + (partial ? ` (部分 ${partial})` : '');

        // 提示
        ui.hintEl.textContent = total === 0
            ? '提示: 进入课堂播放页后, 此面板会自动捕获 KID 与 key. 点击 [批量拉KID] 一次性扫描整课的 KID, 然后挨个播放每集触发 ClearKey license 即可补全 key.'
            : (ready === total ? '✅ 全部就绪' : '播放每一集几秒钟以触发 EME license, 即可让该集状态变为🟢 就绪.');

        // 列表
        ui.listEl.innerHTML = '';
        if (season) {
            const eps = Object.values(season.episodes).sort((a, b) => (a.index || 0) - (b.index || 0));
            for (const ep of eps) {
                ui.listEl.appendChild(renderEpisode(ep, ssId));
            }
        }

        if (flash) {
            ui.root.classList.add('flash');
            setTimeout(() => ui.root.classList.remove('flash'), 400);
        }
    }

    function epStatus(ep) {
        if (ep.noDrm) return 'nodrm';
        if (!ep.streams.length) return 'unknown';
        const need = new Set(ep.streams.map(s => s.kid));
        let have = 0;
        for (const k of need) if (ep.keys[k] || store.keys[k]) have++;
        if (have === need.size) return 'ready';
        if (have > 0 || ep.seenLicense) return 'partial';
        return 'pending';
    }

    function renderEpisode(ep, ssId) {
        const div = document.createElement('div');
        const status = epStatus(ep);
        div.className = 'ep ' + (status === 'ready' ? 'ready' : status === 'partial' ? 'partial' : '');
        const indexLabel = ep.index ? `P${String(ep.index).padStart(2, '0')}` : '';
        const statusEmoji = status === 'ready' ? '🟢 就绪'
            : status === 'partial' ? '🟡 部分'
            : status === 'nodrm' ? '🔵 无DRM (BBDown 直下)'
            : status === 'pending' ? '⚪ 待播放'
            : '⚪ 未拉取KID';

        const head = document.createElement('div'); head.className = 'ep-head';
        const tt = document.createElement('div'); tt.className = 'ep-title';
        tt.textContent = `${indexLabel} ${ep.title || '(无标题)'} · ep${ep.epId}`;
        const st = document.createElement('div'); st.className = 'ep-status'; st.textContent = statusEmoji;
        head.appendChild(tt); head.appendChild(st);

        const meta = document.createElement('div'); meta.className = 'ep-meta';
        if (ep.streams.length === 0) {
            if (ep.noDrm) {
                meta.textContent = `此集流未启用 DRM (drm_type 为空, 无 widevine_pssh). 直接 BBDown -c '<cookie>' '<url>' 即可下载, 不需要 --key.`;
            } else if (ep.respCode != null && ep.respCode !== 0) {
                meta.textContent = `playurl 返回错误: code=${ep.respCode} msg=${ep.respMsg || ''}. 通常是未购买/未登录/地区限制.`;
            } else if (ep.respCode === 0 && ep.hasDash) {
                meta.textContent = `已拿到 dash 但未发现 bilidrm_uri. drm_type=${ep.drmTypeRaw || '∅'}, widevine_pssh=${ep.hasWidevinePssh ? '有' : '无'}. 检查 console 详细概要, 可能此账号/清晰度走的是非加密流.`;
            } else {
                meta.textContent = '无 KID. 播放此集或点 [批量拉KID].';
            }
        } else {
            const lines = [];
            // 按 kind+kid 去重
            const uniq = {};
            for (const s of ep.streams) uniq[s.kind + ':' + s.kid] = s;
            for (const s of Object.values(uniq)) {
                const key = ep.keys[s.kid] || store.keys[s.kid] || '';
                lines.push(`<span>${s.kind === 'video' ? '🎬' : '🔊'} <span class="kid">${s.kid}</span>${key ? ' : <span class="key">' + key + '</span>' : ' : <span style="color:#888">[待播放]</span>'}</span>`);
            }
            meta.innerHTML = lines.join('<br>');
        }

        const acts = document.createElement('div'); acts.className = 'ep-actions';
        acts.appendChild(makeBtn('📋 kid:key', () => copyKidKeys(ep)));
        acts.appendChild(makeBtn('📋 BBDown', () => copyBBDownCmd(ssId, ep)));
        acts.appendChild(makeBtn('📋 JSON', () => copyJson(ssId, ep)));
        // 试取 Key: 即使没播放也能从服务端取 ClearKey (走 SDK)
        const fetchBtn = makeBtnAsync('🔑 试取Key', async (b) => {
            try {
                if (ep.streams.length === 0) {
                    // 还没拉到 KID, 先发一次 no-drm_tech_type playurl
                    await tryPlayurlForEp(ep);
                }
                const kids = Array.from(new Set(ep.streams.map(s => s.kid)));
                if (kids.length === 0) { LogError('无 KID, 先点 [批量拉KID]'); return false; }
                let got = 0;
                for (const kid of kids) {
                    if (ep.keys[kid] || store.keys[kid]) { got++; continue; }
                    b.textContent = `🔑 拉取 ${got + 1}/${kids.length}…`;
                    log(`▶ extractClearKey kid=${kid}`);
                    const r = await extractClearKey(kid);
                    log(`✓ ClearKey  kid=${r.kid}  key=${r.key}  iv=${r.iv}`);
                    store.keys[kid] = r.key;
                    ep.keys[kid] = r.key;
                    got++;
                }
                saveStore();
                renderPanel(true);
                return true;
            } catch (e) {
                LogError('试取 Key 失败: ' + (e?.message || e));
                console.error(e);
                return false;
            }
        });
        acts.appendChild(fetchBtn);
        const playBtn = makeBtn('▶ 跳转播放', () => {
            location.href = `https://www.bilibili.com/cheese/play/ep${ep.epId}`;
        });
        acts.appendChild(playBtn);

        div.appendChild(head);
        div.appendChild(meta);
        div.appendChild(acts);
        return div;
    }

    function makeBtn(label, onClick) {
        const b = document.createElement('button');
        b.textContent = label;
        b.addEventListener('click', () => {
            const r = onClick();
            if (r !== false) {
                b.classList.add('copied');
                const orig = b.textContent; b.textContent = '✓ 已复制';
                setTimeout(() => { b.classList.remove('copied'); b.textContent = orig; }, 1200);
            }
        });
        return b;
    }

    function makeBtnAsync(label, onClick) {
        const b = document.createElement('button');
        b.textContent = label;
        b.addEventListener('click', async () => {
            if (b.disabled) return;
            const orig = b.textContent;
            b.disabled = true;
            try {
                const r = await onClick(b);
                b.textContent = (r !== false) ? '✓ 完成' : '✗ 失败';
            } catch (e) {
                b.textContent = '✗ 失败';
            }
            setTimeout(() => { b.textContent = orig; b.disabled = false; }, 1500);
        });
        return b;
    }

    const LogError = (m) => { warn(m); };

    function copyToClipboard(text) {
        try {
            if (typeof GM_setClipboard !== 'undefined') { GM_setClipboard(text, 'text'); return true; }
        } catch (e) {}
        try { navigator.clipboard.writeText(text); return true; } catch (e) {}
        // fallback: textarea
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;top:-1000px;';
            document.body.appendChild(ta); ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            return true;
        } catch (e) { warn('clipboard fail:', e); return false; }
    }

    function epToKidKeyPairs(ep) {
        const pairs = [];
        const seen = new Set();
        for (const s of ep.streams) {
            if (seen.has(s.kid)) continue;
            seen.add(s.kid);
            const key = ep.keys[s.kid] || store.keys[s.kid];
            if (key) pairs.push({ kid: s.kid, key });
        }
        return pairs;
    }

    function copyKidKeys(ep) {
        const pairs = epToKidKeyPairs(ep);
        if (!pairs.length) {
            warn(`ep${ep.epId} 尚无完整 kid:key, 请先播放此集`);
            return false;
        }
        const text = pairs.map(p => `${p.kid}:${p.key}`).join('\n');
        return copyToClipboard(text);
    }

    function buildBBDownCmd(ep) {
        const pairs = epToKidKeyPairs(ep);
        if (!pairs.length) return null;
        const sd = getSessdata();
        const cookieArg = sd ? ` -c 'SESSDATA=${sd}'` : '';
        const keyArgs = pairs.map(p => `--key ${p.kid}:${p.key}`).join(' ');
        const url = `https://www.bilibili.com/cheese/play/ep${ep.epId}`;
        return `BBDown '${url}'${cookieArg} ${keyArgs}`;
    }

    function copyBBDownCmd(ssId, ep) {
        const cmd = buildBBDownCmd(ep);
        if (!cmd) {
            warn(`ep${ep.epId} 尚无完整 kid:key, 请先播放此集`);
            return false;
        }
        return copyToClipboard(cmd);
    }

    function copyJson(ssId, ep) {
        const obj = {
            ssId, epId: ep.epId, aid: ep.aid, cid: ep.cid, title: ep.title,
            streams: ep.streams.map(s => ({
                kind: s.kind, codecs: s.codecs, bandwidth: s.bandwidth,
                kid: s.kid, key: ep.keys[s.kid] || store.keys[s.kid] || null
            }))
        };
        return copyToClipboard(JSON.stringify(obj, null, 2));
    }

    // 当场发数个 playurl 变体, 看是否有任何一条返回**非空** bilidrm_uri 或服务端会暗示 ClearKey 路径
    async function probeClearKeyPlayurl() {
        // 选 ep 优先级: ① URL 上的 ep ② lastPlayurlUrl 的 ep_id ③ store 里第一个 aid/cid 都齐的 ep
        let epId = '', aid = '', cid = '';
        const m1 = location.pathname.match(/\/cheese\/play\/ep(\d+)/);
        if (m1) epId = m1[1];
        if (!epId && _diag.lastPlayurlUrl) {
            const m2 = _diag.lastPlayurlUrl.match(/[?&]ep_id=(\d+)/);
            if (m2) epId = m2[1];
        }
        // 从 store 反查 aid/cid; 或在 store 里找第一个完整的 ep
        if (epId) {
            for (const sid of Object.keys(store.seasons)) {
                const ep = store.seasons[sid].episodes[epId];
                if (ep && ep.aid && ep.cid) { aid = ep.aid; cid = ep.cid; break; }
            }
        }
        if (!aid || !cid) {
            for (const sid of Object.keys(store.seasons)) {
                const eps = store.seasons[sid].episodes;
                for (const id of Object.keys(eps)) {
                    if (eps[id].aid && eps[id].cid) {
                        epId = id; aid = eps[id].aid; cid = eps[id].cid;
                        break;
                    }
                }
                if (aid) break;
            }
        }
        if (!epId || !aid || !cid) return { error: 'store 里没有任何 aid/cid 完整的 ep; 先点 [批量拉KID] 等 season 解析完成再来。当前 page=' + location.pathname };

        const session = (Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)).slice(0, 32);
        const sssId = ui.currentSsId || '';
        const variants = [
            // ① 完全模仿浏览器但去掉 drm_tech_type
            {
                tag: 'web-no-drm_tech_type',
                url: `https://api.bilibili.com/pugv/player/web/playurl?avid=${aid}&cid=${cid}&qn=0&fnver=0&fnval=16&fourk=1&gaia_source=&from_client=BROWSER&is_main_page=true&need_fragment=false&season_id=${sssId}&isGaiaAvoided=false&client_attr=0&version_name=4.9.73&app_id=100&ep_id=${epId}&session=${session}&voice_balance=1`
            },
            // ② drm_tech_type=3 (ClearKey 标识, 看服务端会不会主动给 ClearKey 路径)
            {
                tag: 'web-drm_tech_type=3',
                url: `https://api.bilibili.com/pugv/player/web/playurl?avid=${aid}&cid=${cid}&qn=0&fnver=0&fnval=16&fourk=1&gaia_source=&from_client=BROWSER&is_main_page=true&need_fragment=false&season_id=${sssId}&isGaiaAvoided=false&client_attr=0&version_name=4.9.73&app_id=100&ep_id=${epId}&session=${session}&voice_balance=1&drm_tech_type=3`
            },
            // ③ fnval=4048 (BBDown 用的值, 笔记里也是这个) + module=bangumi
            {
                tag: 'fnval4048-bangumi',
                url: `https://api.bilibili.com/pugv/player/web/playurl?support_multi_audio=true&from_client=BROWSER&avid=${aid}&cid=${cid}&fnval=4048&fnver=0&fourk=1&otype=json&qn=0&module=bangumi&ep_id=${epId}&session=`
            },
            // ④ 旧端点 v2
            {
                tag: 'v2-no-drm_tech_type',
                url: `https://api.bilibili.com/pugv/player/web/v2/playurl?support_multi_audio=true&from_client=BROWSER&avid=${aid}&cid=${cid}&fnval=4048&fnver=0&fourk=1&otype=json&qn=0&module=bangumi&ep_id=${epId}&session=`
            },
        ];
        const referer = `https://www.bilibili.com/cheese/play/ep${epId}`;
        const results = [];
        for (const v of variants) {
            try {
                const r = await fetch(v.url, {
                    credentials: 'include',
                    headers: { 'Accept': 'application/json, text/plain, */*' },
                    referrer: referer,
                    referrerPolicy: 'strict-origin-when-cross-origin',
                });
                const t = await r.text();
                let json = null;
                try { json = JSON.parse(t); } catch (e) {}
                let bilidrmUriValues = [];
                let drmType = null;
                let widevinePsshPresent = false;
                let videoCount = 0;
                if (json) {
                    drmType = deepFindKey(json, 'drm_type');
                    widevinePsshPresent = !!deepFindKey(json, 'widevine_pssh');
                    // 收集所有 bilidrm_uri 值
                    (function walk(n) {
                        if (!n || typeof n !== 'object') return;
                        if (Array.isArray(n)) { n.forEach(walk); return; }
                        if (typeof n.bilidrm_uri === 'string') bilidrmUriValues.push(n.bilidrm_uri);
                        for (const k of Object.keys(n)) walk(n[k]);
                    })(json);
                    const dash = json?.data?.dash || json?.result?.dash || json?.result?.video_info?.dash || json?.data?.video_info?.dash;
                    if (dash?.video) videoCount = dash.video.length;
                }
                results.push({
                    tag: v.tag,
                    status: r.status,
                    code: json?.code,
                    message: json?.message || json?.msg,
                    drmType,
                    widevinePsshPresent,
                    videoCount,
                    bilidrmUriValues: bilidrmUriValues,
                    bilidrmUriHasNonEmpty: bilidrmUriValues.some(s => s.length > 0),
                    sampleUri: bilidrmUriValues.find(s => s.length > 0) || null,
                    bodyHead: t.slice(0, 300)
                });
            } catch (e) {
                results.push({ tag: v.tag, error: String(e) });
            }
        }
        // 额外探针: 笔记 §5/§8 中的关键端点是否还活着
        const aux = {};
        try {
            const r = await fetch('https://bvc-drm.bilivideo.com/cer/bilidrm_pub.key', { credentials: 'omit' });
            const buf = await r.arrayBuffer();
            const u = new Uint8Array(buf);
            aux.bilidrm_pub_key = {
                status: r.status,
                contentLength: u.length,
                head32: bytesToHex(u, 0, Math.min(32, u.length)),
                isPem: u.length >= 10 && (u[0] === 0x2d /* '-' */),
                isDer: u.length >= 5 && u[0] === 0x30 /* SEQUENCE */
            };
        } catch (e) { aux.bilidrm_pub_key = { error: String(e) }; }
        try {
            const r = await fetch('https://bvc-drm.bilivideo.com/cer/bilibili_certificate.bin', { credentials: 'omit' });
            const buf = await r.arrayBuffer();
            const u = new Uint8Array(buf);
            aux.bilibili_certificate_bin = {
                status: r.status, contentLength: u.length,
                head32: bytesToHex(u, 0, Math.min(32, u.length))
            };
        } catch (e) { aux.bilibili_certificate_bin = { error: String(e) }; }
        // 试探 npd.drm_sdk.js (新版 hash 未知, 试几种常见命名)
        const sdkUrls = [
            'https://s1.hdslb.com/bfs/static/player/main/widgets/npd.drm_sdk.7d8e1e5f.js',
            'https://s1.hdslb.com/bfs/static/edu-play/widgets/npd.drm_sdk.js',
            'https://s1.hdslb.com/bfs/static/edu-play/client/assets/npd.drm_sdk.js',
        ];
        aux.sdkProbe = [];
        for (const u of sdkUrls) {
            try {
                const r = await fetch(u, { credentials: 'omit' });
                aux.sdkProbe.push({ url: u, status: r.status, contentLength: r.headers.get('content-length') || '?' });
            } catch (e) { aux.sdkProbe.push({ url: u, error: String(e) }); }
        }
        // POST /bilidrm 探活: 用空 body 看回什么错
        try {
            const r = await fetch('https://bvc-drm.bilivideo.com/bilidrm', {
                method: 'POST', credentials: 'include', body: new ArrayBuffer(0),
                headers: { 'Content-Type': 'application/octet-stream' },
            });
            const t = await r.text();
            aux.bilidrm_post_probe = { status: r.status, bodyHead: t.slice(0, 300) };
        } catch (e) { aux.bilidrm_post_probe = { error: String(e) }; }

        return { probedEpId: epId, probedAid: aid, probedCid: cid, variants: results, aux };
    }

    async function exportDiag() {
        const out = {
            url: location.href,
            ssId: ui.currentSsId,
            captured: {
                playurlUrl: _diag.lastPlayurlUrl,
                playurlJsonPresent: !!_diag.lastPlayurlJson,
                emeGenerateRequestCount: _diag.sessionInitData.length,
                emeUpdateCount: _diag.emeMessages.length,
                emeInitDataPreviews: _diag.sessionInitData,
                emeUpdatePreviews: _diag.emeMessages,
            },
            playurlSketch: _diag.lastPlayurlJson ? sketchPlayurlResp(_diag.lastPlayurlJson) : null,
            playurlRaw: _diag.lastPlayurlJson,
        };
        // 顺手 fetch 一段 init segment 看 mp4 box, 找最近的 video segment URL
        try {
            const dash = _diag.lastPlayurlJson?.data?.dash || _diag.lastPlayurlJson?.result?.dash
                || _diag.lastPlayurlJson?.result?.video_info?.dash || _diag.lastPlayurlJson?.data?.video_info?.dash;
            const v0 = dash?.video?.[0];
            const baseUrl = v0?.base_url || v0?.baseUrl;
            if (baseUrl) {
                const r = await fetch(baseUrl, { credentials: 'include', headers: { 'Range': 'bytes=0-65535', 'Referer': location.origin + '/' } });
                if (r.ok) {
                    const buf = await r.arrayBuffer();
                    out.firstSegmentProbe = bytesPreview(buf, 64);
                    out.firstSegmentProbe.url = baseUrl;
                    out.firstSegmentProbe.status = r.status;
                } else {
                    out.firstSegmentProbe = { error: `HTTP ${r.status}`, url: baseUrl };
                }
            } else {
                out.firstSegmentProbe = { error: 'no base_url in playurl response' };
            }
        } catch (e) { out.firstSegmentProbe = { error: String(e) }; }

        // 关键探针: 当场发一次「无 drm_tech_type=2」的 playurl, 看 bilidrm_uri 是否非空
        // 也尝试 v2 端点和不同 fnval, 列出每条结果
        out.clearKeyPathProbe = await probeClearKeyPlayurl();

        const txt = JSON.stringify(out, null, 2);
        console.log('===== BBDown DRM Helper 诊断报告 =====');
        console.log(txt);
        console.log('===== 报告结束 =====');
        copyToClipboard(txt);
        try { if (typeof GM_notification !== 'undefined') GM_notification({ title: 'BBDown DRM Helper', text: '诊断报告已复制到剪贴板 (含 playurl 响应 + EME 概要 + 分片探针)', timeout: 3000 }); } catch (e) {}
    }

    function copyAllReadyCommands() {
        const ssId = ui.currentSsId || Object.keys(store.seasons)[0];
        if (!ssId) return false;
        const eps = Object.values(store.seasons[ssId].episodes).sort((a, b) => (a.index || 0) - (b.index || 0));
        const cmds = [];
        for (const ep of eps) {
            if (epStatus(ep) === 'ready') {
                const c = buildBBDownCmd(ep);
                if (c) cmds.push(c);
            }
        }
        if (!cmds.length) {
            warn('尚无任何已就绪的 ep, 请播放每集触发 ClearKey license');
            return false;
        }
        const txt = '#!/bin/bash\nset -e\n\n' + cmds.join('\n\n') + '\n';
        return copyToClipboard(txt);
    }

    // ------------------------------------------------------------------
    // 5.5. npd.drm_sdk.js (FairPlay SPC/CKC) 加载与调用
    //  - SDK 是 webpack chunk + Emscripten WASM
    //  - 通过 nanoWidgetsJsonp.push 钩子捕获 chunk function
    //  - 调用工厂函数得到 instance, 等 ready Promise 后用 biliDRMGenSPC/biliDRMParseCKC
    // ------------------------------------------------------------------
    const SDK_URL = 'https://s1.hdslb.com/bfs/static/player/main/widgets/npd.drm_sdk.7d8e1e5f.js';
    const SDK_CHUNK_ID = 565;
    const SDK_MODULE_ID = 36861;
    const BILIDRM_PUB_KEY_URL = 'https://bvc-drm.bilivideo.com/cer/bilidrm_pub.key';
    const BILIDRM_POST_URL = 'https://bvc-drm.bilivideo.com/bilidrm';

    let _sdkPromise = null;
    function loadSdk() {
        if (_sdkPromise) return _sdkPromise;
        _sdkPromise = (async () => {
            // 1) 在 page world 安装 JSONP 钩子, 捕获 chunk
            // 用 unsafeWindow 拿到 page 真实 window
            const pw = win;
            pw.nanoWidgetsJsonp = pw.nanoWidgetsJsonp || [];
            const origPush = pw.nanoWidgetsJsonp.push.bind(pw.nanoWidgetsJsonp);
            let captured = null;
            pw.nanoWidgetsJsonp.push = function (chunk) {
                try {
                    if (chunk && Array.isArray(chunk[0]) && chunk[0].includes(SDK_CHUNK_ID) && chunk[1] && chunk[1][SDK_MODULE_ID]) {
                        captured = chunk[1][SDK_MODULE_ID];
                    }
                } catch (e) {}
                return origPush(chunk);
            };
            // 2) 注入 <script> 加载 SDK
            await new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = SDK_URL;
                s.crossOrigin = 'anonymous';
                s.onload = resolve;
                s.onerror = (e) => reject(new Error('failed to load drm sdk: ' + e?.message));
                document.head.appendChild(s);
                setTimeout(() => reject(new Error('drm sdk load timeout')), 20000);
            });
            if (!captured) throw new Error('drm sdk loaded but chunk not captured');

            // 3) 手动驱动 webpack module: chunkFn(module, exports, __webpack_require__)
            // SDK 头部用了 I.nmd(A), 我们 stub nmd 即可
            const moduleObj = { exports: {} };
            const stubRequire = function (id) { return {}; };
            stubRequire.nmd = function (m) { return m; };
            captured(moduleObj, moduleObj.exports, stubRequire);
            const factory = moduleObj.exports;
            if (typeof factory !== 'function') throw new Error('drm sdk export is not a factory');

            // 4) 调用工厂: factory(cfgObj) 返回 ready Promise, 但会 mutate cfgObj 把 exports 挂上去
            //    biliDRMGenSPC / biliDRMParseCKC 是 JS wrapper, 在 ready 后才能调用
            //    (因为它们内部访问 cfgObj._biliDRMGenSPC, 即 WASM 导出, 只在 instantiate 后存在)
            const instance = {};
            const ready = factory(instance);
            await ready;
            if (typeof instance.biliDRMGenSPC !== 'function' || typeof instance.biliDRMParseCKC !== 'function') {
                throw new Error('drm sdk ready resolved but instance missing biliDRMGenSPC/biliDRMParseCKC. Got keys: ' + Object.keys(instance).join(','));
            }
            log('npd.drm_sdk loaded ✓ (biliDRMGenSPC/biliDRMParseCKC available)');
            return instance;
        })();
        _sdkPromise.catch(() => { _sdkPromise = null; });
        return _sdkPromise;
    }

    // GM_xmlhttpRequest 包装为 Promise, 用于绕开 CORS POST /bilidrm
    function gmFetch(opts) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'undefined') return reject(new Error('GM_xmlhttpRequest not granted'));
            GM_xmlhttpRequest({
                ...opts,
                onload: r => resolve(r),
                onerror: e => reject(new Error('gm xhr error: ' + JSON.stringify(e))),
                ontimeout: () => reject(new Error('gm xhr timeout')),
            });
        });
    }

    // 16-byte ASCII 随机会话 key (charcode 1..127, 避免 0)
    function genAesSessionKey() {
        let s = '';
        for (let i = 0; i < 16; i++) {
            s += String.fromCharCode(1 + Math.floor(Math.random() * 126));
        }
        return s;
    }

    // base64 (标准) -> hex
    function b64StdToHex(s) {
        try {
            const raw = atob(s);
            let h = '';
            for (let i = 0; i < raw.length; i++) h += raw.charCodeAt(i).toString(16).padStart(2, '0');
            return h;
        } catch (e) { return ''; }
    }

    let _certCache = null;
    async function fetchBilidrmPubKey() {
        if (_certCache) return _certCache;
        const r = await gmFetch({
            method: 'GET',
            url: BILIDRM_PUB_KEY_URL,
            responseType: 'arraybuffer',
        });
        if (r.status !== 200) throw new Error('bilidrm_pub.key fetch HTTP ' + r.status);
        _certCache = r.response;
        return _certCache;
    }

    // 端到端: kid_hex -> {kid, key, iv} (hex)
    async function extractClearKey(kidHex) {
        if (!/^[0-9a-f]{32}$/i.test(kidHex)) throw new Error('invalid kid hex: ' + kidHex);
        const sdk = await loadSdk();
        const cert = await fetchBilidrmPubKey();
        const aesKey = genAesSessionKey();
        // 1) 生成 SPC
        const gen = sdk.biliDRMGenSPC(kidHex, aesKey, cert);
        if (gen.osStatus !== 0 || !gen.spc) {
            throw new Error('biliDRMGenSPC failed osStatus=' + gen.osStatus);
        }
        // 2) POST /bilidrm: 服务端要 JSON. 试几种字段命名, 直到拿到 200
        // 字段候选: spc / SPC / data / spc_data; 也尝试 {kid, spc}
        const candidatePayloads = [
            { spc: gen.spc },
            { spc: gen.spc, kid: kidHex },
            { data: gen.spc },
            { data: gen.spc, kid: kidHex },
            { SPC: gen.spc },
            { spc: gen.spc, kid_id: kidHex },
            { spc_data: gen.spc, kid: kidHex },
        ];
        let post = null;
        let postBodyHead = '';
        let lastErr = '';
        for (const payload of candidatePayloads) {
            const body = JSON.stringify(payload);
            const r = await gmFetch({
                method: 'POST',
                url: BILIDRM_POST_URL,
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': 'https://www.bilibili.com',
                    'Referer': 'https://www.bilibili.com/',
                    'Accept': 'application/json, text/plain, */*',
                },
                data: body,
                responseType: 'arraybuffer',
                anonymous: false,
            });
            const buf = r.response;
            const u = new Uint8Array(buf);
            const head = String.fromCharCode(...u.slice(0, Math.min(160, u.length)));
            const isJsonHead = head.trimStart().startsWith('{');
            if (r.status === 200 && !isJsonHead && u.length > 32) {
                // 直接二进制 CKC
                post = { kind: 'raw', buf, payloadShape: Object.keys(payload).join('+') };
                log(`POST /bilidrm OK (raw ckc ${u.length}B, payload=${post.payloadShape})`);
                break;
            }
            if (r.status === 200 && isJsonHead) {
                // JSON 响应; 可能是错误, 也可能是 {ckc: base64, status: 0} 这种成功结构
                let j = null;
                try { j = JSON.parse(head + (head.length < u.length ? new TextDecoder().decode(u.slice(head.length)) : '')); } catch (e) {}
                // 再用完整 buffer 解一次以防 head 截断后 JSON 不完整
                try { j = JSON.parse(new TextDecoder().decode(u)); } catch (e) {}
                if (j) {
                    // 尝试找 CKC 字段
                    const ckcFieldCandidates = ['ckc', 'CKC', 'data', 'response', 'license'];
                    let ckcB64 = null;
                    for (const f of ckcFieldCandidates) {
                        if (typeof j[f] === 'string' && j[f].length > 32) { ckcB64 = j[f]; break; }
                        if (j.data && typeof j.data === 'object' && typeof j.data[f] === 'string' && j.data[f].length > 32) { ckcB64 = j.data[f]; break; }
                    }
                    if (ckcB64 && (j.code === 0 || j.code === undefined || j.status === 0 || j.status === undefined)) {
                        // 视为成功; base64 解出 CKC
                        const ckcBytes = Uint8Array.from(atob(ckcB64), c => c.charCodeAt(0));
                        post = { kind: 'json', buf: ckcBytes.buffer, payloadShape: Object.keys(payload).join('+'), respJson: j };
                        log(`POST /bilidrm OK (json wrapper, ckc ${ckcBytes.length}B, payload=${post.payloadShape})`);
                        break;
                    }
                    lastErr = `200 错误 JSON (payload=${Object.keys(payload).join('+')}): ${head.slice(0, 200)}`;
                } else {
                    lastErr = `200 但响应非 JSON (payload=${Object.keys(payload).join('+')}): ${head.slice(0, 200)}`;
                }
            } else if (r.status !== 200) {
                lastErr = `HTTP ${r.status} (payload=${Object.keys(payload).join('+')}): ${head.slice(0, 200)}`;
            }
        }
        if (!post) throw new Error('POST /bilidrm 全部 payload 失败. 最后一次: ' + lastErr);
        const ckcBuf = post.buf;
        // 3) 解析 CKC
        const parsed = sdk.biliDRMParseCKC(ckcBuf, aesKey);
        if (parsed.osStatus !== 0 || !parsed.key) {
            throw new Error('biliDRMParseCKC failed osStatus=' + parsed.osStatus);
        }
        const keyHex = b64StdToHex(parsed.key);
        const ivHex = parsed.iv ? b64StdToHex(parsed.iv) : '';
        if (!/^[0-9a-f]{32}$/i.test(keyHex)) {
            throw new Error('parsed key is not 16 bytes hex: ' + parsed.key);
        }
        return { kid: kidHex.toLowerCase(), key: keyHex.toLowerCase(), iv: ivHex.toLowerCase(), ckcLength: ckcBuf.byteLength };
    }

    // ------------------------------------------------------------------
    // 6. 引导
    // ------------------------------------------------------------------
    function init() {
        buildPanel();
        // 自动尝试拉一次当前 page 的 season(只在首次)
        const { kind, id } = parseUrlIds();
        if (id) {
            const url = `https://api.bilibili.com/pugv/view/web/season?` + (kind === 'ss' ? `season_id=${id}` : `ep_id=${id}`);
            fetch(url, { credentials: 'include' })
                .then(r => r.text())
                .then(t => ingestApiResponse(url, t))
                .catch(e => warn('init season fetch:', e));
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }

    // 菜单命令
    try {
        if (typeof GM_registerMenuCommand !== 'undefined') {
            GM_registerMenuCommand('显示/隐藏 DRM 面板', () => {
                if (!ui.root) buildPanel();
                else ui.root.classList.toggle('collapsed');
            });
            GM_registerMenuCommand('批量拉取整课 KID', () => prefetchAllPlayurls());
            GM_registerMenuCommand('清空所有已捕获数据', () => {
                if (!confirm('确认清空所有已捕获的 kid/key 数据?')) return;
                store.seasons = {}; store.keys = {};
                saveStore(); renderPanel();
            });
        }
    } catch (e) {}

    log('脚本就绪');
})();
