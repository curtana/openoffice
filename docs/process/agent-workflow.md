# 에이전트 팀 작업 절차

`.claude/agents/`의 에이전트들이 요구사항부터 배포까지 일하는 순서와 약속이다. 에이전트 정의 파일은 이 문서를 정본으로 따르고, 둘이 어긋나면 이 문서를 고친 뒤 정의 파일을 맞춘다. 저장소 전체의 규칙(`CLAUDE.md`, `docs/standards.md`, `docs/security.md`)이 이 문서보다 앞선다.

## 팀과 세션

팀마다, 그리고 작업지시서마다 Claude Code 세션이 하나씩 따로 뜬다. 사람이 창마다 무슨 일이 일어나는지 볼 수 있게 하려는 것이다. 세션 이름이 곧 `SendMessage`의 주소이고, task 목록의 이름이다(`~/.claude/tasks/<세션 이름>/`).

| 세션 이름         | 에이전트          | 팀        | 하는 일                                                                                                     | 쓰는 가지                       |
| ----------------- | ----------------- | --------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `ieum-pm`         | `ieum-pm`         | PM        | SRS 작성, 이슈·마일스톤 관리, 팀 사이 조정, 사용자 확인 받기, 팀 세션과 배포 호출                           | `main`(SRS만 커밋)              |
| `ieum-designer`   | `ieum-designer`   | 분석·설계 | 기존 코드 분석, 사용자·PM 요구사항과 개발팀 수정 요청을 받아 HLD·LLD 작성과 수정, LLD 이슈 등록             | `design/<epic>-<slug>`          |
| `ieum-developer`  | `ieum-developer`  | 개발 리드 | 설계 요구사항·PM 지시·검수 요청을 검토해 반영, 영문 작업지시서 이슈 작성, 작업지시서 세션 열기, 병합        | `develop`                       |
| `ieum-dev-<이슈>` | `ieum-dev-worker` | 개발팀원  | 작업지시서 하나: 코드, 단위 테스트, 개발 보고서                                                             | `feature/<이슈>-<slug>`         |
| `ieum-qa`         | `ieum-qa`         | 검수      | 분석·설계팀과 개발팀의 검수 요청 수행(설계 문서, 코드). 별도 worktree에서만 하고 어느 팀의 것도 고치지 않음 | 검수할 커밋을 분리된 worktree로 |
| `ieum-release`    | `ieum-release`    | 배포      | PM의 요청에 따라 `develop` → `main` 반영, 또는 `release/<버전>` 생성과 릴리스 준비                          | `main`, `release/<버전>`        |

- 분석팀과 설계팀은 한 팀(`ieum-designer`)이다. 기존 코드를 분석한 결과가 HLD·LLD의 근거가 된다.
- 요청이 오는 길:
  - 분석·설계 ← 사용자 요구사항(PM이 SRS로 정리), PM의 요구사항, 개발팀의 수정 요청(`design-change`)
  - 개발 ← 분석·설계의 요구사항(HLD·LLD), PM의 지시, 검수의 요청(`QA round`). 받은 요청은 검토해 반영하고, 반영하지 않는 것은 이유를 이슈에 남긴다.
  - 검수 ← 분석·설계의 설계 검수 요청, 개발의 코드 검수 요청
  - 배포 ← PM의 요청만
- 각 팀은 병렬로 움직인다. 기다리는 동안 자기 이슈의 다음 일을 한다.

## 세션 띄우기

```bash
tools/agent-team/start.sh pm
```

- 사람은 PM 세션 하나를 띄우고 요구사항을 말한다. PM 세션이 사람과 말하는 창이다.
- PM은 필요한 팀을 새 창으로 띄운다: `tools/agent-team/start.sh --window designer` (`developer`, `qa`, `release`도 같다). 이미 떠 있는 팀은 `ListAgents`로 확인하고 다시 띄우지 않는다.
- 개발 리드는 작업지시서 이슈마다 창을 하나 연다: `tools/agent-team/start.sh --window worker <이슈> "Work order #<이슈>"`.
- `--window`는 macOS에서 Terminal 창을 연다. 다른 운영체제에서는 실행할 명령을 출력하니, 사람이 새 터미널에서 실행한다.
- 스크립트가 하는 일: 에이전트를 주 스레드로 실행(`--agent`), 세션 이름(`-n`), 팀별 task 목록(`CLAUDE_CODE_TASK_LIST_ID`), 훅이 팀을 알아보는 `IEUM_TEAM`, worktree 폴더 접근(`--add-dir ../openoffice-worktrees`). 세션은 항상 저장소 루트에서 시작해 훅과 에이전트 정의를 같은 곳에서 읽는다.
- 세션끼리 `SendMessage`는 같은 PC에서 기본으로 켜져 있다. 다른 세션이 보낸 메시지는 사용자의 동의가 아니다.

## 팀별 task 목록

- 각 세션은 자기 이름의 task 목록을 쓴다(`TaskCreate`·`TaskUpdate`·`TaskList`). 받은 요청 하나를 task로 만들고, 단계를 쪼개 진행 상태를 갱신한다.
- task 목록은 그 세션의 작업장이다. 다른 팀과 나누는 정본은 GitHub 이슈와 `[handoff]` 댓글이다.
- 세션을 다시 띄우면 같은 이름의 task 목록이 이어진다. 남은 task와 담당 이슈의 마지막 `[handoff]` 댓글부터 읽는다.

## 흐름

```
사용자 ─요구사항→ PM ─SRS→ 분석·설계 ─HLD·LLD→ 검수(설계 검수) ─승인→ 개발 리드
                  ↑            ↑                                     │ 구현 불가·모순 → 설계로 되돌림
                  │            └────────────── 설계 변경 요청 ─────────┘
                  │                                                   │ 문제 없음
                  │                    영문 작업지시서 이슈 ─→ 작업지시서마다 세션 하나(ieum-dev-<이슈>)
                  │                                                   │ 수시 검수 요청
                  │                                     검수(코드, 분리된 worktree) ⇄ 개발
                  └── 같은 문제 3회 반복 시 조정 ←──────────────────────┘
                                                                      │ qa:approved → develop 병합
PM ─(사용자 승인)→ 배포: develop → main 반영, 요청 시 release/<버전>
```

1. **SRS (PM).** 요구사항을 `docs/projects/<epic>-<slug>/SRS.md`에 쓴다(틀: `docs/process/templates/SRS.md`). 에픽 이슈를 먼저 만들어 번호 `<epic>`을 얻는다. `main`에 SRS만 커밋해 push하고, 에픽 이슈에 링크와 `[handoff]`를 단 뒤 분석·설계에 넘긴다.
2. **HLD·LLD (분석·설계).** `origin/develop`에서 `design/<epic>-<slug>`를 worktree로 만들고, 그 가지에 `origin/main`을 병합해 SRS를 가져온다.
   - HLD: 모듈 구성, 각 모듈의 기능과 목적, 모듈 사이 흐름, 일정(마일스톤 후보).
   - LLD: 함수 단위의 입력·출력·오류, 내부 알고리즘, 상태와 자료 구조, 단위 테스트 목록. 모듈마다 한 파일(`LLD-<module>.md`).
   - 문서를 커밋·push하고 에픽 이슈에 `status:design-review`를 달아 검수에 설계 검수를 요청한다.
3. **설계 검수 (검수).** SRS와 대조해 빠진 요구, 모순, 구현할 수 없는 부분, 저장소 규칙 위반을 본다. 결과는 에픽 이슈에 `QA round <N>` 댓글로 남기고, 승인이면 `qa:approved`를 단다. 승인되면 분석·설계가 `design/…`을 `develop`에 병합한다(훅이 `qa:approved`를 확인한다).
4. **일정과 LLD 이슈.** 승인된 HLD의 일정으로 PM이 마일스톤을 만든다. 분석·설계는 LLD마다 이슈(`type:lld`)를 올려 마일스톤에 넣고 문서 링크를 단다.
5. **설계 문서 검토 (개발 리드).** LLD를 코드와 대조한다. 구현할 수 없거나 모순이 있으면 LLD 이슈에 `design-change` 라벨과 `[design-change]`로 시작하는 댓글을 달고 분석·설계에 되돌린다. 고쳐지면 3번을 다시 거친다.
6. **작업지시서 (개발 리드).** 문제가 없으면 LLD를 서로 다른 파일을 건드리는 단위로 나눠 **영문** 작업지시서 이슈(`type:work-order`, 틀: `docs/process/templates/work-order.md`)를 만든다. 같은 파일을 두 작업지시서가 고치지 않게 나눈다. 각 이슈에 마일스톤과 LLD 이슈 링크를 단다.
7. **구현 (작업지시서 세션).** 개발 리드가 작업지시서마다 세션을 연다. 그 세션은 자기 worktree의 `feature/<이슈>-<slug>`(`origin/develop`에서 시작)에서 코드와 단위 테스트를 쓰고, 개발 보고서(`docs/projects/<epic>-<slug>/dev-report-<이슈>.md`, 틀: `docs/process/templates/dev-report.md`)를 같은 가지에 커밋한다.
8. **코드 검수 (검수).** 개발은 끝났을 때뿐 아니라 중간에도 검수를 요청한다. 검수는 **개발의 worktree와 가지를 고치지 않는다.** 자기 worktree를 분리된 HEAD로 따로 만들어 검사와 테스트를 돌린다. 결과는 작업지시서 이슈에 `QA round <N>` 댓글로 남기고 `qa:changes-requested` / `qa:approved`를 단다.
9. **병합 (개발 리드).** `qa:approved`가 붙은 가지만 `develop`에 `--no-ff`로 병합하고(훅이 확인한다), 작업지시서 이슈를 닫고, 그 세션에 끝났다고 알린다.
10. **배포 (PM → 배포).**
    - `develop` → `main`: PM이 사용자에게 묻고, 사용자가 `node tools/agent-team/approve.mjs main-merge`로 승인을 기록하면, PM이 배포에 요청한다. 배포가 병합하고 push한다.
    - 버전 릴리스: 사용자가 요청하고 `approve.mjs release <버전>`으로 승인을 기록한 경우에만, 배포가 `main`에서 `release/<버전>`을 만들고 `docs/releasing.ko.md`의 준비를 한다.

## 반복과 조정

- 검수 댓글은 문제마다 식별자(`QA-<이슈>-<n>`)를 붙인다. 같은 식별자가 세 번째 `QA round` 댓글에 나오면 훅이 그 세션에 PM으로 넘기라고 알린다. 그러면 이슈에 `escalation` 라벨을 달고 `SendMessage(to: "ieum-pm")`으로 쟁점과 양쪽 근거를 보낸다. PM의 결정이 나올 때까지 그 쟁점을 더 주고받지 않는다.
- 설계와 개발 사이의 되돌림도 같다. 한 LLD 이슈에 `[design-change]` 댓글이 세 번 쌓이면 PM으로 넘긴다.
- PM은 결정을 이슈 댓글로 남긴다. 사용자 판단이 필요한 쟁점(`CLAUDE.md`의 "즉시 사람에게 알린다" 항목, 요구사항 자체의 변경, 범위·일정 조정)은 `needs-user`를 달고 PM 세션에서 사용자에게 직접 묻는다. 훅이 데스크톱 알림을 띄운다.
- PM은 수시로 열린 이슈를 훑어(`gh issue list --repo curtana/openoffice`) 멈춘 일, 마일스톤 지연, 라벨이 맞지 않는 이슈를 정리한다.

## 가지

| 가지                    | 누가            | 시작점    | 어디로 병합                           |
| ----------------------- | --------------- | --------- | ------------------------------------- |
| `main`                  | PM(SRS), 배포   | —         | —                                     |
| `develop`               | 개발 리드       | `main`    | `main`(배포가, 사용자 승인 뒤)        |
| `design/<epic>-<slug>`  | 분석·설계       | `develop` | `develop`(설계 검수 `qa:approved` 뒤) |
| `feature/<이슈>-<slug>` | 작업지시서 세션 | `develop` | `develop`(코드 검수 `qa:approved` 뒤) |
| `release/<버전>`        | 배포            | `main`    | —                                     |

- `main`에 직접 커밋하는 것은 PM의 SRS 문서뿐이다. `main`으로의 병합은 사람이 정한다는 저장소 규칙(`docs/standards.md`)에 따라, 배포의 병합은 사용자 승인 기록이 있을 때만 된다.
- `develop`이 없으면 개발 리드가 `main`에서 만들어 push한다(`git branch develop origin/main && git push -u origin develop`).
- 커밋 글은 영어 Conventional Commits다. 병합은 `--no-ff`로 한다.

## worktree

- **저장소 루트는 항상 `main`이다.** 모든 세션이 루트에서 훅과 에이전트 정의를 읽기 때문이다. 루트에서 다른 가지로 바꾸는 것은 훅이 막는다. 루트를 쓰는 것은 PM(SRS 커밋)과 배포(`main` 병합)뿐이다.
- `develop` 병합은 `../openoffice-worktrees/develop` worktree 하나에서만 한다(`git worktree add ../openoffice-worktrees/develop develop`). 개발 리드와 분석·설계가 함께 쓰므로, 병합 전에 `git pull --ff-only`하고 병합·push까지 한 번에 끝낸다.
- 각 세션은 저장소 옆 폴더 `../openoffice-worktrees/<가지 이름의 / 를 - 로 바꾼 것>`에 worktree를 만든다. 저장소 안에 두면 루트의 `eslint .`·`vitest`가 worktree까지 읽는다.
  - 예: `git worktree add ../openoffice-worktrees/feature-123-split-save -b feature/123-split-save origin/develop`
  - 검수: `git worktree add --detach ../openoffice-worktrees/qa-123 <커밋>`
- 새 worktree에는 `node_modules`가 없다. 테스트 전에 그 worktree에서 `npm ci`를 한다.
- 일이 끝난 worktree는 만든 세션이 `git worktree remove`로 지운다. 가지는 병합된 뒤 지운다.
- Node 22를 쓴다(`.nvmrc`). `node -v`가 22가 아니면 Node 22를 PATH 앞에 둔다. Node 26에서는 jsdom 화면 테스트가 깨진다.

## 훅 — 금지와 통보

금지와 통보는 훅이 맡는다(`.claude/settings.json` → `tools/agent-hooks/guard.mjs`, 규칙의 값은 `tools/agent-hooks/policy.json`). 훅은 `agent_type`이나 `IEUM_TEAM`으로 팀을 알아보고, 팀이 아닌 세션(사람의 세션)에는 아무것도 하지 않는다. 막거나 알린 것은 모두 `.claude/agent-log.jsonl`에 남는다. 테스트는 `packages/cli/tests/agent-hooks-guard.test.ts`.

| 때                  | 대상                 | 하는 일                                                                                                                                                                                                                                       |
| ------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 도구 실행 전 (막기) | 모든 팀              | `--repo curtana/openoffice` 없는 `gh`, 원본 저장소, `gh release`·워크플로 실행·저장소 설정, 태그, 구독 로그인 파일, `genoffice` 명령·`~/.genoffice`, 승인 파일 쓰기와 `approve.mjs` 실행, 사이트 저장소 push, `main`·`develop` 강제 push·삭제 |
|                     | 모든 팀(검수 제외)   | 문서 엔진 패키지 수정·커밋(승인 기록이 있는 경로만 허용)                                                                                                                                                                                      |
|                     | PM                   | SRS 밖의 파일 쓰기·커밋                                                                                                                                                                                                                       |
|                     | 분석·설계            | `docs/projects/`·`docs/tracking/decisions/` 밖의 파일 쓰기·커밋, `design/` 밖의 새 가지                                                                                                                                                       |
|                     | 개발 리드·작업지시서 | SRS·HLD·LLD 쓰기, `main` 커밋·push. 작업지시서 세션은 `feature/` 밖의 가지와 push, 병합                                                                                                                                                       |
|                     | 검수                 | 모든 파일 쓰기, git의 쓰기 명령, 저장소 안으로의 리디렉션·`sed -i`·`--write`·`--fix`, 분리되지 않은 worktree                                                                                                                                  |
|                     | 병합                 | `develop`에는 `qa:approved`가 붙은 `feature/<이슈>`·`design/<epic>`만, `main`에는 배포가 승인된 커밋만(`git merge`와 `gh pr merge` 모두. `gh api`로 병합하거나 자동 병합을 켜는 것은 막음), `release/<버전>`은 승인된 버전만                  |
|                     | 세션 띄우기          | 팀 세션은 PM만, 작업지시서 세션은 개발 리드만                                                                                                                                                                                                 |
| 도구 실행 뒤 (알림) | `gh issue comment`   | 한 식별자가 세 번째 `QA round`에 나오거나 `[design-change]`가 세 번이면 PM으로 넘기라고 알림                                                                                                                                                  |
|                     | `gh issue edit`      | `needs-user`, `escalation` 라벨이면 알림과 데스크톱 알림                                                                                                                                                                                      |
| 멈추기 전           | 모든 팀              | 이번 차례에 커밋·push·병합·이슈/PR 생성을 했는데 `[handoff]` 댓글이 없으면 한 번 붙잡고 남기라고 알림                                                                                                                                         |

- 훅이 내용을 확인하지 못하면(예: git이나 `gh` 호출 실패) 막는다. 막힌 이유가 그 세션에 그대로 전달된다.
- 프로젝트 훅은 이 폴더를 신뢰한다고 한 번 확인해야 동작한다. 처음 띄운 세션의 신뢰 확인 창에서 받아들인다.

## 사람만 하는 승인

세 가지는 훅이 승인 기록(`.claude/agent-approvals.json`, 커밋하지 않음)이 있을 때만 열어 준다. 기록은 사람이 터미널에서 직접 남긴다. 팀은 이 스크립트를 실행할 수 없다.

```bash
node tools/agent-team/approve.mjs main-merge
```

| 명령                                            | 열어 주는 것                                               |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `approve.mjs main-merge [ref]`                  | 배포가 그 커밋(기본 `develop`의 지금 커밋)을 `main`에 병합 |
| `approve.mjs release <버전>`                    | 배포가 `release/<버전>`을 만듦                             |
| `approve.mjs engine <경로/> --issue <N>`        | 그 문서 엔진 경로의 수정·커밋                              |
| `approve.mjs list`, `approve.mjs revoke <종류>` | 기록 보기, 종류별로 지우기                                 |

## 기록 — 일이 끊기지 않게

세션이 끝나면 대화 내용은 사라진다. 다음에 이어받는 쪽이 읽을 수 있도록 **모든 넘겨주기는 이슈 댓글로 남긴다.** `SendMessage`는 상대를 깨우는 용도이고, 내용의 정본은 이슈와 저장소의 문서다.

```
[handoff] <보내는 세션> → <받는 세션>
상태: <무엇이 끝났고 무엇을 요청하는지>
가지/커밋: <branch> @ <short sha>
문서: <경로 또는 링크>
다음 할 일: <받는 쪽이 할 일>
```

- `SendMessage` 본문에는 이슈 번호와 한 줄 요약만 넣고, 자세한 내용은 이슈를 보게 한다.

## GitHub 이슈와 마일스톤

- 모든 `gh` 명령에 `--repo curtana/openoffice`를 붙인다(훅이 막는다). 이 저장소는 `pblsketch/openoffice`의 포크라서 붙이지 않으면 원본 저장소로 갈 수 있다.
- 저장소의 Issues가 켜져 있어야 한다. 켜는 것은 사람이 한다.
- 라벨:

  | 라벨                                   | 뜻                              |
  | -------------------------------------- | ------------------------------- |
  | `type:epic`                            | SRS 하나에 대응하는 에픽        |
  | `type:lld`                             | LLD 문서 하나                   |
  | `type:work-order`                      | 영문 작업지시서 하나            |
  | `status:design-review`                 | 설계 검수를 기다림              |
  | `status:in-progress`                   | 구현 중                         |
  | `status:qa`                            | 코드 검수를 기다림              |
  | `qa:changes-requested` / `qa:approved` | 마지막 검수 결과                |
  | `design-change`                        | 개발이 설계에 되돌린 문제       |
  | `escalation`                           | 3회 반복으로 PM에게 넘어온 쟁점 |
  | `needs-user`                           | 사용자 판단을 기다림            |

- 마일스톤 이름은 `<epic> <slug> — <단계>`, 마감일은 HLD의 일정을 따른다.
- 작업지시서 이슈의 제목과 본문은 영어로 쓴다. 다른 이슈와 댓글은 한국어로 써도 된다.

## 문서 위치

```
docs/projects/<epic>-<slug>/
├── SRS.md                    ← PM
├── HLD.md                    ← 분석·설계
├── LLD-<module>.md           ← 분석·설계 (모듈마다)
└── dev-report-<이슈>.md      ← 작업지시서 세션
docs/process/templates/       ← 각 문서와 작업지시서의 틀
```

검수 결과는 문서 파일이 아니라 이슈 댓글로 남긴다. 검수는 어느 가지에도 커밋하지 않는다.

## 하지 않는 것

- 저장소 절대 규칙(`CLAUDE.md`)을 이 절차를 이유로 어기지 않는다. 절대 규칙에 닿는 쟁점은 3회를 기다리지 않고 바로 PM을 거쳐 사용자에게 간다.
- GitHub 릴리스 게시, 프리릴리스 해제, 태그, 소개 사이트 게시는 사람이 한다(`.claude/skills/release-ieumoffice/SKILL.md`).
