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

var SCRIPTS = [
  {
    name: "Maasea.YouTube.Response",
    url: "https://raw.githubusercontent.com/Maasea/sgmodule/refs/heads/master/Script/Youtube/youtube.response.js",
  },
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

function httpGet(url) {
  return new Promise(function (resolve, reject) {
    $httpClient.get({ url: url, timeout: FETCH_TIMEOUT_MS }, function (error, response, data) {
      if (error) return reject(error);
      if (!data || (response && response.status >= 400)) return reject(new Error("HTTP fail: " + url));
      resolve(data);
    });
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

(async function main() {
  var state = {
    status: $response.status,
    headers: $response.headers,
    body: $response.body,
    bodyBytes: toUint8($response.bodyBytes),
  };

  for (var i = 0; i < SCRIPTS.length; i++) {
    var script = SCRIPTS[i];
    try {
      var code = await loadScript(script.url);
      state = await runScript(code, script.name, $request, state);
      console.log("[MergeYouTube] finished: " + script.name);
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
