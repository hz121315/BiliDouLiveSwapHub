/*
 * 抖音直播页面解析器
 * 只依赖 DOM 字符串，不依赖抖音接口签名（a_bogus 等）。
 * 通过在 live.douyin.com/<rid> 的 SSR/Next.js flight 数据里提取 roomInfo 获取拉流地址。
 */
(function (root) {
  'use strict';

  var QUALITY_ORDER = ['FULL_HD1', 'HD1', 'SD2', 'SD1'];
  var QUALITY_LABELS = {
    FULL_HD1: '蓝光',
    HD1: '超清',
    SD2: '高清',
    SD1: '标清'
  };
  // 抖音 flv_pull_url / hls_pull_url_map 的清晰度 key 与 live_core_sdk_data 里 sdk_key 的对应关系
  var SDK_KEY_BY_URL = {
    FULL_HD1: 'uhd',
    HD1: 'hd',
    SD1: 'ld',
    SD2: 'sd'
  };

  function parseJsonSafe(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  /**
   * 从 text[start]（必须是 '{'）开始，按字符串感知的括号匹配截取完整 JSON 对象。
   */
  function extractBalancedObject(text, start) {
    if (!text || text[start] !== '{') return null;
    var depth = 0;
    var inString = false;
    var escaped = false;

    for (var i = start; i < text.length; i++) {
      var ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  /**
   * 在任意文本中查找 "roomInfo":{...}。
   * expectedRid 存在时优先匹配 web_rid；strict=false 时允许接受第一个带房间数据的 roomInfo。
   */
  function findRoomInfo(text, expectedRid, strict, requirePayload) {
    var cursor = 0;
    var looseMatch = null;

    while (cursor < text.length) {
      var marker = text.indexOf('"roomInfo"', cursor);
      if (marker === -1) break;

      var colon = text.indexOf(':', marker + 10);
      if (colon === -1) break;
      var brace = text.indexOf('{', colon + 1);
      if (brace === -1) break;

      var json = extractBalancedObject(text, brace);
      if (!json) {
        cursor = brace + 1;
        continue;
      }

      var info = parseJsonSafe(json);
      if (!info || !info.room) {
        cursor = brace + 1;
        continue;
      }
      if (requirePayload !== false && !hasRoomPayload(info)) {
        cursor = brace + 1;
        continue;
      }

      var rid = String(info.web_rid || '');
      // 指定了房间号时，绝不接受别的房间数据（即使页面里有推荐直播间的流）。
      if (expectedRid && rid && rid !== String(expectedRid)) {
        cursor = brace + 1;
        continue;
      }

      if (!strict || !expectedRid || !rid || rid === String(expectedRid)) {
        return info;
      }
      if (!looseMatch) looseMatch = info;
      cursor = brace + 1;
    }

    return strict ? null : looseMatch;
  }

  function hasRoomPayload(info) {
    var room = info && info.room;
    if (!room) return false;
    var sources = [room.stream_url, room.web_stream_url, info.web_stream_url];
    for (var i = 0; i < sources.length; i++) {
      var source = sources[i];
      if (!source) continue;
      if (source.flv_pull_url) return true;
      if (source.hls_pull_url_map) return true;
      if (source.hls_pull_url) return true;
    }
    return false;
  }

  /**
   * 抖音页面使用 self.__pace_f.push([1,"<json-string>"]) 分片下发 flight 数据。
   */
  function extractFlightTexts(html) {
    var texts = [];
    var re = /self\.__pace_f\.push\(\s*\[\s*\d+\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\s*\)/g;
    var match;
    while ((match = re.exec(html)) !== null) {
      var parsed = parseJsonSafe(match[1]);
      if (typeof parsed === 'string' && parsed.length > 0) texts.push(parsed);
    }
    return texts;
  }

  function unescapeHtmlJson(html) {
    return String(html)
      .replace(/\\u0026/gi, '&')
      .replace(/\\u003c/gi, '<')
      .replace(/\\u003e/gi, '>')
      .replace(/\\u002f/gi, '/')
      .replace(/\\\//g, '/')
      .replace(/\\"/g, '"');
  }

  function isEmptyObject(obj) {
    return !obj || typeof obj !== 'object' || Object.keys(obj).length === 0;
  }

  function toUrlMap(value) {
    var map = {};
    if (!value) return map;
    if (typeof value === 'string') {
      var single = httpsify(value);
      if (single) map.DEFAULT = single;
      return map;
    }
    if (typeof value !== 'object') return map;
    Object.keys(value).forEach(function (key) {
      if (typeof value[key] === 'string' && value[key]) {
        map[key] = httpsify(value[key]);
      }
    });
    return map;
  }

  function httpsify(url) {
    if (typeof url !== 'string') return '';
    var result = url.trim().replace(/&amp;/g, '&');
    if (!result) return '';
    if (result.indexOf('//') === 0) result = 'https:' + result;
    result = result.replace(/^http:\/\//i, 'https://');
    return result;
  }

  function uniquePush(arr, value) {
    if (value && arr.indexOf(value) === -1) arr.push(value);
  }

  function qualityLabel(key) {
    if (QUALITY_LABELS[key]) return QUALITY_LABELS[key];
    if (/FULL|UHD|ORIGIN/i.test(key)) return '原画';
    if (/LD/i.test(key)) return '标清';
    if (/SD/i.test(key)) return '高清';
    if (/HD/i.test(key)) return '超清';
    if (key === 'DEFAULT') return '默认';
    return key;
  }

  function qualityRank(key) {
    var index = QUALITY_ORDER.indexOf(key);
    return index === -1 ? 100 : index;
  }

  /**
   * 从 live_core_sdk_data.pull_data.options 中取出每个清晰度的名称、分辨率、码率、帧率和等级。
   * 这是判断“哪个才是最高画质”的依据；页面的 default_resolution 往往只是匿名默认的 720p。
   */
  function parseQualityMeta(sdkData) {
    var map = {};
    if (!sdkData || typeof sdkData !== 'object') return map;
    var options = sdkData.pull_data && sdkData.pull_data.options;
    if (!options) return map;

    var list = options.qualities;
    if (Array.isArray(list)) {
      list.forEach(function (item) {
        if (item && item.sdk_key) map[String(item.sdk_key)] = item;
      });
    } else if (list && typeof list === 'object') {
      Object.keys(list).forEach(function (key) {
        var item = list[key];
        if (item && typeof item === 'object') map[String(item.sdk_key || key)] = item;
      });
    }

    var defaultQuality = options.default_quality;
    if (defaultQuality && defaultQuality.sdk_key && !map[defaultQuality.sdk_key]) {
      map[String(defaultQuality.sdk_key)] = defaultQuality;
    }
    return map;
  }

  function formatMbps(bitrate) {
    if (!bitrate || !Number.isFinite(Number(bitrate))) return '';
    var mbps = Number(bitrate) / 1000000;
    var rounded = Math.round(mbps * 10) / 10;
    return String(rounded);
  }

  function makeQualityStreamInfo(key, meta) {
    var name = meta && meta.name ? String(meta.name) : qualityLabel(key);
    if (key === 'ORIGIN') name = '原画';

    var resolution = meta && typeof meta.resolution === 'string' ? meta.resolution : '';
    var height = 0;
    if (resolution && resolution.indexOf('x') !== -1) {
      height = parseInt(resolution.split('x')[1], 10) || 0;
    }
    var fps = meta && Number(meta.fps) ? Number(meta.fps) : 0;
    var bitrate = meta && Number(meta.v_bit_rate) ? Number(meta.v_bit_rate) : 0;

    var label;
    if (key === 'ORIGIN') {
      // 原画的 sdk_params 里 resolution 为空，且页面标称码率并不可靠；直接用原生档位名称。
      label = '原画（H.265）';
    } else {
      label = name;
      if (height) label += ' ' + height + 'P';
      if (fps) label += String(fps);
    }

    return {
      label: label,
      name: name,
      resolution: resolution,
      height: height,
      fps: fps,
      bitrate: bitrate,
      level: meta && Number(meta.level) ? Number(meta.level) : 0,
      codec: meta && meta.v_codec ? String(meta.v_codec) : ''
    };
  }

  function compareStreams(a, b) {
    if (a.level !== b.level) return b.level - a.level;
    if (a.bitrate !== b.bitrate) return b.bitrate - a.bitrate;
    if (a.height !== b.height) return b.height - a.height;
    return qualityRank(a.key) - qualityRank(b.key);
  }

  function pickBestQuality(streams) {
    if (!streams || !streams.length) return '';
    // streams 已按 level/码率/分辨率从高到低排序；原画（ORIGIN，HLS）排在最前。
    return streams[0].key;
  }

  function pickStreamSource(info) {
    var room = info.room || {};
    var candidates = [];
    if (room.stream_url) candidates.push(room.stream_url);
    if (room.web_stream_url) candidates.push(room.web_stream_url);
    if (info.web_stream_url) candidates.push(info.web_stream_url);

    var firstWithHls = null;
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      if (!candidate) continue;
      var flvMap = toUrlMap(candidate.flv_pull_url);
      var hlsMap = toUrlMap(candidate.hls_pull_url_map);
      var singleHls = httpsify(candidate.hls_pull_url || '');
      if (!isEmptyObject(flvMap)) {
        return {
          flv: flvMap,
          hls: hlsMap,
          singleHls: singleHls,
          defaultQuality: candidate.default_resolution || '',
          sdkData: candidate.live_core_sdk_data || null
        };
      }
      if (!firstWithHls && (!isEmptyObject(hlsMap) || singleHls)) {
        firstWithHls = {
          flv: flvMap,
          hls: hlsMap,
          singleHls: singleHls,
          defaultQuality: candidate.default_resolution || '',
          sdkData: candidate.live_core_sdk_data || null
        };
      }
    }
    return firstWithHls;
  }

  function buildStreams(info, originFlv, h265OriginHls, h265OriginFlv) {
    var source = pickStreamSource(info);
    if (!source) return [];

    var metaMap = parseQualityMeta(source.sdkData);
    var keys = [];
    Object.keys(source.flv).forEach(function (key) { uniquePush(keys, key); });
    Object.keys(source.hls).forEach(function (key) { uniquePush(keys, key); });
    if (!keys.length && source.singleHls) keys.push('DEFAULT');

    var streams = [];
    keys.forEach(function (key) {
      var flv = source.flv[key] || '';
      var hls = source.hls[key] || '';
      if (!hls && source.singleHls && (key === 'DEFAULT' || !source.flv[key])) {
        hls = source.singleHls;
      }
      if (!flv && !hls) return;

      var sdkKey = SDK_KEY_BY_URL[key] || String(key).toLowerCase();
      var meta = metaMap[sdkKey] || null;
      var streamInfo = makeQualityStreamInfo(key, meta);

      streams.push({
        key: key,
        label: streamInfo.label,
        name: streamInfo.name,
        resolution: streamInfo.resolution,
        height: streamInfo.height,
        fps: streamInfo.fps,
        bitrate: streamInfo.bitrate,
        level: streamInfo.level,
        codec: streamInfo.codec,
        flv: flv,
        hls: hls
      });
    });

    streams.sort(compareStreams);

    // hls_pull_url 是抖音的“原画（源）”流（H.264 的 _or4，H.265 的无后缀路径）。
    // web_stream_url 下还有一条无后缀的 H.265 原画 FLV（bytevc1），适合用 mpegts.js 的 FLV/HEVC 解封装。
    if ((source.singleHls || originFlv || h265OriginHls || h265OriginFlv) && keys.indexOf('ORIGIN') === -1) {
      var originMeta = metaMap.origin || null;
      var originInfo = makeQualityStreamInfo('ORIGIN', originMeta);
      streams.push({
        key: 'ORIGIN',
        label: originInfo.label,
        name: originInfo.name,
        resolution: originInfo.resolution,
        height: originInfo.height,
        fps: originInfo.fps,
        bitrate: originInfo.bitrate,
        level: 5,
        codec: originInfo.codec,
        flv: originFlv || '',
        hls: source.singleHls || '',
        hls265: h265OriginHls || '',
        flv265: h265OriginFlv || ''
      });
      streams.sort(compareStreams);
    } else if (h265OriginHls || h265OriginFlv) {
      var existingOrigin = null;
      for (var si = 0; si < streams.length; si++) {
        if (streams[si].key === 'ORIGIN') { existingOrigin = streams[si]; break; }
      }
      if (existingOrigin) {
        if (h265OriginHls) existingOrigin.hls265 = h265OriginHls;
        if (h265OriginFlv) existingOrigin.flv265 = h265OriginFlv;
      }
    }

    // 额外的 H.264 原画档：码率略低（约 14.5Mbps），但 FLV 连续流、延迟低、解码压力小。
    // 当 H.265 HLS 在用户网络/设备上卡顿时，可以手动切换到这个档位。
    if ((originFlv || source.singleHls) && keys.indexOf('ORIGIN_H264') === -1) {
      streams.push({
        key: 'ORIGIN_H264',
        label: '原画（H.264）',
        name: '原画',
        resolution: '',
        height: 0,
        fps: 60,
        bitrate: 14500000,
        level: 4.9,
        codec: '264',
        flv: originFlv || '',
        hls: source.singleHls || '',
        hls265: '',
        flv265: ''
      });
      streams.sort(compareStreams);
    }

    return streams;
  }

  function collectUrlsFromStreams(streams) {
    var urls = [];
    streams.forEach(function (stream) {
      if (stream.flv) urls.push(stream.flv);
      if (stream.hls) urls.push(stream.hls);
      if (stream.hls265) urls.push(stream.hls265);
      if (stream.flv265) urls.push(stream.flv265);
    });
    return urls;
  }

  function parseExpireMs(url) {
    try {
      var parsed = new URL(url);
      var raw = parsed.searchParams.get('expire') || parsed.searchParams.get('x-expires') || '';
      if (!raw) return 0;
      var value = parseInt(raw, 10);
      if (!Number.isFinite(value) || value <= 0) return 0;
      return value > 1e12 ? value : value * 1000;
    } catch (e) {
      return 0;
    }
  }

  function earliestExpire(urls) {
    var earliest = 0;
    urls.forEach(function (url) {
      var ms = parseExpireMs(url);
      if (ms && (!earliest || ms < earliest)) earliest = ms;
    });
    return earliest;
  }

  /**
   * 从完整 stream_data 里提取 H.264 原画 FLV 地址。
   * flv_pull_url 汇总里没有 origin，但 stream_data.data.origin.main.flv 有（路径通常是 _or4.flv）。
   */
  function extractOriginFlv(texts) {
    if (!texts || !texts.length) return '';
    var i;
    for (i = 0; i < texts.length; i++) {
      var direct = texts[i].match(/https?:\/\/[^\s"\\]+_or4\.flv[^\s"\\]*/);
      if (direct) return httpsify(direct[0]);
    }
    for (i = 0; i < texts.length; i++) {
      var text = texts[i];
      var re = /"origin"\s*:\s*\{\s*"main"\s*:\s*\{[^{}]*?"flv"\s*:\s*"([^"]+)"/g;
      var match;
      while ((match = re.exec(text)) !== null) {
        if (/_or4\.flv/i.test(match[1])) return httpsify(match[1]);
      }
    }
    return '';
  }

  // Flight 数据里的 URL 会把 & 写成 \u0026、斜杠写成 \/，先还原再提取。
  function decodeFlightText(text) {
    return String(text)
      .replace(/\\\\u0026/g, '&')
      .replace(/\\u0026/g, '&')
      .replace(/\\\\\//g, '/')
      .replace(/\\\//g, '/');
  }

  /**
   * 抖音 web_stream_url 下的无后缀原画 FLV（bytevc1/H.265）。
   * 与 H.264 的 _or4.flv 区分：路径必须是 stream-<数字>.flv?，且不是 only_audio 流。
   */
  function extractH265OriginFlv(texts) {
    if (!texts || !texts.length) return '';
    for (var i = 0; i < texts.length; i++) {
      var text = decodeFlightText(texts[i]);
      var re = /https?:\/\/[^\s"'\\]+?\/stream-\d+\.flv\?[^\s"'\\]*/g;
      var match;
      while ((match = re.exec(text)) !== null) {
        var url = httpsify(match[0]);
        if (/only_audio=1/i.test(url)) continue;
        if (/_or4\.flv|_uhd\.flv|_hd\.flv|_sd\.flv|_ld\.flv|_hiq[a-z0-9]+\.flv/i.test(url)) continue;
        return url;
      }
    }
    return '';
  }

  /**
   * 结构变化时的兜底：直接从页面文本里抓 .flv / .m3u8 地址。
   */
  function extractLooseStreams(texts) {
    var flvUrls = [];
    var hlsUrls = [];
    var flvRe = /(https?:\/\/[^"'\s\\]+?\.flv[^"'\s\\]*)/gi;
    var hlsRe = /(https?:\/\/[^"'\s\\]+?\.m3u8[^"'\s\\]*)/gi;

    texts.forEach(function (text) {
      var cleaned = httpsify(text);
      var match;
      while ((match = flvRe.exec(cleaned)) !== null) uniquePush(flvUrls, httpsify(match[1]));
      while ((match = hlsRe.exec(cleaned)) !== null) uniquePush(hlsUrls, httpsify(match[1]));
    });

    if (!flvUrls.length && !hlsUrls.length) return [];

    var preferredFlv = flvUrls.filter(function (url) {
      return /_uhd\.flv/i.test(url);
    })[0] || flvUrls.filter(function (url) {
      return /_hd\.flv/i.test(url);
    })[0] || flvUrls[0] || '';

    var preferredHls = hlsUrls.filter(function (url) {
      return /uhd/i.test(url);
    })[0] || hlsUrls[0] || '';

    return [{
      key: 'DEFAULT',
      label: '默认',
      flv: preferredFlv,
      hls: preferredHls
    }];
  }

  function buildResult(info, expectedRid, streams) {
    var room = info.room || {};
    var status = room.status;
    var statusNum = Number(status);
    var live = statusNum === 2;
    if (!Number.isFinite(statusNum)) live = streams.length > 0;

    var expiresAt = earliestExpire(collectUrlsFromStreams(streams));
    var defaultQuality = '';
    if (info.room && info.room.stream_url) {
      defaultQuality = info.room.stream_url.default_resolution || '';
    }

    return {
      ok: true,
      rid: String(info.web_rid || expectedRid || ''),
      roomId: String(info.roomId || room.id_str || ''),
      title: String(room.title || ''),
      anchor: String((info.anchor && info.anchor.nickname) || ''),
      live: live,
      status: Number.isFinite(statusNum) ? statusNum : null,
      defaultQuality: defaultQuality,
      bestQuality: pickBestQuality(streams),
      streams: streams,
      expiresAt: expiresAt
    };
  }

  function parseRoomHtml(html, expectedRid) {
    if (!html || typeof html !== 'string') {
      throw new Error('抖音页面内容为空');
    }

    var flightTexts = extractFlightTexts(html);
    var unescapedHtml = unescapeHtmlJson(html);
    var info = null;
    var bareInfo = null;
    var i;

    for (i = 0; i < flightTexts.length; i++) {
      info = findRoomInfo(flightTexts[i], expectedRid, true, true);
      if (info) break;
    }
    if (!info) {
      for (i = 0; i < flightTexts.length; i++) {
        info = findRoomInfo(flightTexts[i], expectedRid, false, true);
        if (info) break;
      }
    }
    if (!info) {
      for (i = 0; i < flightTexts.length; i++) {
        bareInfo = findRoomInfo(flightTexts[i], expectedRid, true, false);
        if (bareInfo) break;
      }
      if (!bareInfo) bareInfo = findRoomInfo(unescapedHtml, expectedRid, true, false);
    }

    var fallbackTexts = flightTexts.slice();
    fallbackTexts.push(unescapedHtml);

    var ridToken = expectedRid ? '"web_rid":"' + String(expectedRid) + '"' : '';
    var mentionsExpected = true;
    if (ridToken) {
      mentionsExpected = false;
      for (i = 0; i < fallbackTexts.length; i++) {
        if (fallbackTexts[i].indexOf(ridToken) !== -1) {
          mentionsExpected = true;
          break;
        }
      }
    }

    if (!info) {
      var looseStreams = mentionsExpected ? extractLooseStreams(fallbackTexts) : [];
      if (looseStreams.length) {
        return {
          ok: true,
          rid: String(expectedRid || ''),
          roomId: '',
          title: '',
          anchor: '',
          live: true,
          status: null,
          defaultQuality: '',
          bestQuality: pickBestQuality(looseStreams),
          streams: looseStreams,
          expiresAt: earliestExpire(collectUrlsFromStreams(looseStreams)),
          degraded: true
        };
      }

      if (bareInfo) {
        var bareRoom = bareInfo.room || {};
        var bareStatus = Number(bareRoom.status);
        return {
          ok: true,
          rid: String(bareInfo.web_rid || expectedRid || ''),
          roomId: String(bareInfo.roomId || bareRoom.id_str || ''),
          title: String(bareRoom.title || ''),
          anchor: String((bareInfo.anchor && bareInfo.anchor.nickname) || ''),
          live: false,
          status: Number.isFinite(bareStatus) ? bareStatus : null,
          defaultQuality: '',
          bestQuality: '',
          streams: [],
          expiresAt: 0,
          message: bareStatus === 4 ? '抖音直播间已下播' : '抖音直播间不存在或当前未开播'
        };
      }

      if (expectedRid && mentionsExpected) {
        return {
          ok: true,
          rid: String(expectedRid),
          roomId: '',
          title: '',
          anchor: '',
          live: false,
          status: null,
          defaultQuality: '',
          bestQuality: '',
          streams: [],
          expiresAt: 0,
          message: '抖音直播间不存在或当前未开播'
        };
      }

      throw new Error('未找到该抖音直播间（房间号可能有误，或页面触发了抖音风控）');
    }

    var originFlv = extractOriginFlv(fallbackTexts);
    var h265Source = info.web_stream_url || (info.room && info.room.web_stream_url);
    var h265OriginHls = h265Source && h265Source.hls_pull_url ? httpsify(h265Source.hls_pull_url) : '';
    var h265OriginFlv = h265OriginHls ? extractH265OriginFlv(fallbackTexts) : '';
    var streams = buildStreams(info, originFlv, h265OriginHls, h265OriginFlv);
    if (!streams.length) {
      var loose = mentionsExpected ? extractLooseStreams(fallbackTexts) : [];
      if (loose.length) streams = loose;
    }
    if (!streams.length) {
      var ended = Number(info.room && info.room.status) !== 2;
      return {
        ok: true,
        rid: String(info.web_rid || expectedRid || ''),
        roomId: String(info.roomId || ''),
        title: String((info.room && info.room.title) || ''),
        anchor: String((info.anchor && info.anchor.nickname) || ''),
        live: false,
        status: ended ? Number(info.room.status) : null,
        defaultQuality: '',
        bestQuality: '',
        streams: [],
        expiresAt: 0,
        message: ended ? '抖音直播间当前未开播' : '未找到可用的抖音直播流地址'
      };
    }

    return buildResult(info, expectedRid, streams);
  }

  /**
   * 接受：抖音直播间完整链接 / 纯房间号 / 短链接。
   */
  function normalizeRoomInput(input) {
    var text = String(input == null ? '' : input).trim();
    if (!text) return null;

    var shortMatch = text.match(/v\.douyin\.com\/([A-Za-z0-9_-]+)/i);
    if (shortMatch) {
      return { kind: 'short', shortUrl: 'https://v.douyin.com/' + shortMatch[1] + '/' };
    }

    var webRidMatch = text.match(/[?&]web_rid=(\d{5,})/i);
    if (webRidMatch) return { kind: 'rid', rid: webRidMatch[1] };

    if (/^\d{5,}$/.test(text)) return { kind: 'rid', rid: text };

    var liveMatch = text.match(/live\.douyin\.com\/(?:share\/)?(\d{5,})/i);
    if (liveMatch) return { kind: 'rid', rid: liveMatch[1] };

    var anyDigits = text.match(/(\d{6,})/);
    if (anyDigits && /douyin|直播|room/i.test(text)) {
      return { kind: 'rid', rid: anyDigits[1] };
    }

    return null;
  }

  root.BDSDouyin = {
    parseRoomHtml: parseRoomHtml,
    normalizeRoomInput: normalizeRoomInput,
    httpsify: httpsify,
    _internals: {
      extractFlightTexts: extractFlightTexts,
      findRoomInfo: findRoomInfo,
      extractBalancedObject: extractBalancedObject,
      buildStreams: buildStreams,
      extractLooseStreams: extractLooseStreams,
      extractOriginFlv: extractOriginFlv,
      extractH265OriginFlv: extractH265OriginFlv
    }
  };
})(typeof self !== 'undefined' ? self : globalThis);
