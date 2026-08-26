# TikTok GMV Vercel 배포

이 폴더는 기존 Portable 화면 디자인을 유지하면서 Vercel에서 빌드할 수 있도록 복원한 웹 소스입니다.

## 1. GitHub 업로드

이 폴더 안의 파일들을 GitHub 저장소 최상위에 업로드합니다. 폴더 자체를 한 단계 더 감싸지 마세요.

GitHub 최상위에서 아래 파일이 바로 보여야 합니다.

```text
app/
lib/
public/
package.json
package-lock.json
next.config.mjs
tsconfig.json
```

`.next`와 `node_modules`는 GitHub에 올리지 않습니다.

## 2. 관리자 PC Worker 고정 주소 만들기

도메인 구매 없이 ngrok 계정에 자동 배정되는 고정 `ngrok-free.app` 주소를 사용합니다.

1. https://dashboard.ngrok.com/signup 에서 계정을 만듭니다.
2. Windows용 `ngrok.exe`를 내려받습니다.
3. ngrok Dashboard의 Authtoken 명령을 PowerShell에서 한 번 실행합니다.
4. 기존 `START_TIKTOK_AUTOMATION.bat`을 실행합니다.
5. Worker가 `http://127.0.0.1:8000`에서 실행되는 것을 확인합니다.
6. ngrok Dashboard에 표시된 본인 고정 주소를 사용해 아래 명령을 실행합니다.

```powershell
.\ngrok.exe http 8000 --url https://본인주소.ngrok-free.app
```

ngrok 창과 기존 Worker 창은 닫지 않습니다.

## 3. Vercel 설정

```text
Application Preset: Next.js
Root Directory: ./
Build Command: npm run build
Output Directory: Next.js default
Install Command: npm install
```

Environment Variables에 다음을 추가합니다.

```text
Key: WORKER_BASE_URL
Value: https://본인주소.ngrok-free.app
Environments: Production and Preview
```

`Value` 마지막에는 `/`를 붙이지 않습니다.

## 4. 실행 순서

관리자 PC에서 아래 순서로 실행합니다.

1. `START_TIKTOK_AUTOMATION.bat`
2. ngrok 명령
3. Vercel 고정 주소 접속

팀원은 Vercel 주소만 사용합니다. 관리자 PC가 꺼지거나 Worker/ngrok 창이 닫히면 자동화 기능은 중단됩니다.

## 포함된 연결 수정

- 기존 GMV API는 Vercel 서버를 통해 Worker로 전달됩니다.
- 초대장 화면의 `127.0.0.1:8000` 직접 호출을 같은 Vercel 주소의 `/api/worker` 프록시로 변경했습니다.
- ngrok 무료 안내 페이지가 API 응답에 섞이지 않도록 서버 요청 헤더를 추가했습니다.
- 기존 Portable의 `app-shell.css`, `app-shell.js`, 초대장 화면 및 템플릿을 유지했습니다.
