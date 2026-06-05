YouTube 去广告/后台播放 + DualSubs 双语字幕 合并方案（Quantumult X）

【为什么需要合并】
去广告(Maasea)和字幕(DualSubs)都要改写同一个 youtubei/v1/player 响应，
QX 对同一 URL 只允许一个 script-response-body，二者直接共存会互相顶掉，
表现为：字幕生效就不能后台播放，能后台播放字幕就失效。
本方案用一个合并脚本 merge.youtube.response.js 在 player 上依次执行两者。

【本次修复的关键根因】
现代 YouTube 客户端的 player 返回的是 protobuf 二进制，两个脚本都通过
$response.bodyBytes 读二进制、通过 Content-Type 头判断格式。旧版合并脚本
只传了 body(字符串)、丢了 bodyBytes 和 headers，导致两个脚本都解析失败而静默回退。
新版 merge.youtube.response.js 已：
  - 完整带入并在两脚本之间保持 body / bodyBytes / headers / status；
  - 末尾按二进制/文本正确交回 $done；
  - 只遮蔽 $request/$response/$done，其余 QX 全局透传，保证子脚本环境识别与配置读取正常；
  - 本地缓存两个子脚本 6 小时，避免每次播放都现下载拖慢请求。
（Maasea 与 DualSubs 均基于 protobuf-es，默认保留 unknown fields，故先后执行不会互相覆盖。）

【上传/更新步骤】
1. 把这两个文件覆盖到 GitHub：
   quantumult/youtube_qx_merge/YouTubeAds_DualSubs_Merged.conf
   quantumult/youtube_qx_merge/merge.youtube.response.js

2. 覆盖后打开 raw 地址检查，应显示多行文本（不是 Total lines: 1）：
   https://raw.githubusercontent.com/peanutgao/my-scripts/refs/heads/main/quantumult/youtube_qx_merge/YouTubeAds_DualSubs_Merged.conf
   https://raw.githubusercontent.com/peanutgao/my-scripts/refs/heads/main/quantumult/youtube_qx_merge/merge.youtube.response.js

3. Quantumult X 只订阅这一个 conf：
   https://raw.githubusercontent.com/peanutgao/my-scripts/refs/heads/main/quantumult/youtube_qx_merge/YouTubeAds_DualSubs_Merged.conf

4. 删除/关闭旧的 YoutubeAds.conf、DualSubs.YouTube.snippet/plugin，避免重复改写 player。

5. 在 QX 里「重写」标签页点更新资源；DualSubs 的字幕语言等设置仍通过其 BoxJS 配置。

6. 强退 YouTube 再打开。验证：
   - 播放任意视频应无贴片广告；
   - 锁屏/切到后台音频继续播放（后台播放）；
   - 视频出现 DualSubs 双语字幕选项。
   若某项不生效，QX 工具→日志里搜索 [MergeYouTube] 与 DualSubs 关键字排查。

【翻译字幕只显示原文 / 日志出现 “🟧 Translate ... retry / 请求超时”】
DualSubs 的“翻译”由独立的 timedtext 规则 + Translate.response.bundle.js 完成，
不经过本合并脚本。它默认调 Google 翻译接口 translate.googleapis.com 把原文译成中文，
该域名国内无法直连，QX 里脚本的 $task.fetch 走主配置分流策略——若该域名没走代理就会
超时重试、最终退回原文。解决：在 QX 主配置 [filter_local] 增加（策略名换成 YouTube 在用的）：
   host-suffix, translate.googleapis.com, 你的代理策略名
   host-suffix, translate.google.com, 你的代理策略名
（或直接 host-suffix, googleapis.com, 你的代理策略名 一并覆盖 youtubei 与 translate）
保存后强退 YouTube 重开即可。这一步与“去广告/后台/字幕注入”的合并无关，单独用 DualSubs 同样需要。
