# ICN Gate Proxy (Cloudflare Worker)

인천국제공항공사 여객편 운항현황 API를 GATE 탭에서 쓰기 위한 CORS 프록시.
serviceKey는 이 Worker의 secret에만 저장되고, 앱(`index.html`)이나 이 repo에는 절대 들어가지 않습니다.

## 배포

```bash
cd proxy
npm i -g wrangler        # 또는 npx 사용
wrangler login           # Cloudflare 계정 로그인

# 인증키(공공데이터포털 "인코딩 인증키")를 secret으로 등록
wrangler secret put SERVICE_KEY
#   → 프롬프트에 인코딩 인증키를 붙여넣고 Enter

wrangler deploy
```

배포가 끝나면 다음과 같은 URL이 나옵니다:

```
https://icn-gate-proxy.<your-subdomain>.workers.dev
```

이 URL을 `index.html`의 `PROXY_BASE` 상수에 넣으면 GATE 탭이 실제 게이트를 조회합니다.

## 테스트

```bash
curl "https://icn-gate-proxy.<your-subdomain>.workers.dev/?flight=VN433&io=D"
```

정상이면 `{ "count": N, "items": [ ... ] }` 형태의 JSON이 반환됩니다.

## 엔드포인트

| 파라미터 | 값 | 설명 |
|---|---|---|
| `flight` | 예 `VN433` | 편명 (필수) |
| `io` | `D` / `A` | 출발(D, 기본) / 도착(A) |

응답은 인천공항 API의 `items`(D-3~D+6, 최대 10일치)를 그대로 담아 CORS 헤더와 함께 반환합니다.
날짜 선택·표시는 앱에서 처리합니다.
