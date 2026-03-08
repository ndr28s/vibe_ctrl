# Vibes — Claude Code Remote Controller

폰에서 여러 컴퓨터의 Claude Code를 실시간 모니터링하고 원격으로 명령을 보낼 수 있는 시스템.

## 구조

```
Phone (PWA) → WebSocket → vibes-server (relay) → WebSocket → vibes-daemon → claude -p
```

- **app/** — 모바일 PWA (컨트롤러)
- **daemon/** — PC에서 실행하는 백그라운드 데몬
- **hooks/** — Claude Code 훅 (상태 전송용)

---

## 데몬 설치 (Windows / Linux / Raspberry Pi)

### 사전 요구사항

- **Node.js 18+** — [nodejs.org](https://nodejs.org)
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`
- **Git** — 레포 클론용

### 1. 레포 클론

```bash
git clone https://github.com/ndr28s/vibe_ctrl.git
cd vibe_ctrl/daemon
npm install
```

### 2. config.json 생성

```bash
cp config.json.example config.json
```

`daemon/config.json` 파일을 열어서 수정:

```json
{
  "serverUrl": "wss://vibes.forthetest.shop/ws",
  "token": "너의_토큰",
  "machineId": "이_컴퓨터_이름",
  "claudePath": "claude",
  "maxConcurrent": 1
}
```

| 필드 | 설명 |
|------|------|
| `serverUrl` | 릴레이 서버 WebSocket 주소 |
| `token` | 같은 토큰을 쓰는 데몬들이 하나의 그룹으로 묶임 |
| `machineId` | 이 컴퓨터를 구분하는 고유 이름 (예: `home-pc`, `work-laptop`, `rpi-4`) |
| `claudePath` | Claude CLI 경로. 보통 `claude` 그대로 두면 됨 |

### 3. Claude Code 훅 설치

데몬이 현재 Claude 작업 상태(thinking, working, tool 사용 등)를 앱에 실시간으로 보내려면 훅이 필요함.

#### 훅 파일 복사

```bash
# Windows
copy hooks\vibes-hook.py %USERPROFILE%\.claude\hooks\vibes-hook.py

# Linux / Raspberry Pi
cp hooks/vibes-hook.py ~/.claude/hooks/vibes-hook.py
```

#### 훅 설정 파일 생성

`~/.vibes/config.json` 파일 생성:

```json
{
  "serverUrl": "wss://vibes.forthetest.shop/ws",
  "token": "너의_토큰",
  "machineId": "이_컴퓨터_이름"
}
```

#### Claude Code settings.json에 훅 등록

`~/.claude/settings.json`에 아래 내용 추가. 이미 hooks 섹션이 있으면 각 이벤트에 vibes-hook 항목만 추가:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "python ~/.claude/hooks/vibes-hook.py", "async": true, "timeout": 10 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "python ~/.claude/hooks/vibes-hook.py", "async": true, "timeout": 10 }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "python ~/.claude/hooks/vibes-hook.py", "async": true, "timeout": 10 }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "python ~/.claude/hooks/vibes-hook.py", "async": true, "timeout": 10 }] }],
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "python ~/.claude/hooks/vibes-hook.py", "async": true, "timeout": 10 }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "python ~/.claude/hooks/vibes-hook.py", "async": true, "timeout": 10 }] }],
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "python ~/.claude/hooks/vibes-hook.py", "async": true, "timeout": 10 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "python ~/.claude/hooks/vibes-hook.py", "async": true, "timeout": 10 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "python ~/.claude/hooks/vibes-hook.py", "async": true, "timeout": 10 }] }]
  }
}
```

### 4. 테스트 실행

```bash
cd daemon
node daemon.js
```

정상 실행 시 출력:
```
[...] vibes-daemon starting
[...]   Server  : wss://vibes.forthetest.shop/ws
[...]   Machine : home-pc
[...]   Claude  : claude
[...] WebSocket connected
[...] Status -> idle
[...] Watching ~/.vibes/status.json for hook updates
```

---

## 재부팅 시 자동 실행 설정

### Windows — 작업 스케줄러

PowerShell을 **관리자 권한**으로 실행:

```powershell
$action = New-ScheduledTaskAction -Execute "node.exe" -Argument "C:\projects\vibe_ctrl\daemon\daemon.js" -WorkingDirectory "C:\projects\vibe_ctrl\daemon"
$trigger = New-ScheduledTaskTrigger -AtLogon
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "VibesDaemon" -Action $action -Trigger $trigger -Settings $settings -Description "Vibes daemon for Claude Code remote control" -RunLevel Highest
```

> **경로 수정**: `C:\projects\vibe_ctrl\daemon`을 실제 클론한 경로로 바꿔야 함.

확인:
```powershell
Get-ScheduledTask -TaskName "VibesDaemon"
```

삭제:
```powershell
Unregister-ScheduledTask -TaskName "VibesDaemon" -Confirm:$false
```

### Linux / Raspberry Pi — systemd

```bash
sudo tee /etc/systemd/system/vibes-daemon.service << 'EOF'
[Unit]
Description=Vibes Daemon - Claude Code Remote Controller
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/vibe_ctrl/daemon
ExecStart=/usr/bin/node /home/pi/vibe_ctrl/daemon/daemon.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
```

> **수정 필요**:
> - `User=pi` → 실제 사용자 이름
> - `/home/pi/vibe_ctrl/daemon` → 실제 클론 경로
> - Node.js 경로 확인: `which node`

활성화 및 시작:
```bash
sudo systemctl daemon-reload
sudo systemctl enable vibes-daemon
sudo systemctl start vibes-daemon
```

상태 확인:
```bash
sudo systemctl status vibes-daemon
journalctl -u vibes-daemon -f
```

---

## PWA 사용법

1. 폰 브라우저에서 `https://vibes.forthetest.shop` 접속
2. "+" 버튼 눌러서 토큰 추가
3. 같은 토큰의 머신들이 가로로 표시됨
4. 다른 토큰 추가하면 아래 줄에 새 그룹이 추가됨
5. 머신 카드 탭 → 타겟 선택 → 프롬프트 입력 → 전송

---

## config.json.example

```json
{
  "serverUrl": "wss://vibes.forthetest.shop/ws",
  "token": "your_token_here",
  "machineId": "your-machine-name",
  "claudePath": "claude",
  "maxConcurrent": 1
}
```
