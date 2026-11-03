/**
 * 出网统一 User-Agent。
 *
 * 以前这里写的是 'dsh-get-it-for-free'，等于把插件名印在每一个请求上：上游只要按 UA
 * 建一张黑名单，整条链路就废了（华为云 CodeArts 就是这么把带宿主 UA 的请求判成 403 的）。
 * 现在换成一个中性的常见客户端标识，不再携带任何来源信息。
 */
export const APP_USER_AGENT = 'axios/1.7.7'
