/**
 * merge.youtube.response.js
 *
 * 单一响应入口：
 * 1. 先执行 Maasea YouTube 去广告/PIP/后台播放响应脚本
 * 2. 再执行 DualSubs YouTube 字幕响应脚本
 */

const SCRIPTS = [
  {
    name: "Maasea.YouTube.Ads.PiP.Background",
    url: "https://raw.githubusercontent.com/Maasea/sgmodule/refs/heads/master/Script/Youtube/youtube.response.js",
  },
  {
    name: "DualSubs.YouTube.Response",
    url: "https://github.com/DualSubs/YouTube/releases/latest/download/response.bundle.js",
  },
];

const TIMEOUT_MS = 12000;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    $httpClient.get({ url, timeout: TIMEOUT_MS }, (error, response, data) => {
      if (error) reject(error);
      else if (!data) reject(new Error("empty script: " + url));
      else resolve(data);
    });
  });
}

function runRemoteScript(code, name, request, response) {
  return new Promise((resolve) => {
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        console.log(`[MergeYouTube] ${name} timeout, keep previous body`);
        resolve(response);
      }
    }, TIMEOUT_MS);

    const done = (result = {}) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (typeof result === "object" && result !== null) {
        const next = Object.assign({}, response, result);
        if (typeof result.body === "undefined") next.body = response.body;
        resolve(next);
      } else {
        resolve(response);
      }
    };

    try {
      const fn = new Function(
        "$request",
        "$response",
        "$done",
        "$httpClient",
        "$prefs",
        "$notify",
        "$task",
        "$environment",
        "$loon",
        "$surge",
        "$argument",
        code
      );

      fn(
        request,
        response,
        done,
        typeof $httpClient !== "undefined" ? $httpClient : undefined,
        typeof $prefs !== "undefined" ? $prefs : undefined,
        typeof $notify !== "undefined" ? $notify : undefined,
        typeof $task !== "undefined" ? $task : undefined,
        typeof $environment !== "undefined" ? $environment : undefined,
        typeof $loon !== "undefined" ? $loon : undefined,
        typeof $surge !== "undefined" ? $surge : undefined,
        typeof $argument !== "undefined" ? $argument : undefined
      );
    } catch (e) {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        console.log(`[MergeYouTube] ${name} error: ${e && e.message ? e.message : e}`);
        resolve(response);
      }
    }
  });
}

(async () => {
  let req = $request;
  let resp = {
    status: $response.status,
    headers: $response.headers,
    body: $response.body,
  };

  try {
    for (const item of SCRIPTS) {
      const code = await httpGet(item.url);
      resp = await runRemoteScript(code, item.name, req, resp);
      console.log(`[MergeYouTube] finished: ${item.name}`);
    }
    $done(resp);
  } catch (e) {
    console.log(`[MergeYouTube] fatal: ${e && e.message ? e.message : e}`);
    $done({ body: resp.body, headers: resp.headers, status: resp.status });
  }
})();
