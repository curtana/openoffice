# 개발 보고서: #<work order> <제목>

- 에픽: #<epic> · LLD: #<lld> · 가지: `feature/<issue>-<slug>` @ <short sha>
- 작성: ieum-dev-worker · 날짜: <YYYY-MM-DD>

## 1. 바꾼 코드

| 파일     | 바꾼 것 | LLD의 함수 |
| -------- | ------- | ---------- |
| `<path>` |         |            |

## 2. 단위 테스트

| 테스트 파일 | 경우 | 결과 |
| ----------- | ---- | ---- |
|             |      |      |

## 3. 주요 검증 내용

- 실행한 명령과 결과:
  - `npm run typecheck -w @genoffice/<ws>` — 통과
  - `npm run test -w @genoffice/<ws>` — <통과 N / 실패 N / 건너뜀 N>
  - `npx eslint <files>`, `npx prettier --check <files>` — 통과
- 수용 기준 대응: <작업지시서의 각 항목 — 어떻게 확인했는지>
- 원래 있던 실패: 없음 | <테스트 — 손대지 않은 develop에서도 실패함을 확인한 결과>

## 4. LLD와 다른 점

- 없음 | <무엇을, 왜. 설계와 합의한 이슈 댓글 링크>

## 5. 검수가 특히 볼 것

- <위험한 부분, 경계 조건, 자동으로 확인하지 못한 것과 확인 방법>
