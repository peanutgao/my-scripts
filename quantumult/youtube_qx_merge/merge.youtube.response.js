/**
 * merge.youtube.response.js
 *
 * 合并 YouTube player / get_watch 的响应改写：
 *   1. 先跑 Maasea  -> 去广告 / PIP / 后台播放
 *   2. 再跑 DualSubs -> 双语字幕
 *
 * 关键点（之前版本失效的根因）：
 *   - 现代 YouTube 客户端的 player/get_watch 返回的是 protobuf 二进制，
 *     两个脚本都通过 $response.bodyBytes 读取二进制、通过 Content-Type 头判断格式。
 *   - 因此本合并器必须：
 *       a. 把 QX 提供的 $response.bodyBytes（以及 body / headers / status）完整带入；
 *       b. 在两个脚本之间保持 body / bodyBytes / headers 一致；
 *       c. 末尾按二进制 / 文本正确地交回 $done。
 *   - 除 $request / $response / $done 外，不遮蔽其它全局（$httpClient、$prefs、
 *     $persistentStore、$notify、$task、$script ...），让子脚本拿到真实的 QX 环境，
 *     从而正确识别 "Quantumult X" 并读取各自的 BoxJS 配置。
 *   - 两个脚本都基于 protobuf-es，默认保留 unknown fields，所以 Maasea -> DualSubs
 *     的先后顺序不会互相覆盖对方写入的字段。
 */

// 顺序很重要：必须让 DualSubs 最后执行，使其注入的字幕轨道成为最终响应、
// 不被 Maasea 二次序列化破坏（实测：DualSubs 在后会被 Maasea 重新写回 protobuf
// 时弄坏字幕轨道，导致 App 不显示字幕；而单独用 DualSubs 正常）。
// Maasea 先在原始响应上去广告/开后台，其改动位于 DualSubs schema 之外的字段，
// 会被 DualSubs 的 protobuf-es unknown-field 机制原样保留。
var SCRIPTS = [
  // ===== 诊断模式：临时只跑 DualSubs，确认 Maasea 是否在破坏字幕链路 =====
  // 若此版字幕恢复正常 -> 证明是 Maasea 干扰，再设计共存方案。
  // {
  //   name: "Maasea.YouTube.Response",
  //   url: "https://raw.githubusercontent.com/Maasea/sgmodule/refs/heads/master/Script/Youtube/youtube.response.js",
  // },
  {
    name: "DualSubs.YouTube.Response",
    url: "https://github.com/DualSubs/YouTube/releases/latest/download/response.bundle.js",
  },
];

var SCRIPT_TIMEOUT_MS = 15000; // 单个子脚本执行上限
var FETCH_TIMEOUT_MS = 12000; // 单个脚本下载上限
var CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 脚本缓存 6 小时
var CACHE_PREFIX = "merge_yt_script:";
var CACHE_TS_PREFIX = "merge_yt_script_ts:";

/* ----------------------------- 二进制工具 ----------------------------- */

function isBinary(x) {
  return x instanceof ArrayBuffer || ArrayBuffer.isView(x);
}

function toUint8(x) {
  if (x == null) return undefined;
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  return undefined;
}

/* ----------------------------- 持久化封装 ----------------------------- */

function storeRead(key) {
  try {
    if (typeof $prefs !== "undefined" && $prefs.valueForKey) return $prefs.valueForKey(key);
    if (typeof $persistentStore !== "undefined" && $persistentStore.read) return $persistentStore.read(key);
  } catch (e) {}
  return null;
}

function storeWrite(value, key) {
  try {
    if (typeof $prefs !== "undefined" && $prefs.setValueForKey) return $prefs.setValueForKey(value, key);
    if (typeof $persistentStore !== "undefined" && $persistentStore.write) return $persistentStore.write(value, key);
  } catch (e) {}
  return false;
}

/* ----------------------------- 下载（带缓存） ----------------------------- */

// 网络下载。注意：Quantumult X 没有 $httpClient（那是 Surge/Loon 的 API），
// QX 必须用 $task.fetch；这里两者都兼容，并手动跟随 3xx 重定向
// （DualSubs 的 releases/latest/download 链接是 302 跳转）。
function httpGet(url) {
  return new Promise(function (resolve, reject) {
    var hasTask = typeof $task !== "undefined" && $task && $task.fetch;
    var hasHttpClient = typeof $httpClient !== "undefined" && $httpClient && $httpClient.get;

    if (hasTask) {
      var tries = 0;
      var go = function (u) {
        tries++;
        if (tries > 6) return reject(new Error("too many redirects: " + url));
        $task.fetch({ url: u, method: "GET" }).then(
          function (resp) {
            var status = resp && (resp.statusCode != null ? resp.statusCode : resp.status);
            var headers = (resp && resp.headers) || {};
            var loc = headers.Location || headers.location;
            if (status >= 300 && status < 400 && loc) return go(loc);
            if (resp && resp.body) return resolve(resp.body);
            return reject(new Error("empty body (" + status + "): " + u));
          },
          function (err) {
            reject(err);
          }
        );
      };
      go(url);
      return;
    }

    if (hasHttpClient) {
      $httpClient.get({ url: url, timeout: FETCH_TIMEOUT_MS }, function (error, response, data) {
        if (error) return reject(error);
        if (!data || (response && response.status >= 400)) return reject(new Error("HTTP fail: " + url));
        resolve(data);
      });
      return;
    }

    reject(new Error("no network api ($task/$httpClient) available"));
  });
}

function loadScript(url) {
  var cacheKey = CACHE_PREFIX + url;
  var tsKey = CACHE_TS_PREFIX + url;

  var cached = storeRead(cacheKey);
  var ts = parseInt(storeRead(tsKey) || "0", 10);
  if (cached && Date.now() - ts < CACHE_TTL_MS) {
    return Promise.resolve(cached);
  }

  return httpGet(url)
    .then(function (code) {
      storeWrite(code, cacheKey);
      storeWrite(String(Date.now()), tsKey);
      return code;
    })
    .catch(function (err) {
      // 网络失败时回退到旧缓存（即使过期），尽量不影响功能
      if (cached) {
        console.log("[MergeYouTube] use stale cache for " + url + " (" + err + ")");
        return cached;
      }
      throw err;
    });
}

/* ----------------------------- 状态推进 ----------------------------- */

// 根据子脚本 $done 的返回值，推进 body / bodyBytes / headers / status。
function applyResult(state, result) {
  var next = {
    status: state.status,
    headers: state.headers,
    body: state.body,
    bodyBytes: state.bodyBytes,
  };

  var r = result;
  if (r && r.response && typeof r.response === "object") r = r.response;
  if (!r || typeof r !== "object") return next; // $done() / $done(空) -> 不修改

  if (typeof r.status !== "undefined") next.status = r.status;
  if (typeof r.headers !== "undefined") next.headers = r.headers;

  var hasBB = typeof r.bodyBytes !== "undefined" && r.bodyBytes !== null;
  var hasBody = typeof r.body !== "undefined" && r.body !== null;

  if (hasBB) {
    next.bodyBytes = toUint8(r.bodyBytes);
    next.body = undefined;
  } else if (hasBody) {
    if (isBinary(r.body)) {
      next.bodyBytes = toUint8(r.body);
      next.body = undefined;
    } else {
      next.body = r.body;
      next.bodyBytes = undefined;
    }
  }
  // body / bodyBytes 都没给 -> 保持原样（脚本未改动正文）
  return next;
}

/* ----------------------------- 子脚本执行 ----------------------------- */

function runScript(code, scriptName, request, state) {
  return new Promise(function (resolve) {
    var settled = false;

    // 给子脚本看到的 $response：根据当前 state 同时提供 body / bodyBytes / headers / status
    var fakeResponse = {
      status: state.status,
      headers: state.headers,
      body: state.body,
      bodyBytes: state.bodyBytes,
    };

    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      console.log("[MergeYouTube] timeout: " + scriptName);
      resolve(state); // 超时则保持当前状态
    }, SCRIPT_TIMEOUT_MS);

    function fakeDone(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(applyResult(state, result));
      } catch (e) {
        console.log("[MergeYouTube] applyResult error in " + scriptName + ": " + e);
        resolve(state);
      }
    }

    try {
      // 只遮蔽 $request / $response / $done，其余全局（$httpClient/$prefs/$task/$script...）
      // 直接落到真实的 QX 环境，保证子脚本的环境识别与配置读取正常。
      var runner = new Function("$request", "$response", "$done", code);
      runner(request, fakeResponse, fakeDone);
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.log("[MergeYouTube] error in " + scriptName + ": " + error);
      resolve(state);
    }
  });
}

/* ----------------------------- 主流程 ----------------------------- */

function sizeOf(state) {
  if (state.bodyBytes) return "bin:" + state.bodyBytes.length;
  if (typeof state.body === "string") return "txt:" + state.body.length;
  return "none";
}

(async function main() {
  var state = {
    status: $response.status,
    headers: $response.headers,
    body: $response.body,
    bodyBytes: toUint8($response.bodyBytes),
  };

  var url = ($request && $request.url) || "";
  console.log("[MergeYouTube] start url=" + url + " in=" + sizeOf(state));

  for (var i = 0; i < SCRIPTS.length; i++) {
    var script = SCRIPTS[i];
    var before = sizeOf(state);
    try {
      var code = await loadScript(script.url);
      state = await runScript(code, script.name, $request, state);
      console.log("[MergeYouTube] " + script.name + " " + before + " -> " + sizeOf(state));
    } catch (error) {
      // 单个脚本失败不影响另一个
      console.log("[MergeYouTube] skip " + script.name + ": " + error);
    }
  }

  // 交回 QX：有二进制则按二进制输出（与 Maasea 标准输出一致：body 放 Uint8Array），
  // 否则按文本输出。
  var out = { status: state.status, headers: state.headers };
  if (state.bodyBytes) {
    out.body = state.bodyBytes;
  } else {
    out.body = state.body;
  }
  $done(out);
})();
