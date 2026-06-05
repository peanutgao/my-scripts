/**
 * merge.youtube.response.js
 *
 * 只处理 YouTube player/get_watch 响应。
 * 先执行 Maasea 去广告/PIP/后台播放逻辑，再执行 DualSubs 字幕逻辑。
 */

const SCRIPTS = [
  {
    name: "Maasea.YouTube.Response",
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
      if (error) {
        reject(error);
        return;
      }
      if (!data || response.status >= 400) {
        reject(new Error("failed to load: " + url));
        return;
      }
      resolve(data);
    });
  });
}

function normalizeResponse(base, result) {
  if (!result || typeof result !== "object") return base;

  const next = {
    status: typeof result.status !== "undefined" ? result.status : base.status,
    headers: typeof result.headers !== "undefined" ? result.headers : base.headers,
    body: typeof result.body !== "undefined" ? result.body : base.body,
  };

  return next;
}

function runScript(code, scriptName, request, response) {
  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.log("[MergeYouTube] timeout: " + scriptName);
      resolve(response);
    }, TIMEOUT_MS);

    function done(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(normalizeResponse(response, result));
    }

    try {
      const runner = new Function(
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

      runner(
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
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.log("[MergeYouTube] error in " + scriptName + ": " + error);
      resolve(response);
    }
  });
}

(async function main() {
  let response = {
    status: $response.status,
    headers: $response.headers,
    body: $response.body,
  };

  try {
    for (const script of SCRIPTS) {
      const code = await httpGet(script.url);
      response = await runScript(code, script.name, $request, response);
      console.log("[MergeYouTube] finished: " + script.name);
    }

    $done(response);
  } catch (error) {
    console.log("[MergeYouTube] fatal: " + error);
    $done(response);
  }
})();
