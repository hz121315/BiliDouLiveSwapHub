/* BiliDouLiveSwapHub：后台服务（抓取抖音直播间信息） */
importScripts('src/douyin.js');

const CACHE_TTL = 2 * 60 * 1000;
const FETCH_TIMEOUT = 20 * 1000;

const cache = new Map(); // rid -> { at, data }
const inflight = new Map(); // rid -> Promise

function log() {
  console.info.apply(console, ['[BDS]'].concat(Array.from(arguments)));
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6'
      }
    });
    const html = await response.text();
    return { response, html, finalUrl: response.url || url };
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeVerification(html, finalUrl) {
  const url = String(finalUrl || '').toLowerCase();
  if (url.includes('verify') || url.includes('captcha')) return true;
  if (!html || html.length < 20000) {
    return /验证码|安全验证|滑块|人机验证|captcha/i.test(html || '');
  }
  const title = (html.match(/<title[^>]*>([\s\S]{0,120}?)<\/title>/i) || [])[1] || '';
  return /验证码|安全验证|人机验证|captcha/i.test(title);
}

function fetchErrorMessage(error) {
  if (error && (error.name === 'AbortError' || /aborted/i.test(String(error.message || '')))) {
    return '请求抖音超时，请检查网络后重试';
  }
  return '无法访问抖音直播间页面：' + String((error && error.message) || error);
}

async function doResolve(rid, force, shortUrl) {
  const cacheKey = rid ? String(rid) : 'short:' + shortUrl;
  if (!force) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL) {
      const data = hit.data;
      // 未开播的结果不缓存命中，避免直播间刚开播时还拿到旧的“未开播”。
      if (data.live && (!data.expiresAt || data.expiresAt - Date.now() > 2 * 60 * 1000)) {
        return data;
      }
    }
  }

  const targetUrl = shortUrl || 'https://live.douyin.com/' + encodeURIComponent(rid);
  let page;
  try {
    page = await fetchPage(targetUrl);
  } catch (error) {
    return { ok: false, code: 'FETCH', error: fetchErrorMessage(error) };
  }

  const response = page.response;
  if (!response.ok) {
    return {
      ok: false,
      code: 'HTTP',
      error: '抖音返回 HTTP ' + response.status + '，请稍后重试'
    };
  }

  let parsedRid = rid;
  if (!parsedRid) {
    const match = String(page.finalUrl).match(/live\.douyin\.com\/(?:share\/)?(\d{5,})/i);
    if (match) parsedRid = match[1];
  }

  if (looksLikeVerification(page.html, page.finalUrl)) {
    return {
      ok: false,
      code: 'VERIFY',
      error: '抖音返回了安全验证页。请先在浏览器打开抖音直播间完成验证，再点“重连”。',
      rid: parsedRid || ''
    };
  }

  let data;
  try {
    data = BDSDouyin.parseRoomHtml(page.html, parsedRid);
  } catch (error) {
    const hint = /验证|captcha/i.test(page.html)
      ? '页面被抖音风控拦截，请先在浏览器打开抖音直播间完成验证后重试。'
      : '抖音页面结构可能已更新，未能解析到直播流地址。';
    return {
      ok: false,
      code: /验证|captcha/i.test(page.html) ? 'VERIFY' : 'PARSE',
      error: hint,
      rid: parsedRid || '',
      detail: String((error && error.message) || error)
    };
  }

  if (!data.rid && parsedRid) data.rid = String(parsedRid);
  data.fetchedAt = Date.now();
  data.fromCache = false;

  if (!data.live) {
    data.error = data.message || '抖音直播间当前未开播';
  }

  cache.set(cacheKey, { at: Date.now(), data });
  if (data.rid) {
    cache.set(String(data.rid), { at: Date.now(), data });
  }
  log('resolved', data.rid, data.title, 'live=' + data.live, 'streams=' + (data.streams || []).length);
  return data;
}

function resolveStream(rid, force, shortUrl) {
  const key = rid ? String(rid) : 'short:' + shortUrl;
  if (inflight.has(key)) return inflight.get(key);
  const promise = doResolve(rid, force, shortUrl)
    .catch((error) => ({
      ok: false,
      code: 'UNKNOWN',
      error: '解析失败：' + String((error && error.message) || error)
    }))
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'BDS_RESOLVE') return undefined;

  const input = BDSDouyin.normalizeRoomInput(message.rid);
  if (!input) {
    sendResponse({ ok: false, code: 'INVALID', error: '请输入抖音直播间链接或房间号' });
    return false;
  }

  if (input.kind === 'short') {
    resolveStream('', !!message.force, input.shortUrl).then(sendResponse);
  } else {
    resolveStream(input.rid, !!message.force).then(sendResponse);
  }
  return true;
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'BDS_TOGGLE_PANEL' }, () => {
    void chrome.runtime.lastError;
  });
});

chrome.runtime.onInstalled.addListener(() => {
  log('installed');
});
