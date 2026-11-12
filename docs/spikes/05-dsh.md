# 단계 5. dsh와 브라우저 조작

날짜: 2026-11-12
결과: **5a·5b 통과, 5c 조건부로 됨, 훅 있음, 5d는 사람의 로그인 대기**

## 검증

| 항목 | 결과 |
| --- | --- |
| 5a. DeepSeek 키로 headless 실행 | 통과. 새 포드에서 별도 준비 없이 재현됨 |
| 5b. 데스크톱 Chrome으로 페이지 열기·제목 읽기·스크린샷 저장 | 통과. 새 포드에서 재현됨 |
| 5c. 리눅스 데스크톱 조작 플러그인이 XFCE에서 동작 | 조건부로 됨 (아래) |
| 5d. Claude 구독 연결 | **대기**. 플러그인과 주입 경로는 준비됨. 사람이 토큰을 만들어 줘야 한다 |
| dsh 훅 API | 있음 (아래) |
| API 키 Secret이 없어도 Flux의 Kustomization이 Ready | 통과. Secret을 지우고 포드를 다시 띄워도 포드와 6개 Kustomization 모두 정상 |

## 실제로 한 것

### dsh 설치 (이미지 0.3.0)

- 공식 저장소 README의 설치 방법은 `npx @deepseek-ai/dsh web` 하나뿐이다. 버전 고정 설치 방법은 문서에 없어서, npm 패키지 `@deepseek-ai/dsh@0.2.2-rc.1`을 잠금 파일(`images/worker/dsh/package-lock.json`)로 고정하고 `npm ci`로 설치했다.
- `dsh plugin`이 pnpm을 쓰므로 `pnpm@11.28.5`(dsh 저장소가 고정한 버전)를 같은 잠금 파일에 넣었다.
- dsh의 리눅스 도구 샌드박스가 쓰는 `bubblewrap`을 apt로 넣었다.
- 프로파일은 이미지 빌드 때 만들어 둔다. 포드가 뜬 뒤 설치 단계가 없다.

| 프로파일 | 내용 |
| --- | --- |
| `headless` | 한 번에 과제 하나(`dsh headless "<과제>"`) + 브라우저 조작 + Claude Code 서브에이전트 |
| `desk` | `headless` + 데스크톱 조작 |

### 5a. headless

```
dsh headless --approval-policy never "Reply with exactly the single word: pong"
```

- 답 `pong`, 종료 코드 0. 첫 실행 약 24초(프로파일 준비 포함).
- 키는 `scripts/apply-secrets.sh`가 만든 Secret `idea-model-keys`를 포드 환경 변수 `DEEPSEEK_API_KEY`로 참조한다(`optional: true`).
- 셸 도구도 기본 샌드박스(`workspace-write`, bubblewrap)에서 동작했다. Kata 게스트 안에서 비루트로 된다.
- `--json`을 주면 `tool_call`, `tool_result`, `final` 이벤트가 한 줄씩 나온다. 완료 판정은 종료 코드 0과 `final.reason.kind == "completed"` 둘 다 봐야 한다.

### 5b. 브라우저 조작

- 플러그인: 저장소 안의 공식 제공자 `@deepseek-ai/dsh-browser-use` + `@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp`(구글의 `chrome-devtools-mcp@1.9.0`을 고정해서 띄운다).
- 설정: `mode: launch`, `headless: false`, `executablePath: /usr/bin/google-chrome`. Chrome이 데스크톱(`DISPLAY=:1`)에 창으로 뜬다. `--no-sandbox`는 쓰지 않는다.
- 결과: `new_page` → `evaluate_script`(`document.title` = "Example Domain") → `take_screenshot`(PNG 75KB 저장).
- 스크린샷 파일은 `/tmp` 아래에만 저장된다. 작업 디렉터리로 저장하려 하면 MCP 서버가 "workspace roots 밖"이라고 거부해서, 에이전트가 `/tmp`에 저장한 뒤 복사했다.

### 5c. 데스크톱 조작

- 플러그인: 공식 제공자 `@deepseek-ai/dsh-computer-use` + `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native`(`@trycua/cua-driver` 0.28.0 내장).
- **된 것**: 앱·창 목록 읽기, 앱 실행(`launch_app`), 클릭, 글자 입력, 키 입력. 셸 도구 없이 "터미널을 띄워 명령을 치고 Enter"를 시켰고 파일이 실제로 만들어졌다.
- **조건**:
  - Enter 같은 키 입력은 백그라운드 전달이 안 돼서 포그라운드(XTest) 전달로 다시 시도해야 했다.
  - 창 안의 요소가 보이지 않는다(`elements=1`). 접근성 버스(AT-SPI)가 이미지에 없어서 창 제목과 좌표만으로 조작한다.
  - 스크린샷은 이미지 입력이 되는 모델 경로에서만 모델에게 전달된다. 지금 DeepSeek 경로에서는 화면을 보지 못하고 좌표를 추측한다.
- 업스트림 문서는 실제 Xorg를 "아직 검증 안 됨"으로 적고 있고 XFCE는 언급이 없다. Xvnc + XFCE에서 위 범위는 동작했다.

### 훅 API

있다. 도구 호출 전후를 가로채는 Cordis 이벤트가 `packages/core/tools/src/events.ts`에 정의돼 있다.

| 이벤트 | 역할 |
| --- | --- |
| `tools/pre-execute` | 실행 전 허용·거부·취소·질문 |
| `tools/execute` | 실행을 감싼다(시간 제한, 재시도, 계측) |
| `tools/post-execute` | 결과 수락·교체·보강·차단 |
| `tools/result` | 확정된 결과 관찰 |

- 에이전트 단위 이벤트도 있다: `agent/created`, `agent/pre-step`, `agent/turn-stopping`.
- Claude Code의 `hooks.json`을 그대로 돌리는 공식 패키지(`@deepseek-ai/dsh-hooks-claude-code`, 실험적)가 있다.

### 5d. Claude 구독 (준비만 됨)

- 쓸 플러그인: 공식 번들 `@deepseek-ai/dsh-subagent-claude-code`. 공식 Claude Agent SDK로 Claude Code를 구동하고, 로그인 상태를 만들거나 바꾸지 않는다. 도구 이름은 `subagent_claude_code`.
- **쓰지 않는 것**: dsh 기본 번들의 `llm-pi-ai`에 든 Anthropic OAuth 로그인. 소스가 Claude Code의 클라이언트 ID와 `user-agent: claude-cli/…` 헤더를 흉내 낸다(계획이 금지한 방식). headless 프로파일은 이 로그인 경로(저장된 자격 증명)를 기본으로 꺼 둔다. 같은 방식의 커뮤니티 플러그인 2개도 쓰지 않는다.
- 주입 경로: 사람이 `claude setup-token`으로 만든 토큰 → `~/.idea-secrets/env`의 `CLAUDE_CODE_OAUTH_TOKEN` → `apply-secrets.sh` → Secret → 포드 환경 변수 → 프로파일 패치가 서브에이전트의 `env`로 넘긴다(이 제공자는 자격 증명처럼 생긴 환경 변수를 자식 프로세스에서 지우므로 명시적으로 넘겨야 한다).
- 남은 일: 토큰을 받은 뒤 위임 1회 성공 확인, 작업 포드 2개가 같은 토큰을 동시에 쓸 때 충돌 여부 확인.

## 버전

| 구성 | 버전 |
| --- | --- |
| 작업 이미지 | 0.3.0 (2.72GB) |
| dsh | 0.2.2-rc.1 (태그 `dsh-v0.2.2-rc.1`, 커밋 `66491b05`) |
| pnpm | 11.28.5 |
| 브라우저·데스크톱·Claude 서브에이전트 플러그인 | 0.2.2-rc.1 (dsh와 같은 버전) |
| chrome-devtools-mcp | 1.9.0 (제공자가 고정) |
| cua-driver | 0.28.0 (제공자가 고정) |
| claude-agent-sdk | 0.3.263 (제공자가 고정) |

## 메모리 실측

| 대상 | 값 |
| --- | --- |
| 노드 사용 메모리 (작업 포드 1개, dsh 실행 후 유휴) | 약 2.4GB / 16GB, 가용 12.9GB |
| 호스트 가용 메모리 | 15GB |

## 계획과 다르게 한 것

- **브라우저 플러그인 선택.** 계획은 "리눅스+Chrome을 명시한 것부터"였다. 그렇게 명시한 것은 커뮤니티 플러그인(`dsh-ego-browser` 등)뿐이고, 검토되지 않은 제3자 코드이며 `--no-sandbox` 래퍼를 쓰는 것도 있다. 공식 제공자가 리눅스에서 그대로 동작해서 그쪽을 썼다.
- **세션 로그 업로드를 껐다.** dsh는 공식 DeepSeek API를 쓸 때 세션 로그(작업 중인 코드 포함)를 요청과 함께 올리는 것이 기본값이다. 홈 패치에서 `session-log-deepseek`의 `enabled: false`로 껐다. 텔레메트리도 `DSH_TELEMETRY_MODE=DISABLED`로 껐다.

## 막힌 점과 해결

- **npm이 설치 스크립트를 막는다.** Node 26의 npm은 의존 패키지의 install 스크립트를 기본으로 실행하지 않는다(`node-pty`, `koffi` 등 5개). 미리 빌드된 바이너리가 들어 있어서 dsh는 그대로 동작했다.
- **이미지 검사 오탐.** 플러그인 패키지 안의 공개 API 키·예시 토큰이 gitleaks에 잡혔다. 패턴 검사에서 제3자 패키지 트리(`node_modules`, pnpm 저장소)를 빼는 설정(`scripts/gitleaks-image.toml`)을 뒀다. 실제 값 대조와 키 파일 검사는 여전히 파일시스템 전체를 본다.
- **프로파일 패치 파일.** 기본으로 `[]`가 들어 있어서 뒤에 덧붙이면 깨진다. 파일 전체를 쓰도록 했다.

## 설계에 반영할 점

- **dsh는 "개발자 미리보기"이고 호환성이 깨질 수 있다고 명시한다.** 버전을 잠금 파일로 고정한 것은 필수다. `SAFETY.md`는 dsh의 샌드박스만 믿지 말고 일회용 VM에서 돌리라고 한다. 작업을 Kata VM에 넣는 지금 구조와 맞다.
- **컨트롤러가 일을 맡기는 인터페이스는 `dsh headless --json`이면 된다.** 포트를 열지 않고, 과제 하나를 받아 이벤트를 흘리고 종료 코드로 끝난다. 이어 하기는 `--session-id`.
- **승인이 필요한 도구 호출은 headless에서 거부된다**(`--approval-policy never`). 작업 VM 안에서는 권한 모드를 넓히는 것(`DSH_PERMISSION_MODE`)을 단계 6에서 정해야 한다. VM이 격리 경계이므로 넓혀도 되는지 판단이 필요하다.
- **화면을 보는 조작은 이미지 입력 모델이 있어야 쓸모가 있다.** 데스크톱 조작을 실제로 쓰려면 이미지 입력 경로와 AT-SPI를 이미지에 넣는 것을 검토한다.
- **dsh-yawn은 dsh 저장소의 일부가 아니라 제3자 배포판이다.** 쿠버네티스에서는 agent-sandbox CRD로 샌드박스를 만들고, 러너 포드는 권한 상승 허용과 특권 사이드카를 기본으로 쓴다. Kata는 언급이 없다. 단계 6의 비교에서 이 점을 본다.
- dsh 저장소에 SSH 원격 실행 패키지(`dsh-ssh`, `dsh-subprocess-ssh` 등)가 따로 있다. 단계 6의 "직접 짠 SSH 플러그인" 대신 쓸 수 있는지 먼저 확인한다.
- 이미지가 2.72GB로 커졌다(dsh와 플러그인이 약 1.1GB). 첫 pull 시간이 늘어난다.
