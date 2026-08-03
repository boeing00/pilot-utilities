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
 * 응답:  { resultCode, resultMsg, count, items:[...] }
 */

const BASE = 'https://apis.data.go.kr/B551177/StatusOfPassengerFlightsDeOdp';
const OP = { D: 'getPassengerDeparturesDeOdp', A: 'getPassengerArrivalsDeOdp' };

// 앱이 올라간 출처만 허용하려면 아래를 GitHub Pages 도메인으로 좁히세요.
// 예: 'https://boeing00.github.io'  (개발 중엔 '*' 로 두어도 됩니다)
const ALLOW_ORIGIN = '*';

const cors = {
  'Access-Control-Allow-Origin': ALLOW_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const flight = (url.searchParams.get('flight') || '').trim().toUpperCase().replace(/[\s-]+/g, '');
    const io = (url.searchParams.get('io') || 'D').toUpperCase() === 'A' ? 'A' : 'D';

    if (!flight) return json({ error: 'missing flight parameter' }, 400);
    if (!env.SERVICE_KEY) return json({ error: 'server not configured (SERVICE_KEY)' }, 500);

    // serviceKey 는 공공데이터포털 "인코딩 인증키"(URL-encoded)를 그대로 저장 → 그대로 부착.
    const api = `${BASE}/${OP[io]}?serviceKey=${env.SERVICE_KEY}`
      + `&type=json&numOfRows=20&pageNo=1&flight_id=${encodeURIComponent(flight)}`;

    let r;
    try {
      r = await fetch(api, { cf: { cacheTtl: 60, cacheEverything: true } });
    } catch (e) {
      return json({ error: 'upstream fetch failed', detail: String(e) }, 502);
    }

    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // 오류 시 공공데이터포털이 XML 을 돌려주는 경우가 있어 원문 일부를 전달.
      return json({ error: 'upstream returned non-JSON', raw: text.slice(0, 500) }, 502);
    }

    const header = data?.response?.header || {};
    const body = data?.response?.body || {};
    if (header.resultCode && header.resultCode !== '00') {
      return json({ error: 'api error', resultCode: header.resultCode, resultMsg: header.resultMsg }, 502);
    }

    let items = body.items || [];
    if (!Array.isArray(items)) items = items ? [items] : []; // 단건일 때 객체로 오는 경우 방어

    return json({
      resultCode: header.resultCode || '00',
      resultMsg: header.resultMsg || 'NORMAL SERVICE.',
      io,
      flight,
      count: items.length,
      items,
    });
  },
};
