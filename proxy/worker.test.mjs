/**
 * worker.js 캐시 동작 회귀 테스트
 * --------------------------------
 * 실행:  cd proxy && node worker.test.mjs      (의존성 없음, Node 18+)
 *
 * `wrangler dev` 로는 이 동작을 확인할 수 없다 — SERVICE_KEY 가 Worker secret 에만
 * 있어서 로컬에서 실호출을 못 하기 때문이다. 대신 `globalThis.fetch` 와 `Date.now`
 * 를 스텁해서 (1) 원본이 몇 번 불렸는지 세고 (2) 시간을 앞으로 점프시켜 TTL 경계를
 * 넘긴다. 캐시는 시간과 호출 횟수가 전부라 이 두 가지만 잡으면 충분히 검증된다.
 *
 * worker.js 는 확장자가 .js 라 ESM 으로 바로 import 하려면 package.json 의
 * "type": "module" 이 필요하다. 그것 하나 때문에 배포 설정을 건드리고 싶지는 않아
 * 파일을 읽어 data: URL 모듈로 불러온다.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(here, 'worker.js'), 'utf8');
const { default: worker } = await import(
  'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64')
);

// ── 스텁 ────────────────────────────────────────────────────────────────────

const env = { SERVICE_KEY: 'DUMMY' }; // KV 바인딩 없이 L1 만 있는 구성
const ctx = { waitUntil: () => {} };
const req = (f = 'KE037') => new Request(`https://x/?flight=${f}&io=D`);

let upstreamCalls = 0;
let mode = 'ok';

const okBody = JSON.stringify({
  response: {
    header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' },
    body: { items: [{ flightId: 'KE037', gatenumber: '233', terminalid: 'P03' }] },
  },
});
const quotaBody = JSON.stringify({
  response: {
    header: { resultCode: '22', resultMsg: 'LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR' },
    body: {},
  },
});

globalThis.fetch = async () => {
  upstreamCalls++;
  return new Response(mode === 'ok' ? okBody : quotaBody, { status: 200 });
};

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const jump = (sec) => { offset += sec * 1000; };

const call = async (f) => {
  const r = await worker.fetch(req(f), env, ctx);
  return { status: r.status, xcache: r.headers.get('X-Cache'), body: await r.json() };
};

// ── 러너 ────────────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const check = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} → ${JSON.stringify(got)}`); }
};

// ── 케이스 ──────────────────────────────────────────────────────────────────

console.log('1) 첫 호출은 원본을 부르고 miss');
{
  const a = await call();
  check('cache=miss', a.body.cache === 'miss', a.body.cache);
  check('gate 233 전달', a.body.items[0].gatenumber === '233', a.body.items[0]);
  check('원본 1회 호출', upstreamCalls === 1, upstreamCalls);
}

console.log('2) 60초 안의 재호출은 원본을 안 부르고 L1 히트');
{
  const b = await call();
  check('cache=hit-mem', b.body.cache === 'hit-mem', b.body.cache);
  check('원본 여전히 1회', upstreamCalls === 1, upstreamCalls);
  check('X-Cache 헤더', b.xcache === 'hit-mem', b.xcache);
}

console.log('3) 60초 경과 후엔 다시 원본을 부른다');
{
  jump(61);
  const c = await call();
  check('cache=miss', c.body.cache === 'miss', c.body.cache);
  check('원본 2회', upstreamCalls === 2, upstreamCalls);
}

console.log('4) 한도초과(22)인데 예비분이 있으면 stale 로 살려준다');
{
  jump(61);
  mode = 'quota';
  const d = await call();
  check('HTTP 200 유지', d.status === 200, d.status);
  check('cache=stale', d.body.cache === 'stale', d.body.cache);
  check('stale 플래그', d.body.stale === true, d.body.stale);
  check('데이터 살아있음', d.body.items?.[0]?.gatenumber === '233', d.body.items);
  check('ageSec 노출', typeof d.body.ageSec === 'number' && d.body.ageSec >= 61, d.body.ageSec);
}

console.log('5) 예비분이 30분을 넘기면 버리고 429 를 낸다');
{
  jump(31 * 60);
  const e = await call();
  check('HTTP 429', e.status === 429, e.status);
  check('reason=quota_exceeded', e.body.reason === 'quota_exceeded', e.body.reason);
}

console.log('6) 캐시 없는 새 편명 + 한도초과 → 예비분 없으니 그대로 429');
{
  const f = await call('OZ202');
  check('HTTP 429', f.status === 429, f.status);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
