/**
 * ICN Gate Proxy — Cloudflare Worker
 * ----------------------------------
 * pilot-utilities GATE 탭이 인천국제공항공사 여객편 운항현황 API를
 * 브라우저에서 직접 못 부르는(CORS 미개방) 문제를 우회하는 프록시.
 *
 * - serviceKey 는 Worker secret(SERVICE_KEY)에만 보관 → repo/앱에 노출 안 됨.
 * - 편명(flight)으로 인천공항 API 를 호출하고 items 배열 + CORS 헤더로 반환.
 * - 날짜 선택/표시는 클라이언트(index.html)가 처리한다.
 *
 * 사용:  GET /?flight=VN433&io=D      (io: D=출발 / A=도착, 기본 D)
 * 응답:  { resultCode, resultMsg, count, items:[...], cache, stale?, ageSec? }
 *
 * 캐싱 (2단) — 다수 사용자를 감당하기 위한 핵심 장치
 * --------------------------------------------------
 * data.go.kr 개발계정은 1,000 호출/일, 운영계정은 1,000,000/일이다.
 * 같은 항공편을 여러 사람이 조회하면 그대로 호출 수가 배로 나가므로 캐시가 필요하다.
 *
 *   L1  isolate 메모리 (아래 MEM)  — 무료·무제한. 같은 isolate 로 들어온 재조회를 즉시 처리.
 *   L2  Workers KV (선택 바인딩)   — isolate/콜로 간 공유. 무료 한도 쓰기 1,000/일·읽기 100,000/일.
 *
 * ⚠ Cache API(`caches.default`) 와 fetch 의 `cf: { cacheTtl }` 은
 *   **`*.workers.dev` 도메인에서 동작하지 않는다** (캐시가 zone 단위라 Cloudflare 가 막아둠).
 *   예전 코드에 있던 `cf: { cacheTtl: 60, cacheEverything: true }` 는 사실상 무효였다.
 *   커스텀 도메인을 붙이면 그때 Cache API 로 바꾸는 것이 가장 좋다.
 *
 * KV 는 없으면 없는 대로 동작한다(L1 만 사용). 붙이려면 wrangler.toml 참고.
 *
 * stale-while-error
 * -----------------
 * 캐시 항목은 FRESH_TTL 이 지나도 STALE_TTL 까지 버리지 않고 들고 있는다.
 * 원본이 일일 트래픽 초과(resultCode 22)나 네트워크 오류로 실패하면, 에러를 던지는 대신
 * 이 예비분을 `stale: true` 로 내려준다 — 한도가 소진돼도 앱이 통째로 먹통이 되지 않는다.
 * 오래된 값을 조용히 내놓지 않도록 `ageSec` 를 함께 실어 클라이언트가 표시할 수 있게 한다.
 */

const BASE = 'https://apis.data.go.kr/B551177/StatusOfPassengerFlightsDeOdp';
const OP = { D: 'getPassengerDeparturesDeOdp', A: 'getPassengerArrivalsDeOdp' };

// 게이트/시각은 분 단위로 바뀌므로 60초면 신선도와 호출량이 모두 무난하다.
// (KV 의 expirationTtl 최솟값도 60초라 이 값 아래로는 내릴 수 없다.)
const FRESH_TTL_SEC = 60;

// 원본이 죽었을 때 대신 내줄 수 있는 최대 나이. 30분 지난 게이트 정보는
// 없는 것보다는 낫지만 그 이상은 오히려 오해를 부르므로 여기서 끊는다.
const STALE_TTL_SEC = 30 * 60;

// L1 이 무한정 커지지 않도록 상한을 둔다. 넘으면 가장 오래된 항목부터 버린다.
const MEM_MAX = 500;

/** @type {Map<string, {fetchedAt: number, payload: object}>} */
const MEM = new Map();

// 앱이 올라간 출처만 허용하려면 아래를 GitHub Pages 도메인으로 좁히세요.
// 예: 'https://boeing00.github.io'  (개발 중엔 '*' 로 두어도 됩니다)
const ALLOW_ORIGIN = '*';

const cors = {
  'Access-Control-Allow-Origin': ALLOW_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...cors,
      ...extraHeaders,
    },
  });
}

const ageSecOf = (entry) => Math.round((Date.now() - entry.fetchedAt) / 1000);
const isFresh = (entry) => ageSecOf(entry) < FRESH_TTL_SEC;

/** 신선/만료 판단은 호출부에 맡기고, STALE_TTL 넘은 것만 버린다. */
function memGet(key) {
  const entry = MEM.get(key);
  if (!entry) return null;
  if (ageSecOf(entry) >= STALE_TTL_SEC) {
    MEM.delete(key);
    return null;
  }
  return entry;
}

function memPut(key, entry) {
  // Map 은 삽입 순서를 유지하므로 첫 키가 가장 오래된 것이다.
  if (MEM.size >= MEM_MAX && !MEM.has(key)) {
    const oldest = MEM.keys().next().value;
    if (oldest !== undefined) MEM.delete(oldest);
  }
  MEM.set(key, entry);
}

/** 캐시된 항목을 응답으로. fresh 면 그대로, 아니면 stale 표시를 붙인다. */
function fromCache(entry, source) {
  const fresh = isFresh(entry);
  const label = fresh ? source : 'stale';
  return json(
    { ...entry.payload, cache: label, stale: !fresh, ageSec: ageSecOf(entry) },
    200,
    { 'X-Cache': label },
  );
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const flight = (url.searchParams.get('flight') || '').trim().toUpperCase().replace(/[\s-]+/g, '');
    const io = (url.searchParams.get('io') || 'D').toUpperCase() === 'A' ? 'A' : 'D';

    if (!flight) return json({ error: 'missing flight parameter' }, 400);
    if (!env.SERVICE_KEY) return json({ error: 'server not configured (SERVICE_KEY)' }, 500);

    const key = `v1:${io}:${flight}`;

    // 원본이 실패했을 때 내줄 예비분. 아래에서 채워진다.
    let fallback = null;

    // ── L1: isolate 메모리 ────────────────────────────────────────────────
    const memEntry = memGet(key);
    if (memEntry) {
      if (isFresh(memEntry)) return fromCache(memEntry, 'hit-mem');
      fallback = memEntry;
    }

    // ── L2: KV (바인딩이 있을 때만) ───────────────────────────────────────
    if (env.GATE_CACHE) {
      try {
        const kvEntry = await env.GATE_CACHE.get(key, 'json');
        if (kvEntry?.fetchedAt && kvEntry.payload) {
          memPut(key, kvEntry); // L1 로 끌어올려 다음 조회는 KV 읽기도 아끼게 한다.
          if (isFresh(kvEntry)) return fromCache(kvEntry, 'hit-kv');
          // 메모리 예비분보다 새 것일 때만 교체.
          if (!fallback || kvEntry.fetchedAt > fallback.fetchedAt) fallback = kvEntry;
        }
      } catch {
        // KV 장애/한도 초과는 캐시 미스와 동일하게 취급하고 계속 진행한다.
      }
    }

    /** 원본 실패 시 예비분이 있으면 그것으로, 없으면 에러 그대로. */
    const failOrStale = (errorBody, status) =>
      fallback ? fromCache(fallback, 'stale') : json(errorBody, status);

    // ── 원본 호출 ────────────────────────────────────────────────────────
    // serviceKey 는 공공데이터포털 "인코딩 인증키"(URL-encoded)를 그대로 저장 → 그대로 부착.
    const api = `${BASE}/${OP[io]}?serviceKey=${env.SERVICE_KEY}`
      + `&type=json&numOfRows=20&pageNo=1&flight_id=${encodeURIComponent(flight)}`;

    let r;
    try {
      r = await fetch(api);
    } catch (e) {
      return failOrStale({ error: 'upstream fetch failed', detail: String(e) }, 502);
    }

    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // 오류 시 공공데이터포털이 XML 을 돌려주는 경우가 있어 원문 일부를 전달.
      return failOrStale({ error: 'upstream returned non-JSON', raw: text.slice(0, 500) }, 502);
    }

    const header = data?.response?.header || {};
    const body = data?.response?.body || {};

    if (header.resultCode && header.resultCode !== '00') {
      // 일일 트래픽 초과(22)는 "설정이 틀렸다"가 아니라 "지금은 못 쓴다"이므로
      // 429 로 따로 알려서 앱이 '조회 실패'가 아닌 '일시적 이용량 초과'로 안내할 수 있게 한다.
      const quotaExceeded = header.resultCode === '22'
        || /LIMITED_NUMBER_OF_SERVICE_REQUESTS/i.test(header.resultMsg || '');
      return failOrStale({
        error: quotaExceeded ? 'quota exceeded' : 'api error',
        reason: quotaExceeded ? 'quota_exceeded' : 'api_error',
        resultCode: header.resultCode,
        resultMsg: header.resultMsg,
      }, quotaExceeded ? 429 : 502);
    }

    let items = body.items || [];
    if (!Array.isArray(items)) items = items ? [items] : []; // 단건일 때 객체로 오는 경우 방어

    const payload = {
      resultCode: header.resultCode || '00',
      resultMsg: header.resultMsg || 'NORMAL SERVICE.',
      io,
      flight,
      count: items.length,
      items,
    };
    const entry = { fetchedAt: Date.now(), payload };

    // 빈 결과(운항 기간 밖 편명 등)도 캐시한다 — 재조회가 잦고, 그때마다 원본을 부르면
    // 정작 유효한 조회에 쓸 호출량을 갉아먹는다.
    memPut(key, entry);
    if (env.GATE_CACHE) {
      // 응답을 붙잡아 두지 않도록 백그라운드로 쓴다. KV 쓰기 한도(무료 1,000/일)를
      // 넘겨 실패해도 사용자 응답에는 영향이 없어야 한다.
      ctx.waitUntil(
        env.GATE_CACHE
          .put(key, JSON.stringify(entry), { expirationTtl: STALE_TTL_SEC })
          .catch(() => {}),
      );
    }

    return json({ ...payload, cache: 'miss', stale: false, ageSec: 0 }, 200, { 'X-Cache': 'miss' });
  },
};
